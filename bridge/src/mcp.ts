/**
 * The agent-facing face: MCP tools served over streamable HTTP at /mcp.
 * A workspace's .mcp.json points the agent here.
 *
 * Correlation is by working directory — every tool takes an optional
 * `workspace` (the agent's cwd), resolved to a t3 thread via the shell
 * snapshot; runs created by that agent carry the thread id so solve
 * completions can wake the thread up.
 *
 * Tool results are compact summaries + URLs, never file dumps. Artifact URLs
 * open in any browser (and t3code's preview pane).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, t3Configured } from "./config.ts";
import * as store from "./store.ts";
import * as queue from "./queue.ts";
import * as actions from "./actions.ts";
import * as t3 from "./t3.ts";
import { generatorsCache, compactGenerators } from "./generators.ts";
import { resolveWorkspace, shellSnapshot } from "./threads.ts";

const workspaceArg = z
  .string()
  .optional()
  .describe(
    "Absolute path of your current working directory (project / worktree). Pass it so runs are linked to your thread and solve completions wake you up.",
  );

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const absoluteUrl = (u: string) => (u.startsWith("/") ? `${config.publicUrl}${u}` : u);

const artifactUrls = (run: store.Run) =>
  run.artifacts.map((a) => ({ name: a.name, kind: a.kind, url: absoluteUrl(a.url) }));

/** First preview-ish artifact URL, if any. */
const previewUrl = (run: store.Run) => {
  const a =
    run.artifacts.find((x) => x.kind === "preview") ?? run.artifacts.find((x) => x.kind === "plot");
  return a ? absoluteUrl(a.url) : null;
};

/**
 * Keep tool results compact: scalar fields and short scalar arrays from the
 * python summary; anything bulky is elided (the full JSON stays on the run
 * and in the run dir).
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
  // Only live t3 threads are wakeable; pseudo ids stay off the run record.
  return { workspace, threadId: resolved?.live ? resolved.threadId : undefined };
}

const runReport = (run: store.Run) => ({
  runId: run.id,
  kind: run.kind,
  name: run.name,
  status: run.status,
  ...(run.progress ? { progress: run.progress } : {}),
  ...(run.error ? { error: run.error } : {}),
  ...(run.summary !== undefined ? { summary: compactSummary(run.summary) } : {}),
  artifacts: artifactUrls(run),
  ui: `${config.publicUrl}/`,
});

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "boundary-lab", version: "0.1.0" });

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
    "generate",
    "Generate a mesh with one of Boundary Lab's generators (see list_generators for ids and the " +
      "params schema — pass params as an object matching that schema). Generation is fast: this " +
      "waits up to 120 s and returns a compact result (triangles, bbox, driven tag, quality " +
      "warnings) plus artifact URLs viewable in a browser. If it is still running after 120 s you " +
      "get the run id — poll get_run, do not wait busily.",
    {
      generator: z.string().describe("Generator id from list_generators."),
      params: z
        .record(z.unknown())
        .optional()
        .describe("Generator parameters, matching the generator's JSON Schema from list_generators."),
      name: z.string().optional().describe("Human-readable run name."),
      workspace: workspaceArg,
    },
    async ({ generator, params, name, workspace }) => {
      const ctx = await resolveThreadId(workspace);
      let run: store.Run;
      try {
        run = actions.startGenerate({ generator, params, name, ...ctx });
      } catch (err) {
        return text(`generate failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const finished = await store.waitForTerminal(run.id, 120_000);
      if (!finished) return text(`run ${run.id} disappeared (deleted?)`);
      if (!store.TERMINAL.has(finished.status)) {
        return text({
          runId: finished.id,
          status: finished.status,
          note: "still running after 120 s — use get_run to poll; do not wait busily",
        });
      }
      if (finished.status !== "done") {
        return text({
          runId: finished.id,
          status: finished.status,
          error: finished.error ?? "unknown failure",
          artifacts: artifactUrls(finished),
        });
      }
      const s = (finished.summary ?? {}) as Record<string, unknown>;
      return text({
        runId: finished.id,
        status: finished.status,
        triangles: s.triangles ?? s.n_triangles ?? null,
        bboxMm: s.bbox_mm ?? s.bbox ?? null,
        drivenTag: s.driven_tag ?? null,
        qualityWarning: s.quality_warning ?? s.mesh_quality_warning ?? null,
        preview: previewUrl(finished),
        artifacts: artifactUrls(finished),
        ui: `${config.publicUrl}/`,
        next: `solve {"mesh_run_id":"${finished.id}"} runs the BEM solve on this mesh`,
      });
    },
  );

  server.tool(
    "solve",
    "Queue a BEM solve on a completed mesh run. Solves are LONG (minutes to hours) and run one at " +
      "a time on the GPU. This returns IMMEDIATELY with the run id and queue position — do NOT " +
      "wait or poll in a tight loop. If you passed `workspace` and your thread is known to t3, the " +
      "bridge will wake your thread with the result when the solve finishes; otherwise check back " +
      "later with get_run. Results include artifact URLs viewable in a browser.",
    {
      mesh_run_id: z.string().describe("Run id of a completed mesh run (kind 'mesh', status 'done')."),
      fmin: z.number().optional().describe("Lowest frequency in Hz."),
      fmax: z.number().optional().describe("Highest frequency in Hz."),
      count: z.number().int().optional().describe("Number of frequency points."),
      backend: z.string().optional().describe("Solver backend, e.g. 'julia_local'."),
      symmetry: z.string().optional().describe("Symmetry plane spec passed to the solver."),
      name: z.string().optional().describe("Human-readable run name."),
      workspace: workspaceArg,
    },
    async ({ mesh_run_id, fmin, fmax, count, backend, symmetry, name, workspace }) => {
      const ctx = await resolveThreadId(workspace);
      let run: store.Run;
      try {
        run = actions.startSolve({
          meshRunId: mesh_run_id,
          name,
          options: { fmin, fmax, count, backend, symmetry },
          ...ctx,
        });
      } catch (err) {
        return text(`solve failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return text({
        runId: run.id,
        status: run.status,
        queuePosition: queue.queuePosition(run.id),
        note:
          "Solve queued. Do not wait busily — " +
          (ctx.threadId
            ? "your thread will be woken with the result when it finishes; you can stop and work on other things."
            : "poll get_run occasionally (it can take minutes to hours)."),
        ui: `${config.publicUrl}/`,
      });
    },
  );

  server.tool(
    "get_run",
    "Get one run's status, progress, error, compact result metrics, and artifact URLs (viewable " +
      "in a browser). Use this to poll long-running jobs — sparingly, not in a tight loop.",
    { run_id: z.string(), workspace: workspaceArg },
    async ({ run_id }) => {
      const run = store.getRun(run_id);
      if (!run) return text(`unknown run ${run_id} — call list_runs for valid ids`);
      return text({ ...runReport(run), queuePosition: queue.queuePosition(run.id) || undefined });
    },
  );

  server.tool(
    "list_runs",
    "List Boundary Lab runs, newest first: id, kind (mesh/solve), name, status, timestamps. " +
      "Use get_run for details and artifact URLs.",
    {
      limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 20)."),
      workspace: workspaceArg,
    },
    async ({ limit }) => {
      const rows = store.listRuns().slice(0, limit ?? 20).map((r) => ({
        runId: r.id,
        kind: r.kind,
        name: r.name,
        status: r.status,
        createdAt: r.createdAt,
        ...(r.generator ? { generator: r.generator } : {}),
        ...(r.parentRunId ? { meshRunId: r.parentRunId } : {}),
        ...(r.error ? { error: r.error.slice(0, 120) } : {}),
      }));
      return text({ runs: rows, ui: `${config.publicUrl}/` });
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
            "Everything else (generate, solve, get_run) still works.",
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
        return text(`spawn_thread failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  return server;
}
