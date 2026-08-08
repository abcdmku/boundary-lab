/**
 * The agent-facing face: MCP tools served over streamable HTTP at /mcp.
 * A workspace's .mcp.json points the agent here.
 *
 * Correlation is by working directory — every tool takes an optional
 * `workspace` (the agent's cwd), resolved to a t3 thread via the shell
 * snapshot; jobs created by that agent carry the thread id so solve
 * completions can wake the thread up.
 *
 * Tool results are compact summaries + URLs, never file dumps. Artifact URLs
 * open in any browser (and t3code's preview pane).
 *
 * Vocabulary:
 *   JOB      one unit of work — a mesh generation, or a BEM solve.
 *   PROJECT  the design being explored. Holds a family of meshes and every
 *            solve computed from them.
 *   VARIANT  a mesh derived from another mesh: same design, different params.
 *            An optimization campaign's trials are variants.
 *   DRAFT    a job that is fully configured but has not been started.
 *   TARGET   a machine a solve can run on (this box, or a remote server).
 *   SLOT     one concurrent job on a target. One slot per GPU by default.
 *
 * The shapes that matter: ONE MESH HAS MANY SOLVES (a coarse preview and a
 * fine verification of the same geometry are two solves, not two meshes), and
 * one project has many mesh variants. Tools reflect that — create_mesh_variant
 * for geometry, create_solve_jobs for answers about it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, t3Configured } from "./config.ts";
import * as store from "./store.ts";
import * as queue from "./queue.ts";
import * as actions from "./actions.ts";
import * as t3 from "./t3.ts";
import { listTargets, targetLabel } from "./targets.ts";
import { generatorsCache, compactGenerators } from "./generators.ts";
import { resolveWorkspace, shellSnapshot } from "./threads.ts";
import * as vastRegistry from "./vast/registry.ts";

const workspaceArg = z
  .string()
  .optional()
  .describe(
    "Absolute path of your current working directory (project / worktree). Pass it so jobs are linked to your thread and solve completions wake you up.",
  );

const targetShape = z.object({
  type: z.enum(["local", "remote"]).optional(),
  instanceId: z.string().optional().describe("Registry id of a remote compute instance."),
  serverUrl: z.string().optional().describe("Base URL of a remote solver server."),
  label: z.string().optional(),
});

const targetValue = z.union([z.string(), targetShape]);

const targetArg = targetValue
  .optional()
  .describe(
    "Where the solve runs. Either a target id from list_targets ('local', a remote instance id, " +
      "or an http(s) URL), or an object {type:'remote', instanceId?, serverUrl}. Default: local.",
  );

const solveOptionArgs = {
  fmin: z.number().optional().describe("Lowest frequency in Hz."),
  fmax: z.number().optional().describe("Highest frequency in Hz."),
  count: z.number().int().optional().describe("Number of frequency points."),
  backend: z.string().optional().describe("Solver backend, e.g. 'beat_cuda'. Ignored for remote targets."),
  symmetry: z.string().optional().describe("Symmetry plane spec passed to the solver ('off' | 'x' | 'xy')."),
};

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const errText = (label: string, err: unknown) =>
  text(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);

const absoluteUrl = (u: string) => (u.startsWith("/") ? `${config.publicUrl}${u}` : u);

const artifactUrls = (job: store.Job) =>
  job.artifacts.map((a) => ({ name: a.name, kind: a.kind, url: absoluteUrl(a.url) }));

/** First preview-ish artifact URL, if any. */
const previewUrl = (job: store.Job) => {
  const a =
    job.artifacts.find((x) => x.kind === "preview") ?? job.artifacts.find((x) => x.kind === "plot");
  return a ? absoluteUrl(a.url) : null;
};

/**
 * Keep tool results compact: scalar fields and short scalar arrays from the
 * python summary; anything bulky is elided (the full JSON stays on the job
 * and in the job dir).
 */
function compactSummary(summary: unknown): Record<string, unknown> | unknown {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) return summary;
  const out: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(summary)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      out[key] = typeof value === "string" && value.length > 300 ? value.slice(0, 300) + "…" : value;
    } else if (
      Array.isArray(value) &&
      value.length <= 12 &&
      value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))
    ) {
      out[key] = value;
    } else {
      omitted.push(key);
    }
  }
  if (omitted.length > 0) out._omitted = omitted;
  return out;
}

async function resolveThreadId(workspace: string | undefined) {
  if (!workspace) return { workspace: undefined, threadId: undefined };
  const resolved = await resolveWorkspace(workspace).catch(() => null);
  // Only live t3 threads are wakeable; pseudo ids stay off the job record.
  return { workspace, threadId: resolved?.live ? resolved.threadId : undefined };
}

/** Project name (not just its id) — an id alone tells an agent nothing. */
const projectRef = (job: store.Job) =>
  job.projectId
    ? { project: { id: job.projectId, name: store.getProject(job.projectId)?.name ?? job.projectId } }
    : {};

const jobReport = (job: store.Job) => ({
  jobId: job.id,
  kind: job.kind,
  name: job.name,
  status: job.status,
  target: targetLabel(job.target),
  ...projectRef(job),
  ...(job.variantOf ? { variantOf: job.variantOf } : {}),
  ...(job.kind === "mesh"
    ? {
        solves: store.listSolvesOfMesh(job.id).map((s) => ({ jobId: s.id, name: s.name, status: s.status })),
        variants: store.listVariantsOfMesh(job.id).map((v) => ({ jobId: v.id, name: v.name, status: v.status })),
      }
    : {}),
  ...(job.batchId ? { batchId: job.batchId } : {}),
  ...(job.parentJobId ? { meshJobId: job.parentJobId } : {}),
  ...(job.progress ? { progress: job.progress } : {}),
  ...(job.error ? { error: job.error } : {}),
  ...(job.summary !== undefined ? { summary: compactSummary(job.summary) } : {}),
  artifacts: artifactUrls(job),
  ui: `${config.publicUrl}/`,
});

/** One line per job in a batch/launch result — enough to poll, not a dump. */
const jobBrief = (job: store.Job) => ({
  jobId: job.id,
  name: job.name,
  status: job.status,
  target: targetLabel(job.target),
  ...projectRef(job),
  ...(job.kind === "solve"
    ? {
        meshJobId: job.params.meshJobId ?? null,
        settings: Object.fromEntries(
          actions.SOLVE_OPTION_KEYS.filter((k) => job.params[k] !== undefined).map((k) => [
            k,
            job.params[k],
          ]),
        ),
      }
    : { generator: job.generator ?? null }),
});

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "boundary-lab", version: "0.2.0" });

  server.tool(
    "list_generators",
    "List Boundary Lab's mesh generators: id, title, one-line description, parameter names with " +
      "defaults, and the full JSON Schema for each generator's params. Call this before generate. " +
      "If the list is empty, the error field explains why (e.g. python layer not built).",
    { workspace: workspaceArg },
    async () => {
      const cache = generatorsCache();
      return text({
        generators: compactGenerators(),
        ...(cache.error ? { error: cache.error } : {}),
        ui: `${config.publicUrl}/`,
      });
    },
  );

  server.tool(
    "list_targets",
    "List the machines a solve can run on: the local GPU (one solve at a time — the GPU rule) " +
      "plus any rented vast.ai instances this bridge manages. Pass a target's `id` as the " +
      "`target` argument of solve / create_solve_jobs / update_job. Only targets with " +
      "available=true can take work; the rest carry unavailableReason saying why not (not " +
      "provisioned, unhealthy, stopped). Also returns the queue lanes, so you can see what each " +
      "target is already busy with. This tool is READ-ONLY and free; renting a GPU costs money, " +
      "is never automatic, and is done through the dashboard or the /api/vast HTTP API with an " +
      "explicit confirmation.",
    { workspace: workspaceArg },
    async () =>
      text({
        targets: listTargets(),
        lanes: queue.queueSnapshot().lanes,
        // Surfaced so an agent can see, and report, that money is being spent.
        activeBurnRatePerHour: Number(vastRegistry.activeBurnRatePerHour().toFixed(4)),
        ui: `${config.publicUrl}/`,
      }),
  );

  server.tool(
    "generate",
    "Generate a mesh with one of Boundary Lab's generators (see list_generators for ids and the " +
      "params schema — pass params as an object matching that schema). Generation is fast: this " +
      "waits up to 120 s and returns a compact result (triangles, bbox, driven tag, quality " +
      "warnings, estimated solve VRAM per symmetry option) plus artifact URLs viewable in a " +
      "browser. Mesh size is never refused here. If it is still running after 120 s you " +
      "get the job id — poll get_job, do not wait busily. To configure meshes WITHOUT running " +
      "them, use create_mesh_jobs with draft: true.",
    {
      generator: z.string().describe("Generator id from list_generators."),
      params: z
        .record(z.unknown())
        .optional()
        .describe("Generator parameters, matching the generator's JSON Schema from list_generators."),
      name: z.string().optional().describe("Human-readable job name."),
      project: z
        .string()
        .optional()
        .describe(
          "Project id or name to file this mesh under. A name that does not exist yet is created. " +
            "Use one project per design you are exploring so its variants and solves stay together.",
        ),
      variant_of: z
        .string()
        .optional()
        .describe(
          "Mesh job id this is a variant of. Prefer create_mesh_variant, which patches the " +
            "parent's params for you.",
        ),
      workspace: workspaceArg,
    },
    async ({ generator, params, name, project, variant_of, workspace }) => {
      const ctx = await resolveThreadId(workspace);
      let job: store.Job;
      try {
        job = actions.startGenerate({
          generator,
          params,
          name,
          ...(project ? { project } : {}),
          ...(variant_of ? { variantOf: variant_of } : {}),
          ...ctx,
        });
      } catch (err) {
        return errText("generate", err);
      }
      const finished = await store.waitForTerminal(job.id, 120_000);
      if (!finished) return text(`job ${job.id} disappeared (deleted?)`);
      if (!store.TERMINAL.has(finished.status)) {
        return text({
          jobId: finished.id,
          status: finished.status,
          note: "still running after 120 s — use get_job to poll; do not wait busily",
        });
      }
      if (finished.status !== "done") {
        return text({
          jobId: finished.id,
          status: finished.status,
          error: finished.error ?? "unknown failure",
          artifacts: artifactUrls(finished),
        });
      }
      const s = (finished.summary ?? {}) as Record<string, unknown>;
      return text({
        jobId: finished.id,
        status: finished.status,
        triangles: s.triangles ?? s.n_triangles ?? null,
        bboxMm: s.bbox_mm ?? s.bbox ?? null,
        // Closed-form prediction of bboxMm (generators that expose one). Callers can
        // get this WITHOUT meshing via `blabctl.py estimate`, so a size limit can be
        // checked before a trial is spent — mouth params are the air aperture, the
        // outer envelope is larger.
        estimatedBboxMm: s.estimated_bbox_mm ?? null,
        drivenTag: s.driven_tag ?? null,
        qualityWarning: s.quality_warning ?? s.mesh_quality_warning ?? null,
        // Informational: estimated peak GPU memory per symmetry option. Large
        // meshes are never refused here — solve warns if the local GPU is too
        // small for the one you pick.
        vramEstimate:
          s.vram !== null && typeof s.vram === "object"
            ? ((s.vram as Record<string, unknown>).estimate_human ?? null)
            : null,
        preview: previewUrl(finished),
        artifacts: artifactUrls(finished),
        ...projectRef(finished),
        ui: `${config.publicUrl}/`,
        next:
          `solve {"mesh_job_id":"${finished.id}"} runs one BEM solve on this mesh; ` +
          `create_solve_jobs runs several on it (coarse + fine is the normal case); ` +
          `create_mesh_variant {"mesh_job_id":"${finished.id}"} derives the next geometry`,
      });
    },
  );

  server.tool(
    "solve",
    "Queue ONE BEM solve on a completed mesh job. Solves are LONG (minutes to hours). The local " +
      "machine runs one solve at a time on its GPU; remote targets run in parallel with it and " +
      "with each other (see list_targets). This returns IMMEDIATELY with the job id and queue " +
      "position — do NOT wait or poll in a tight loop. If you passed `workspace` and your thread " +
      "is known to t3, the bridge will wake your thread with the result when the solve finishes; " +
      "otherwise check back later with get_job. A `vram` field reports the estimated peak GPU " +
      "memory for LOCAL solves and warns (never blocks) if it exceeds the local GPU's VRAM. " +
      "For several solves on one mesh, use create_solve_jobs instead of calling this in a loop.",
    {
      mesh_job_id: z.string().describe("Job id of a completed mesh job (kind 'mesh', status 'done')."),
      ...solveOptionArgs,
      target: targetArg,
      name: z.string().optional().describe("Human-readable job name."),
      batch_id: z.string().optional().describe("Attach this solve to an existing batch."),
      workspace: workspaceArg,
    },
    async ({ mesh_job_id, fmin, fmax, count, backend, symmetry, target, name, batch_id, workspace }) => {
      const ctx = await resolveThreadId(workspace);
      const options = { fmin, fmax, count, backend, symmetry };
      let job: store.Job;
      try {
        job = actions.startSolve({
          meshJobId: mesh_job_id,
          name,
          options,
          target,
          ...(batch_id ? { batchId: batch_id } : {}),
          ...ctx,
        });
      } catch (err) {
        return errText("solve", err);
      }
      const vramNote = actions.solveVramNote(mesh_job_id, options, job.target);
      return text({
        jobId: job.id,
        status: job.status,
        target: targetLabel(job.target),
        lane: queue.laneOf(job.id),
        queuePosition: queue.queuePosition(job.id),
        ...(vramNote ? { vram: vramNote } : {}),
        note:
          "Solve queued. Do not wait busily — " +
          (ctx.threadId
            ? "your thread will be woken with the result when it finishes; you can stop and work on other things."
            : "poll get_job occasionally (it can take minutes to hours)."),
        ui: `${config.publicUrl}/`,
      });
    },
  );

  server.tool(
    "create_solve_jobs",
    "Create MANY solve jobs at once: the cross product of `mesh_job_ids` × `variants`. Each " +
      "variant overrides the shared settings (and may pin its own target), so 'these 3 meshes at " +
      "these 4 settings' is one call producing 12 jobs sharing one batchId. With `launch: false` " +
      "(the default) they are DRAFTS — configured but not started, editable with update_job and " +
      "startable later with launch_jobs. With `launch: true` they all go straight into their " +
      "target lanes. Local solves still run strictly one at a time; remote targets run in " +
      "parallel. Use cancel_jobs {batch_id} to stop the whole sweep.",
    {
      mesh_job_ids: z
        .array(z.string())
        .min(1)
        .describe("Mesh job ids to solve. One entry solves one mesh at every variant."),
      variants: z
        .array(
          z.object({
            name: z.string().optional().describe("Label for this variant (used in the job name)."),
            target: targetValue.optional(),
            ...solveOptionArgs,
          }),
        )
        .optional()
        .describe(
          "One job per entry per mesh. Each entry overrides the shared fmin/fmax/count/backend/" +
            "symmetry/target. Omit for a single job per mesh with the shared settings.",
        ),
      ...solveOptionArgs,
      target: targetArg,
      name: z.string().optional().describe("Batch label; each job's name is derived from it."),
      batch_id: z.string().optional().describe("Reuse an existing batch id instead of a new one."),
      project: z
        .string()
        .optional()
        .describe("Project id or name. Defaults to whatever project each mesh already belongs to."),
      launch: z
        .boolean()
        .optional()
        .describe("true = queue them now. false/omitted = leave them as editable drafts."),
      workspace: workspaceArg,
    },
    async ({ mesh_job_ids, variants, fmin, fmax, count, backend, symmetry, target, name, batch_id, project, launch, workspace }) => {
      const ctx = await resolveThreadId(workspace);
      try {
        const result = actions.createBatch({
          kind: "solve",
          meshJobIds: mesh_job_ids,
          variants: variants as actions.BatchVariant[] | undefined,
          options: { fmin, fmax, count, backend, symmetry },
          target,
          ...(name ? { name } : {}),
          ...(batch_id ? { batchId: batch_id } : {}),
          ...(project ? { project } : {}),
          launch: launch === true,
          ...ctx,
        });
        return text({
          batchId: result.batchId,
          created: result.created,
          launched: result.launched,
          skipped: result.skipped,
          jobs: result.jobs.map(jobBrief),
          note: launch
            ? "Queued. Poll get_job per job, or list_jobs {batch_id}. Do not wait busily."
            : `Drafts created. Launch them with launch_jobs {"batch_id":"${result.batchId}"} when ready.`,
          ui: `${config.publicUrl}/`,
        });
      } catch (err) {
        return errText("create_solve_jobs", err);
      }
    },
  );

  server.tool(
    "create_mesh_jobs",
    "Create one or more mesh-generation jobs from a generator and a list of parameter variants. " +
      "With `launch: false` (the default) they are DRAFTS — configured but not started — so a UI " +
      "or an agent can stage a set of candidate geometries and launch them later. With " +
      "`launch: true` they are queued immediately (meshing always runs on the local machine, one " +
      "at a time). For a single mesh you want to run and see right now, use `generate` instead.",
    {
      generator: z.string().describe("Generator id from list_generators."),
      params: z.record(z.unknown()).optional().describe("Shared base params for every variant."),
      variants: z
        .array(
          z.object({
            name: z.string().optional(),
            params: z.record(z.unknown()).optional().describe("Params merged over the shared base."),
          }),
        )
        .optional()
        .describe("One job per entry. Omit for a single job with the shared params."),
      name: z.string().optional().describe("Batch label; each job's name is derived from it."),
      batch_id: z.string().optional(),
      project: z
        .string()
        .optional()
        .describe(
          "Project id or name for the whole family. Defaults to a project named after the batch — " +
            "a mesh sweep IS a family of variants, and it is filed as one.",
        ),
      launch: z.boolean().optional(),
      workspace: workspaceArg,
    },
    async ({ generator, params, variants, name, batch_id, project, launch, workspace }) => {
      const ctx = await resolveThreadId(workspace);
      try {
        const result = actions.createBatch({
          kind: "mesh",
          generator,
          params,
          variants: variants as actions.BatchVariant[] | undefined,
          ...(name ? { name } : {}),
          ...(batch_id ? { batchId: batch_id } : {}),
          ...(project ? { project } : {}),
          launch: launch === true,
          ...ctx,
        });
        return text({
          batchId: result.batchId,
          created: result.created,
          launched: result.launched,
          skipped: result.skipped,
          jobs: result.jobs.map(jobBrief),
          note: launch
            ? "Queued on the local mesh lane."
            : `Drafts created. Launch them with launch_jobs {"batch_id":"${result.batchId}"} when ready.`,
          ui: `${config.publicUrl}/`,
        });
      } catch (err) {
        return errText("create_mesh_jobs", err);
      }
    },
  );

  server.tool(
    "list_projects",
    "List the designs this bridge holds. A PROJECT groups a family of mesh variants and every " +
      "solve computed from them — it is the unit to reason in when comparing geometries. Each " +
      "row carries its mesh count, how many of those meshes are variants of another, its solve " +
      "count and the best score seen so far. Pass a project's name (or id) as `project` to " +
      "generate / create_mesh_jobs / create_solve_jobs / create_mesh_variant; a name that does " +
      "not exist yet is created, so an optimization campaign never has to bootstrap one.",
    { workspace: workspaceArg },
    async () =>
      text({
        projects: store.listProjects().map((p) => {
          const jobs = store.listProjectJobs(p.id);
          const meshes = jobs.filter((j) => j.kind === "mesh");
          const solves = jobs.filter((j) => j.kind === "solve");
          const scores = solves
            .map((s) => (s.summary as Record<string, unknown> | undefined)?.score)
            .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
          return {
            projectId: p.id,
            name: p.name,
            ...(p.goal ? { goal: p.goal } : {}),
            meshes: meshes.length,
            variants: meshes.filter((m) => m.variantOf).length,
            solves: solves.length,
            solvesDone: solves.filter((s) => s.status === "done").length,
            ...(scores.length ? { bestScore: Math.max(...scores) } : {}),
          };
        }),
        unassignedMeshes: store
          .listJobs()
          .filter((j) => j.kind === "mesh" && !j.projectId).length,
        ui: `${config.publicUrl}/`,
      }),
  );

  server.tool(
    "create_mesh_variant",
    "Derive a NEW mesh from an existing one: same generator, its params with your overrides " +
      "applied, and a recorded link back to the parent. This is how an optimization campaign " +
      "should produce each trial — the variants then read as one lineage in the dashboard " +
      "instead of N unrelated meshes, and they inherit the parent's project automatically. " +
      "`params` is a PATCH, so pass only what changes. Draft by default; `launch: true` queues it " +
      "on the local mesh lane.",
    {
      mesh_job_id: z.string().describe("Mesh job to derive from (any status)."),
      params: z
        .record(z.unknown())
        .optional()
        .describe("Parameter overrides merged over the parent's params. Only what changes."),
      name: z.string().optional().describe("Defaults to the parent's name plus what changed."),
      project: z
        .string()
        .optional()
        .describe("Project id or name. Defaults to the parent mesh's project."),
      launch: z.boolean().optional().describe("true = generate it now."),
      workspace: workspaceArg,
    },
    async ({ mesh_job_id, params, name, project, launch, workspace }) => {
      const ctx = await resolveThreadId(workspace);
      try {
        const job = actions.createMeshVariant({
          meshJobId: mesh_job_id,
          params,
          ...(name ? { name } : {}),
          ...(project ? { project } : {}),
          launch: launch === true,
          ...ctx,
        });
        return text({
          ...jobBrief(job),
          params: job.params,
          variantOf: mesh_job_id,
          note: launch
            ? "Queued on the local mesh lane — poll get_job."
            : `Draft created. launch_jobs {"job_ids":["${job.id}"]} when ready.`,
        });
      } catch (err) {
        return errText("create_mesh_variant", err);
      }
    },
  );

  server.tool(
    "schedule_jobs",
    "Decide WHERE and IN WHAT ORDER staged work runs — the programmatic half of the dashboard's " +
      "schedule board. Each move drops one job into a column: a target id from list_targets (runs " +
      "it there, launching it if it was a draft) or 'planned' (holds it back as a draft). " +
      "`position` is its 0-based place in that column's waiting line; omit it to append. Running " +
      "jobs never move — they are already on a machine — and are reported under `skipped` with " +
      "the reason. Nothing is ever destroyed: holding a queued job keeps its configuration.",
    {
      moves: z
        .array(
          z.object({
            job_id: z.string(),
            column: z
              .string()
              .describe("A target id from list_targets, or 'planned' to hold it as a draft."),
            position: z.number().int().min(0).optional(),
          }),
        )
        .min(1),
      workspace: workspaceArg,
    },
    async ({ moves }) => {
      try {
        const result = actions.scheduleJobs(
          moves.map((m) => ({
            jobId: m.job_id,
            column: m.column,
            ...(m.position !== undefined ? { position: m.position } : {}),
          })),
        );
        return text({
          ...result,
          lanes: queue.queueSnapshot().lanes,
          ui: `${config.publicUrl}/`,
        });
      } catch (err) {
        return errText("schedule_jobs", err);
      }
    },
  );

  server.tool(
    "set_target_slots",
    "Set how many solves a target runs at once, and (locally) which GPU each slot gets. Default " +
      "everywhere is 1 — one GPU, one job. Raise it to run one solve per card on a multi-GPU box " +
      "by listing `devices` (e.g. ['0','1'], which also sets the slot count), or to share a card " +
      "between small solves by raising `slots` alone. Sharing a card means sharing its VRAM: a " +
      "mesh that fits when alone can fail alongside another, and the returned `warning` says so. " +
      "Pass slots: 0 to clear the override and return to the default.",
    {
      target_id: z.string().describe("Target id from list_targets, e.g. 'local'."),
      slots: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Concurrent solves. 0 clears the override."),
      devices: z
        .array(z.string())
        .optional()
        .describe("GPU index per slot, e.g. ['0','1']. Local targets only. [] clears the pinning."),
      workspace: workspaceArg,
    },
    async ({ target_id, slots, devices }) => {
      try {
        return text(
          actions.setTargetSlots(target_id, {
            ...(slots !== undefined ? { slots: slots === 0 ? null : slots } : {}),
            ...(devices !== undefined ? { devices: devices.length === 0 ? null : devices } : {}),
          }),
        );
      } catch (err) {
        return errText("set_target_slots", err);
      }
    },
  );

  server.tool(
    "update_job",
    "Edit a DRAFT job's configuration before it is launched: rename it, change generator params " +
      "or solve settings, move it to another execution target, or (re)group it into a batch. " +
      "Only drafts can be edited — a queued, running or finished job is immutable.",
    {
      job_id: z.string(),
      name: z.string().optional(),
      params: z.record(z.unknown()).optional().describe("Mesh jobs: replacement generator params."),
      mesh_job_id: z.string().optional().describe("Solve jobs: point at a different mesh."),
      ...solveOptionArgs,
      target: targetArg,
      batch_id: z.string().optional().describe("Move into this batch. Pass an empty string to ungroup."),
      workspace: workspaceArg,
    },
    async ({ job_id, name, params, mesh_job_id, fmin, fmax, count, backend, symmetry, target, batch_id }) => {
      try {
        const job = actions.updateDraft(job_id, {
          ...(name !== undefined ? { name } : {}),
          ...(params !== undefined ? { params } : {}),
          ...(mesh_job_id !== undefined ? { meshJobId: mesh_job_id } : {}),
          ...(fmin !== undefined || fmax !== undefined || count !== undefined || backend !== undefined || symmetry !== undefined
            ? { options: { fmin, fmax, count, backend, symmetry } }
            : {}),
          ...(target !== undefined ? { target } : {}),
          ...(batch_id !== undefined ? { batchId: batch_id === "" ? null : batch_id } : {}),
        });
        return text({ ...jobBrief(job), status: job.status, params: job.params });
      } catch (err) {
        return errText("update_job", err);
      }
    },
  );

  server.tool(
    "launch_jobs",
    "Start draft jobs: pass explicit `job_ids`, a `batch_id`, or both. Each job goes into the " +
      "lane for its own target, so a batch spanning several remote instances starts in parallel " +
      "while local jobs stay serialized. Returns the queue position per job; jobs that were not " +
      "drafts (or whose mesh is not finished) are reported under `skipped` and left alone.",
    {
      job_ids: z.array(z.string()).optional(),
      batch_id: z.string().optional(),
      workspace: workspaceArg,
    },
    async ({ job_ids, batch_id }) => {
      try {
        const result = actions.launchJobs({
          ...(job_ids ? { jobIds: job_ids } : {}),
          ...(batch_id ? { batchId: batch_id } : {}),
        });
        return text({
          ...result,
          note: "Do not wait busily — poll get_job, or let the thread wake-up find you.",
          ui: `${config.publicUrl}/`,
        });
      } catch (err) {
        return errText("launch_jobs", err);
      }
    },
  );

  server.tool(
    "cancel_jobs",
    "Cancel jobs by explicit `job_ids` and/or a whole `batch_id`. Queued jobs are dropped, " +
      "running ones have their process tree killed, drafts are closed as cancelled. Already " +
      "finished jobs are reported under `skipped`.",
    {
      job_ids: z.array(z.string()).optional(),
      batch_id: z.string().optional(),
      workspace: workspaceArg,
    },
    async ({ job_ids, batch_id }) => {
      try {
        return text(
          actions.cancelJobs({
            ...(job_ids ? { jobIds: job_ids } : {}),
            ...(batch_id ? { batchId: batch_id } : {}),
          }),
        );
      } catch (err) {
        return errText("cancel_jobs", err);
      }
    },
  );

  server.tool(
    "delete_job",
    "Delete a job record and its directory (artifacts included). Refuses while it is running, or " +
      "while it is the mesh of a draft/queued/running solve. Mostly useful for discarding drafts.",
    { job_id: z.string(), workspace: workspaceArg },
    async ({ job_id }) => {
      try {
        actions.deleteJob(job_id);
        return text({ ok: true, jobId: job_id });
      } catch (err) {
        return errText("delete_job", err);
      }
    },
  );

  server.tool(
    "get_job",
    "Get one job's status, progress, error, compact result metrics, execution target and artifact " +
      "URLs (viewable in a browser). Use this to poll long-running jobs — sparingly, not in a " +
      "tight loop.",
    { job_id: z.string(), workspace: workspaceArg },
    async ({ job_id }) => {
      const job = store.getJob(job_id);
      if (!job) return text(`unknown job ${job_id} — call list_jobs for valid ids`);
      return text({
        ...jobReport(job),
        lane: queue.laneOf(job.id),
        queuePosition: queue.queuePosition(job.id) || undefined,
      });
    },
  );

  server.tool(
    "list_jobs",
    "List Boundary Lab jobs, newest first: id, kind (mesh/solve), name, status (draft/queued/" +
      "running/done/failed/cancelled), target, batch, timestamps. Filter by kind, status or " +
      "batch_id. Use get_job for details and artifact URLs.",
    {
      kind: z.enum(["mesh", "solve"]).optional(),
      status: z.enum(["draft", "queued", "running", "done", "failed", "cancelled"]).optional(),
      batch_id: z.string().optional(),
      project_id: z.string().optional().describe("Only jobs filed under this project."),
      mesh_job_id: z
        .string()
        .optional()
        .describe("Only the solves of this mesh — the many side of one-mesh-many-solves."),
      limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 20)."),
      workspace: workspaceArg,
    },
    async ({ kind, status, batch_id, project_id, mesh_job_id, limit }) => {
      let jobs = store.listJobs();
      if (kind) jobs = jobs.filter((j) => j.kind === kind);
      if (status) jobs = jobs.filter((j) => j.status === status);
      if (batch_id) jobs = jobs.filter((j) => j.batchId === batch_id);
      if (project_id) jobs = jobs.filter((j) => j.projectId === project_id);
      if (mesh_job_id)
        jobs = jobs.filter(
          (j) => j.parentJobId === mesh_job_id || j.params?.meshJobId === mesh_job_id,
        );
      const rows = jobs.slice(0, limit ?? 20).map((j) => ({
        jobId: j.id,
        kind: j.kind,
        name: j.name,
        status: j.status,
        target: targetLabel(j.target),
        createdAt: j.createdAt,
        ...projectRef(j),
        ...(j.variantOf ? { variantOf: j.variantOf } : {}),
        ...(j.batchId ? { batchId: j.batchId } : {}),
        ...(j.generator ? { generator: j.generator } : {}),
        ...(j.parentJobId ? { meshJobId: j.parentJobId } : {}),
        ...(j.error ? { error: j.error.slice(0, 120) } : {}),
      }));
      return text({ jobs: rows, batches: actions.listBatches(), ui: `${config.publicUrl}/` });
    },
  );

  server.tool(
    "spawn_thread",
    "Spawn a new t3code thread (agent fan-out): creates the thread in your project and seeds it " +
      "with your prompt. Model and project are inherited from your workspace. Requires the bridge " +
      "to be connected to a t3 server.",
    {
      title: z.string().describe("Thread title."),
      prompt: z.string().describe("Seed prompt for the new thread's first turn."),
      workspace: workspaceArg,
    },
    async ({ title, prompt, workspace }) => {
      if (!t3Configured()) {
        return text(
          "t3 is not connected to this bridge (T3_BASE_URL / T3_TOKEN unset) — cannot spawn threads. " +
            "Everything else (generate, solve, get_job) still works.",
        );
      }
      try {
        const shell = await shellSnapshot();
        if (!shell || shell.projects.length === 0)
          return text("the t3 server has no projects yet — cannot spawn a thread");
        const resolved = workspace ? await resolveWorkspace(workspace) : null;
        const project =
          (resolved?.projectId ? shell.projects.find((p) => p.id === resolved.projectId) : null) ??
          shell.projects[0]!;
        const modelSelection =
          resolved?.modelSelection ??
          project.defaultModelSelection ??
          shell.threads
            .filter((t) => t.projectId === project.id && t.archivedAt === null)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.modelSelection;
        if (!modelSelection)
          return text(
            `project "${project.title}" has no default model and no existing threads to inherit one from`,
          );
        const { threadId } = await t3.spawnThread({
          projectId: project.id,
          title,
          prompt,
          modelSelection,
        });
        return text({ ok: true, threadId, projectId: project.id, model: modelSelection.model });
      } catch (err) {
        return errText("spawn_thread", err);
      }
    },
  );

  return server;
}
