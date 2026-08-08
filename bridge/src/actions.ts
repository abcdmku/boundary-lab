/**
 * The one internal API for actions. A UI button and an MCP tool that do the
 * same thing call the same function here — never two code paths.
 *
 * Job lifecycle owned by this module:
 *
 *   createDraft / createBatch  ->  status "draft"   (editable, never enqueued)
 *   updateDraft                ->  still "draft"
 *   launchJobs                 ->  "queued"  ->  queue.enqueue
 *   startGenerate / startSolve ->  create + launch in one step (the old path)
 *   scheduleJobs               ->  move a not-yet-started job's target/order
 *   cancelJobs / deleteJob
 *
 * Structure owned by this module:
 *
 *   projects       — the design a mesh family and its solves belong to
 *   mesh variants  — createMeshVariant(): same design, different params
 *   plans          — createBatch(): N solves over M meshes, staged as drafts
 *                    and then ARRANGED on the schedule board, which is where
 *                    "when, where and in what order" is actually decided
 */
import fs from "node:fs";
import path from "node:path";
import { config, t3Configured } from "./config.ts";
import * as store from "./store.ts";
import * as queue from "./queue.ts";
import * as estimate from "./estimate.ts";
import {
  blabctlSupportsServerUrl,
  getTarget,
  listTargets,
  normalizeTarget,
  setTargetConfig,
  assertTargetSlotsConfigurable,
  targetIdOf,
  targetLabel,
  TargetError,
} from "./targets.ts";
import { generatorsCache, getGenerator } from "./generators.ts";
import * as vastRegistry from "./vast/registry.ts";
import { describeKey as describeVastKey } from "./vast/key.ts";

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface SolveOptions {
  fmin?: number;
  fmax?: number;
  count?: number;
  backend?: string;
  symmetry?: string;
}


export const SOLVE_OPTION_KEYS = ["fmin", "fmax", "count", "backend", "symmetry"] as const;

/** Guard-rail against a runaway sweep (meshes × variants). */
export const MAX_BATCH_JOBS = 200;

// ---------- shared validation ----------

function target(input: unknown): store.JobTarget {
  try {
    return normalizeTarget(input);
  } catch (err) {
    if (err instanceof TargetError) throw new ActionError(err.message, err.status);
    throw err;
  }
}

function requireGenerator(id: string) {
  if (!id) throw new ActionError("generator is required");
  // Only reject unknown ids when we actually have a catalog — with the python
  // layer missing the job itself will fail with a useful log instead.
  if (generatorsCache().generators.length > 0 && !getGenerator(id))
    throw new ActionError(
      `unknown generator "${id}" — known: ${generatorsCache()
        .generators.map((g) => g.id)
        .join(", ")}`,
    );
}

/** The mesh a solve will read must exist, be a mesh, and have completed. */
function requireMesh(meshJobId: string): store.Job {
  const mesh = store.getJob(meshJobId);
  if (!mesh) throw new ActionError(`unknown job ${meshJobId}`, 404);
  if (mesh.kind !== "mesh") throw new ActionError(`job ${meshJobId} is not a mesh job`);
  return mesh;
}

/** Extra check applied only when a solve is actually launched. */
function requireMeshDone(meshJobId: string): store.Job {
  const mesh = requireMesh(meshJobId);
  if (mesh.status !== "done")
    throw new ActionError(`mesh job ${meshJobId} is ${mesh.status}, not done`);
  return mesh;
}

/**
 * Remote execution needs blabctl to understand `--server-url`. Checked at
 * LAUNCH, not at draft creation: staging remote work against a bridge whose
 * python layer is mid-upgrade is fine, silently failing at argparse is not.
 */
function requireTargetRunnable(job: Pick<store.Job, "target">) {
  if (!job.target || job.target.type === "local") return;
  if (blabctlSupportsServerUrl() === false)
    throw new ActionError(
      `this bridge's blabctl does not support --server-url, so it cannot dispatch to ` +
        `${targetLabel(job.target)} — update the python layer, or retarget the job to local`,
      409,
    );
}

/**
 * Re-resolve a job's target against the registry immediately before it is
 * queued, and persist the result.
 *
 * A draft can sit for hours. In that time a rented instance can be stopped,
 * destroyed, or restarted with a NEW port mapping — the stored serverUrl is a
 * snapshot from creation time, and dispatching to it would either fail or,
 * worse, reach whatever now answers on that host:port. The registry is the
 * authority, so ask it again: it refuses an instance that is no longer usable
 * (404/409, with the reason) and hands back the current URL otherwise.
 *
 * Only ids a provider actually owns are re-resolved. An instanceId no provider
 * knows about is a label the caller pinned alongside their own serverUrl — the
 * same trust a bare URL gets, and nothing has "changed" about it. (A managed
 * instance that was destroyed stays in the provider's list, marked
 * unavailable, precisely so it does NOT fall into this trusted case.)
 */
function refreshTargetForLaunch(job: store.Job) {
  const current = job.target;
  if (current && current.type === "remote" && current.instanceId) {
    if (getTarget(current.instanceId)) {
      const fresh = target(current.instanceId);
      if (JSON.stringify(fresh) !== JSON.stringify(current)) {
        store.updateJob(job.id, { target: fresh });
        console.log(
          `[bridge] job ${job.id}: target ${current.instanceId} moved to ${targetLabel(fresh)}`,
        );
      }
    } else if (!current.serverUrl) {
      throw new ActionError(`unknown target "${current.instanceId}" and no serverUrl pinned`, 404);
    }
  }
  requireTargetRunnable(store.getJob(job.id) ?? job);
}

// ---------- projects ----------

/**
 * Resolve a project reference the way every caller wants it: an id, else an
 * existing project with that NAME, else a new one. An optimization campaign
 * should not have to check whether its project exists before its first trial —
 * but "cd90x60" on trial two must land in the same project as trial one, or
 * twenty trials become twenty single-mesh projects. Matching is
 * case-insensitive for the same reason.
 */
export function resolveProject(ref: string | undefined | null): store.Project | undefined {
  const value = (ref ?? "").trim();
  if (!value) return undefined;
  const byId = store.getProject(value);
  if (byId) return byId;
  const lower = value.toLowerCase();
  const byName = store.listProjects().find((p) => p.name.trim().toLowerCase() === lower);
  return byName ?? store.createProject({ name: value });
}

function requireProject(id: string): store.Project {
  const project = store.getProject(id);
  if (!project) throw new ActionError(`unknown project ${id}`, 404);
  return project;
}

export function createProject(input: { name?: string; goal?: string; color?: number }): store.Project {
  const name = (input.name ?? "").trim();
  if (!name) throw new ActionError("a project needs a name");
  const existing = store
    .listProjects()
    .find((project) => project.name.trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    // Project names are the idempotent human/agent reference. Creating the
    // same spelling twice must not split one campaign into twin folders. A
    // create of an archived name is best understood as restoring it.
    return existing.archived
      ? store.updateProject(existing.id, { archived: false })!
      : existing;
  }
  return store.createProject({
    name,
    ...(input.goal ? { goal: input.goal } : {}),
    ...(typeof input.color === "number" ? { color: input.color } : {}),
  });
}

export function updateProject(
  id: string,
  patch: { name?: string; goal?: string | null; color?: number; archived?: boolean },
): store.Project {
  requireProject(id);
  if (patch.name !== undefined && !String(patch.name).trim())
    throw new ActionError("a project needs a name");
  if (patch.name !== undefined) {
    const wanted = String(patch.name).trim().toLowerCase();
    const duplicate = store
      .listProjects()
      .find((project) => project.id !== id && project.name.trim().toLowerCase() === wanted);
    if (duplicate)
      throw new ActionError(`a project named "${duplicate.name}" already exists`, 409);
  }
  return store.updateProject(id, {
    ...(patch.name !== undefined ? { name: String(patch.name).trim() } : {}),
    ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
  })!;
}

/** Forget a project; its jobs survive, unassigned. */
export function deleteProject(id: string): { unassigned: number } {
  requireProject(id);
  return { unassigned: store.removeProject(id) };
}

/**
 * Move jobs into (or out of, with `null`) a project. Moving a MESH takes its
 * solves and its variants with it — a design's geometry and the answers
 * computed from it are one thing, and leaving the solves behind would produce
 * exactly the orphaned-results view this rework exists to remove.
 */
export function assignProject(jobIds: string[], projectId: string | null): { moved: string[] } {
  if (projectId !== null) requireProject(projectId);
  const moved = new Set<string>();
  const visit = (id: string) => {
    const job = store.getJob(id);
    if (!job || moved.has(id)) return;
    moved.add(id);
    store.updateJob(id, { projectId });
    if (job.kind !== "mesh") return;
    for (const solve of store.listSolvesOfMesh(id)) visit(solve.id);
    for (const variant of store.listVariantsOfMesh(id)) visit(variant.id);
  };
  for (const id of jobIds) {
    if (!store.getJob(id)) throw new ActionError(`unknown job ${id}`, 404);
    visit(id);
  }
  return { moved: [...moved] };
}

/** The project a new solve should land in: whatever its mesh belongs to. */
const projectOfMesh = (meshJobId: string): string | undefined =>
  store.getJob(meshJobId)?.projectId;

function solveParams(meshJobId: string, options?: SolveOptions): Record<string, unknown> {
  const opts = options ?? {};
  return {
    meshJobId,
    ...(opts.fmin !== undefined ? { fmin: opts.fmin } : {}),
    ...(opts.fmax !== undefined ? { fmax: opts.fmax } : {}),
    ...(opts.count !== undefined ? { count: opts.count } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
    ...(opts.symmetry !== undefined ? { symmetry: opts.symmetry } : {}),
  };
}

/** Pull solve options off a request object, accepting flat keys or `options`. */
export function readSolveOptions(input: Record<string, unknown> | undefined): SolveOptions {
  if (!input) return {};
  const nested = (input.options ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...nested };
  for (const key of SOLVE_OPTION_KEYS) if (input[key] !== undefined) merged[key] = input[key];
  const num = (v: unknown, label: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ActionError(`${label} must be a number`);
    return n;
  };
  return {
    ...(merged.fmin !== undefined ? { fmin: num(merged.fmin, "fmin")! } : {}),
    ...(merged.fmax !== undefined ? { fmax: num(merged.fmax, "fmax")! } : {}),
    ...(merged.count !== undefined ? { count: num(merged.count, "count")! } : {}),
    ...(typeof merged.backend === "string" ? { backend: merged.backend } : {}),
    ...(typeof merged.symmetry === "string" ? { symmetry: merged.symmetry } : {}),
  };
}

// ---------- launch-now paths (unchanged behaviour, new vocabulary) ----------

export function startGenerate(input: {
  generator: string;
  name?: string;
  params?: Record<string, unknown>;
  /** Project id, or a name to create one under. */
  project?: string;
  /** Mesh this one is a variant of — records the lineage. */
  variantOf?: string;
  batchId?: string;
  workspace?: string;
  threadId?: string;
}): store.Job {
  requireGenerator(input.generator);
  const parent = input.variantOf ? requireMesh(input.variantOf) : undefined;
  // A variant belongs to whatever its parent belongs to unless told otherwise:
  // that is the whole point of calling it a variant.
  const project = resolveProject(input.project)?.id ?? parent?.projectId;
  const job = store.createJob({
    kind: "mesh",
    name: input.name?.trim() || `${input.generator} mesh`,
    generator: input.generator,
    params: input.params ?? {},
    target: { type: "local" }, // meshing always runs on the bridge host
    ...(project ? { projectId: project } : {}),
    ...(parent ? { variantOf: parent.id } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
  queue.enqueue(job.id);
  return store.getJob(job.id)!;
}

export function startSolve(input: {
  meshJobId: string;
  name?: string;
  options?: SolveOptions;
  target?: unknown;
  batchId?: string;
  workspace?: string;
  threadId?: string;
}): store.Job {
  const mesh = requireMeshDone(input.meshJobId);
  // Resolve before creating the job: an unusable target must fail the request,
  // not leave a queued job that dies on dispatch.
  const jobTarget = target(input.target);
  requireTargetRunnable({ target: jobTarget });
  const job = store.createJob({
    kind: "solve",
    name: input.name?.trim() || `solve ${mesh.name}`,
    params: solveParams(input.meshJobId, input.options),
    target: jobTarget,
    parentJobId: input.meshJobId,
    // A solve is an answer about a mesh, so it lives wherever that mesh lives.
    ...(mesh.projectId ? { projectId: mesh.projectId } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
  queue.enqueue(job.id);
  return store.getJob(job.id)!;
}

// ---------- drafts ----------

export interface DraftInput {
  kind: store.JobKind;
  name?: string;
  generator?: string;
  params?: Record<string, unknown>;
  /** Solve only — the mesh job to solve. Also accepted inside `params`. */
  meshJobId?: string;
  options?: SolveOptions;
  target?: unknown;
  /** Project id, or a name to create one under. */
  project?: string;
  /** Mesh drafts only: the mesh this is a variant of. */
  variantOf?: string;
  batchId?: string;
  batchName?: string;
  workspace?: string;
  threadId?: string;
}

/** Create ONE configured-but-unlaunched job. */
export function createDraft(input: DraftInput): store.Job {
  if (input.kind !== "mesh" && input.kind !== "solve")
    throw new ActionError(`kind must be "mesh" or "solve"`);

  if (input.kind === "mesh") {
    const generator = String(input.generator ?? "");
    requireGenerator(generator);
    const parent = input.variantOf ? requireMesh(input.variantOf) : undefined;
    const project = resolveProject(input.project)?.id ?? parent?.projectId;
    return store.createJob({
      kind: "mesh",
      status: "draft",
      name: input.name?.trim() || `${generator} mesh`,
      generator,
      params: input.params ?? {},
      target: { type: "local" },
      ...(project ? { projectId: project } : {}),
      ...(parent ? { variantOf: parent.id } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.batchName ? { batchName: input.batchName } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
  }

  const meshJobId = String(
    input.meshJobId ?? (input.params as Record<string, unknown> | undefined)?.meshJobId ?? "",
  );
  if (!meshJobId) throw new ActionError("meshJobId is required for a solve job");
  // A draft only needs the mesh to EXIST — it may still be queued/running; the
  // "done" requirement is enforced at launch, so you can stage solves ahead.
  const mesh = requireMesh(meshJobId);
  const solveProject = resolveProject(input.project)?.id ?? mesh.projectId;
  return store.createJob({
    kind: "solve",
    status: "draft",
    name: input.name?.trim() || `solve ${mesh.name}`,
    // Settings may arrive as `options`, as flat keys, or embedded in `params`
    // (the shape a UI round-tripping a job record would send). Merge, don't pick.
    params: solveParams(meshJobId, {
      ...readSolveOptions(input.params),
      ...(input.options ?? {}),
    }),
    target: target(input.target),
    parentJobId: meshJobId,
    ...(solveProject ? { projectId: solveProject } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.batchName ? { batchName: input.batchName } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
}

/**
 * Derive a new mesh from an existing one: same generator, its params with an
 * override applied, `variantOf` pointing back at it.
 *
 * This is the shape an optimization campaign produces trials in — twenty
 * geometries that are the same design at twenty parameter settings — and doing
 * it through one call is what makes them render as a lineage instead of twenty
 * unrelated mesh jobs. `params` is a PATCH over the parent's params, because
 * "the same but with a wider mouth" is what a variant actually is.
 */
export function createMeshVariant(input: {
  meshJobId: string;
  params?: Record<string, unknown>;
  name?: string;
  /** Launch it now instead of leaving a draft. */
  launch?: boolean;
  project?: string;
  workspace?: string;
  threadId?: string;
}): store.Job {
  const parent = requireMesh(input.meshJobId);
  const generator = String(parent.generator ?? "");
  requireGenerator(generator);
  const params = { ...(parent.params ?? {}), ...(input.params ?? {}) };
  // Name it after what CHANGED — "cd90 · throat=32" says more at a glance than
  // "cd90 mesh (copy 3)", and the schedule board has no room for the latter.
  const changed = Object.entries(input.params ?? {})
    .filter(([key, value]) => String((parent.params ?? {})[key]) !== String(value))
    .map(([key, value]) => `${key}=${value}`);
  const base = parent.name.replace(/\s*·\s*[^·]*$/, "");
  const name =
    input.name?.trim() ||
    (changed.length ? `${base} · ${changed.slice(0, 2).join(" ")}` : `${base} · variant`);

  const project = resolveProject(input.project)?.id ?? parent.projectId;
  const job = store.createJob({
    kind: "mesh",
    status: input.launch ? "queued" : "draft",
    name,
    generator,
    params,
    target: { type: "local" },
    variantOf: parent.id,
    ...(project ? { projectId: project } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
  if (input.launch) queue.enqueue(job.id);
  return store.getJob(job.id)!;
}

/** Edit a draft. Anything but a draft is rejected — 409, not a silent no-op. */
export function updateDraft(
  id: string,
  patch: {
    name?: string;
    generator?: string;
    params?: Record<string, unknown>;
    meshJobId?: string;
    options?: SolveOptions;
    target?: unknown;
    batchId?: string | null;
    batchName?: string;
  },
): store.Job {
  const job = store.getJob(id);
  if (!job) throw new ActionError(`unknown job ${id}`, 404);
  if (job.status !== "draft")
    throw new ActionError(`job ${id} is ${job.status} — only drafts can be edited`, 409);

  const next: Parameters<typeof store.updateJob>[1] = {};
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new ActionError("name cannot be empty");
    next.name = name;
  }
  if (patch.target !== undefined)
    next.target = job.kind === "mesh" ? { type: "local" } : target(patch.target);
  if (patch.batchId !== undefined) next.batchId = patch.batchId;
  if (patch.batchName !== undefined) next.batchName = patch.batchName;

  if (job.kind === "mesh") {
    if (patch.generator !== undefined) {
      requireGenerator(String(patch.generator));
      next.generator = String(patch.generator);
    }
    if (patch.params !== undefined) {
      if (patch.params === null || typeof patch.params !== "object" || Array.isArray(patch.params))
        throw new ActionError("params must be an object");
      next.params = patch.params;
    }
  } else {
    const meshJobId = patch.meshJobId ?? String(job.params.meshJobId ?? "");
    if (patch.meshJobId !== undefined) {
      requireMesh(meshJobId);
      next.parentJobId = meshJobId;
    }
    const current = readSolveOptions(job.params as Record<string, unknown>);
    const incoming = patch.options ?? readSolveOptions(patch.params ?? {});
    if (patch.options !== undefined || patch.params !== undefined || patch.meshJobId !== undefined)
      next.params = solveParams(meshJobId, { ...current, ...incoming });
  }

  store.updateJob(id, next);
  return store.getJob(id)!;
}

// ---------- batches ----------

export interface BatchVariant extends Record<string, unknown> {
  name?: string;
  target?: unknown;
  options?: SolveOptions;
  params?: Record<string, unknown>;
}

export interface BatchInput {
  kind: store.JobKind;
  /** Display label for the whole batch; also the stem of each job's name. */
  name?: string;
  batchId?: string;
  /**
   * Project id, or a name to create one under. Solves default to their mesh's
   * project; mesh batches default to a project named after the batch, because
   * a sweep of meshes IS a family of variants and hiding that was the old
   * model's mistake.
   */
  project?: string;
  /** Launch every created job immediately instead of leaving drafts. */
  launch?: boolean;
  /** Default execution target for every variant that does not override it. */
  target?: unknown;
  // solve
  meshJobId?: string;
  meshJobIds?: string[];
  options?: SolveOptions;
  // mesh
  generator?: string;
  params?: Record<string, unknown>;
  /** One job per variant (per mesh, for solves). Empty/absent = a single job. */
  variants?: BatchVariant[];
  workspace?: string;
  threadId?: string;
}

export interface BatchResult {
  batchId: string;
  batchName?: string;
  created: number;
  jobs: store.Job[];
  launched: { jobId: string; lane: string; queuePosition: number }[];
  skipped: { jobId: string; reason: string }[];
}

/** Short human label for what a variant changed, e.g. "count=48 symmetry=off". */
function variantLabel(variant: BatchVariant, index: number, kind: store.JobKind): string {
  if (typeof variant.name === "string" && variant.name.trim()) return variant.name.trim();
  const bits: string[] = [];
  if (kind === "solve") {
    const opts = readSolveOptions(variant);
    for (const key of SOLVE_OPTION_KEYS)
      if (opts[key] !== undefined) bits.push(`${key}=${String(opts[key])}`);
  } else {
    const params = (variant.params ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(params).slice(0, 3))
      bits.push(`${key}=${String(value)}`);
  }
  if (variant.target !== undefined) {
    const t = target(variant.target);
    bits.push(t.type === "local" ? "local" : `@${t.instanceId ?? t.serverUrl}`);
  }
  return bits.length ? bits.join(" ") : `#${index + 1}`;
}

/**
 * Create a whole sweep in one call.
 *
 * For solves the jobs are the cross product `meshJobIds × variants`, so
 * "these 3 meshes at these 4 settings" is one request producing 12 drafts.
 * With `launch: true` they go straight into their target lanes.
 */
export function createBatch(input: BatchInput): BatchResult {
  if (input.kind !== "mesh" && input.kind !== "solve")
    throw new ActionError(`kind must be "mesh" or "solve"`);

  const variants: BatchVariant[] =
    Array.isArray(input.variants) && input.variants.length > 0 ? input.variants : [{}];
  for (const v of variants)
    if (v === null || typeof v !== "object" || Array.isArray(v))
      throw new ActionError("each variant must be an object");

  const meshIds =
    input.kind === "solve"
      ? (input.meshJobIds ?? (input.meshJobId ? [input.meshJobId] : []))
      : [""];
  if (input.kind === "solve" && meshIds.length === 0)
    throw new ActionError("meshJobId or meshJobIds is required for a solve batch");

  const total = meshIds.length * variants.length;
  if (total === 0) throw new ActionError("batch would create no jobs");
  if (total > MAX_BATCH_JOBS)
    throw new ActionError(
      `batch would create ${total} jobs, over the ${MAX_BATCH_JOBS} limit — split it up`,
    );

  // Validate everything BEFORE creating anything: a half-created sweep is worse
  // than a rejected one.
  if (input.kind === "mesh") requireGenerator(String(input.generator ?? ""));
  else for (const id of meshIds) requireMesh(id);
  const defaultTarget = target(input.target);
  const variantTargets = variants.map((v) =>
    v.target !== undefined ? (input.kind === "mesh" ? { type: "local" as const } : target(v.target)) : defaultTarget,
  );

  const batchId = input.batchId?.trim() || store.newBatchId();
  const batchName = input.name?.trim() || undefined;
  const baseOptions = input.options ?? {};
  const baseParams = input.params ?? {};

  // A mesh sweep is a variant family: give it a project (named after the batch
  // when the caller did not name one) and hang every variant off the first one.
  const explicitProject = resolveProject(input.project)?.id;
  const meshProject =
    input.kind === "mesh"
      ? (explicitProject ?? resolveProject(batchName ?? `${input.generator} sweep`)?.id)
      : explicitProject;
  let variantRoot: string | undefined;

  const jobs: store.Job[] = [];
  for (const meshId of meshIds) {
    const mesh = input.kind === "solve" ? store.getJob(meshId) : undefined;
    variants.forEach((variant, i) => {
      const label = variantLabel(variant, i, input.kind);
      const stem = batchName ?? (mesh ? `solve ${mesh.name}` : `${input.generator} mesh`);
      const name =
        variants.length === 1 && meshIds.length === 1
          ? stem
          : mesh && meshIds.length > 1
            ? `${stem} · ${mesh.name} · ${label}`
            : `${stem} · ${label}`;
      const job =
        input.kind === "mesh"
          ? store.createJob({
              kind: "mesh",
              status: input.launch ? "queued" : "draft",
              name,
              generator: String(input.generator),
              params: { ...baseParams, ...((variant.params ?? {}) as Record<string, unknown>) },
              target: { type: "local" },
              ...(meshProject ? { projectId: meshProject } : {}),
              // First mesh of the sweep is the root; the rest are its variants.
              ...(variantRoot ? { variantOf: variantRoot } : {}),
              batchId,
              ...(batchName ? { batchName } : {}),
              ...(input.workspace ? { workspace: input.workspace } : {}),
              ...(input.threadId ? { threadId: input.threadId } : {}),
            })
          : store.createJob({
              kind: "solve",
              status: input.launch ? "queued" : "draft",
              name,
              params: solveParams(meshId, { ...baseOptions, ...readSolveOptions(variant) }),
              target: variantTargets[i]!,
              parentJobId: meshId,
              ...(explicitProject ?? projectOfMesh(meshId)
                ? { projectId: (explicitProject ?? projectOfMesh(meshId))! }
                : {}),
              batchId,
              ...(batchName ? { batchName } : {}),
              ...(input.workspace ? { workspace: input.workspace } : {}),
              ...(input.threadId ? { threadId: input.threadId } : {}),
            });
      if (input.kind === "mesh" && !variantRoot) variantRoot = job.id;
      jobs.push(job);
    });
  }

  const result: BatchResult = {
    batchId,
    ...(batchName ? { batchName } : {}),
    created: jobs.length,
    jobs,
    launched: [],
    skipped: [],
  };

  if (input.launch) {
    for (const job of jobs) {
      // createJob already set status "queued"; validate then hand to the queue.
      try {
        if (job.kind === "solve") {
          requireMeshDone(String(job.params.meshJobId));
          refreshTargetForLaunch(job);
        }
      } catch (err) {
        store.finishJob(job.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        result.skipped.push({ jobId: job.id, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      queue.enqueue(job.id);
      result.launched.push({
        jobId: job.id,
        lane: queue.laneOf(job.id) ?? "",
        queuePosition: queue.queuePosition(job.id),
      });
    }
  }
  result.jobs = jobs.map((j) => store.getJob(j.id)!);
  return result;
}

export interface JobSelector {
  jobIds?: string[];
  batchId?: string;
}

function selectJobs(selector: JobSelector): store.Job[] {
  const out: store.Job[] = [];
  const seen = new Set<string>();
  if (selector.batchId) {
    const batch = store.listBatch(selector.batchId);
    // An empty batch is a typo, not "nothing to do" — say so instead of
    // silently reporting a successful no-op.
    if (batch.length === 0) throw new ActionError(`unknown batch ${selector.batchId}`, 404);
    for (const job of batch) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      out.push(job);
    }
  }
  for (const id of selector.jobIds ?? []) {
    if (seen.has(id)) continue;
    const job = store.getJob(id);
    if (!job) throw new ActionError(`unknown job ${id}`, 404);
    seen.add(id);
    out.push(job);
  }
  if (!selector.batchId && (selector.jobIds ?? []).length === 0)
    throw new ActionError("pass jobIds and/or batchId");
  return out;
}

export interface LaunchResult {
  launched: { jobId: string; name: string; lane: string; queuePosition: number }[];
  skipped: { jobId: string; reason: string }[];
}

/** Move drafts into their target lanes. Non-drafts are reported, not thrown. */
export function launchJobs(selector: JobSelector): LaunchResult {
  const result: LaunchResult = { launched: [], skipped: [] };
  for (const job of selectJobs(selector)) {
    if (job.status !== "draft") {
      result.skipped.push({ jobId: job.id, reason: `job is ${job.status}, not a draft` });
      continue;
    }
    try {
      if (job.kind === "solve") {
        requireMeshDone(String(job.params.meshJobId));
        refreshTargetForLaunch(job);
      } else requireGenerator(String(job.generator ?? ""));
    } catch (err) {
      result.skipped.push({ jobId: job.id, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!store.markQueued(job.id)) {
      result.skipped.push({ jobId: job.id, reason: "no longer a draft" });
      continue;
    }
    queue.enqueue(job.id);
    result.launched.push({
      jobId: job.id,
      name: job.name,
      lane: queue.laneOf(job.id) ?? "",
      queuePosition: queue.queuePosition(job.id),
    });
  }
  return result;
}

export interface HoldResult {
  held: { jobId: string; name: string }[];
  skipped: { jobId: string; reason: string }[];
}

/**
 * Put queued-but-not-started jobs back on the shelf as drafts. The undo for a
 * launch, and what dragging a card out of a lane does — the configuration
 * survives, so a sweep aimed at the wrong box is a correction, not a rebuild.
 */
export function holdJobs(selector: JobSelector): HoldResult {
  const result: HoldResult = { held: [], skipped: [] };
  for (const job of selectJobs(selector)) {
    if (job.status === "draft") continue; // already held; not an error
    if (job.status !== "queued" || queue.isRunning(job.id)) {
      result.skipped.push({
        jobId: job.id,
        reason: job.status === "running" ? "already running — cancel it instead" : `job is ${job.status}`,
      });
      continue;
    }
    queue.removeQueued(job.id);
    if (!store.markDraft(job.id)) {
      result.skipped.push({ jobId: job.id, reason: "started before it could be held" });
      continue;
    }
    result.held.push({ jobId: job.id, name: job.name });
  }
  return result;
}

// ---------- the schedule board's write path ----------

/** The backlog column: configured work that has not been handed to a lane. */
export const PLANNED_COLUMN = "planned";

export interface ScheduleMove {
  jobId: string;
  /**
   * Where the card was dropped: PLANNED_COLUMN to hold it as a draft, or a
   * compute target id to run it there.
   */
  column: string;
  /** 0-based index within that column's waiting line. Omit to append. */
  position?: number;
}

export interface ScheduleResult {
  moved: { jobId: string; column: string; lane: string; queuePosition: number }[];
  skipped: { jobId: string; reason: string }[];
}

/**
 * Apply drag-and-drop moves: this is the ONE write path behind the schedule
 * board, and it is deliberately per-card rather than "here is the whole board"
 * — two people (or an agent and a person) rearranging at once should merge,
 * not have the last full-board snapshot silently undo the other's move.
 *
 * A move never destroys work. Dropping onto a target launches; dropping back
 * onto the backlog holds. Running jobs refuse to move, with the reason.
 */
export function scheduleJobs(moves: ScheduleMove[]): ScheduleResult {
  const result: ScheduleResult = { moved: [], skipped: [] };
  for (const move of moves) {
    const job = store.getJob(move.jobId);
    if (!job) throw new ActionError(`unknown job ${move.jobId}`, 404);
    const skip = (reason: string) => result.skipped.push({ jobId: job.id, reason });

    if (store.TERMINAL.has(job.status)) {
      skip(`already ${job.status}`);
      continue;
    }
    if (job.status === "running" || queue.isRunning(job.id)) {
      skip("running — it is already on a machine");
      continue;
    }

    // ---- back to the backlog ----
    if (move.column === PLANNED_COLUMN) {
      if (job.status === "queued") {
        queue.removeQueued(job.id);
        store.markDraft(job.id);
      }
      orderDrafts(job.id, move.position);
      result.moved.push({ jobId: job.id, column: PLANNED_COLUMN, lane: "", queuePosition: 0 });
      continue;
    }

    // ---- onto a machine ----
    let jobTarget: store.JobTarget;
    try {
      jobTarget = target(move.column);
    } catch (err) {
      skip(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (job.kind === "mesh" && jobTarget.type !== "local") {
      skip("mesh generation always runs on the bridge host");
      continue;
    }

    if (job.status === "draft") {
      store.updateJob(job.id, { target: jobTarget });
      const launched = launchJobs({ jobIds: [job.id] });
      if (launched.skipped.length > 0) {
        skip(launched.skipped[0]!.reason);
        continue;
      }
      if (move.position !== undefined) queue.moveWithinLane(job.id, move.position);
    } else if (!queue.retarget(job.id, jobTarget, move.position)) {
      skip("could not be moved");
      continue;
    }
    result.moved.push({
      jobId: job.id,
      column: move.column,
      lane: queue.laneOf(job.id) ?? "",
      queuePosition: queue.queuePosition(job.id),
    });
  }
  return result;
}

/** Place a draft at `position` among all drafts, by rewriting priorities. */
function orderDrafts(jobId: string, position?: number) {
  const drafts = store
    .listJobs()
    .filter((j) => j.status === "draft")
    .sort((a, b) => store.priorityOf(a) - store.priorityOf(b))
    .map((j) => j.id)
    .filter((id) => id !== jobId);
  const at = position === undefined ? drafts.length : Math.max(0, Math.min(position, drafts.length));
  drafts.splice(at, 0, jobId);
  // Numbered from the backlog base, not from zero: the backlog's own order
  // matters, but a held job must not cut ahead of a lane when it is launched.
  store.reorderPriorities(drafts, store.BACKLOG_PRIORITY_BASE);
}

/** Rewrite a whole lane's waiting order — the multi-card drop. */
export function reorderLane(laneKey: string, jobIds: string[]): { order: string[] } {
  if (!laneKey) throw new ActionError("laneKey is required");
  return { order: queue.reorderLane(laneKey, jobIds) };
}

/**
 * Set how many solves a target runs at once, and (locally) which GPU each slot
 * gets. Raising the local count past 1 is allowed and warned about, never
 * silently ignored — see targets.setTargetConfig.
 */
export function setTargetSlots(
  targetId: string,
  patch: { slots?: number | null; devices?: string[] | null },
): { target: ReturnType<typeof listTargets>[number] | undefined; warning: string | null } {
  const existing = getTarget(targetId);
  if (!existing) throw new ActionError(`unknown target ${targetId}`, 404);
  try {
    assertTargetSlotsConfigurable(existing, patch);
    setTargetConfig(targetId, patch);
  } catch (err) {
    if (err instanceof TargetError) throw new ActionError(err.message, err.status);
    throw err;
  }
  const updated = getTarget(targetId);
  const devices = updated?.devices ?? [];
  const warning =
    updated && updated.concurrency > 1 && devices.length < updated.concurrency
      ? `${updated.label} will run ${updated.concurrency} solves at once on the same device — ` +
        `they share VRAM, so a mesh that fits alone may fail here. Pin one device per slot, ` +
        `or keep the slot count at 1.`
      : null;
  return { target: updated, warning };
}

export interface CancelResult {
  cancelled: { jobId: string; status: store.JobStatus }[];
  skipped: { jobId: string; reason: string }[];
}

/** Cancel a set of jobs (a whole batch, an explicit list, or both). */
export function cancelJobs(selector: JobSelector): CancelResult {
  const result: CancelResult = { cancelled: [], skipped: [] };
  for (const job of selectJobs(selector)) {
    if (store.TERMINAL.has(job.status)) {
      result.skipped.push({ jobId: job.id, reason: `already ${job.status}` });
      continue;
    }
    queue.cancel(job.id);
    result.cancelled.push({ jobId: job.id, status: store.getJob(job.id)!.status });
  }
  return result;
}

export function cancelJob(id: string): store.Job {
  const job = store.getJob(id);
  if (!job) throw new ActionError(`unknown job ${id}`, 404);
  queue.cancel(id);
  return store.getJob(id)!;
}

export function deleteJob(id: string) {
  const job = store.getJob(id);
  if (!job) throw new ActionError(`unknown job ${id}`, 404);
  if (job.status === "running" || queue.isRunning(id))
    throw new ActionError(`job ${id} is running — cancel it first`, 409);
  // A queued/running solve reads its mesh job's directory (result.json, mesh
  // files) when it starts — deleting the mesh out from under it guarantees a
  // late failure. Drafts pointing at it would silently become unlaunchable.
  // Block on both; the caller can delete the drafts or cancel the solves.
  const dependents = store
    .listJobs()
    .filter((j) => j.parentJobId === id && !store.TERMINAL.has(j.status))
    .map((j) => `${j.id} (${j.status})`);
  if (dependents.length > 0)
    throw new ActionError(
      `job ${id} is the mesh for pending solve job(s) ${dependents.join(", ")} — ` +
        `cancel or delete them first`,
      409,
    );
  queue.removeQueued(id);
  store.removeJob(id);
}

/** Delete every job in a batch. Refuses while any of them is queued/running. */
export function deleteBatch(batchId: string): { deleted: string[] } {
  const jobs = store.listBatch(batchId);
  if (jobs.length === 0) throw new ActionError(`unknown batch ${batchId}`, 404);
  const busy = jobs.filter((j) => store.ACTIVE.has(j.status)).map((j) => j.id);
  if (busy.length > 0)
    throw new ActionError(`batch ${batchId} still has active job(s) ${busy.join(", ")} — cancel first`, 409);
  const deleted: string[] = [];
  // Solves first: deleting a mesh is blocked while a dependent solve exists.
  for (const job of [...jobs].sort((a, b) => (a.kind === "solve" ? -1 : 1) - (b.kind === "solve" ? -1 : 1))) {
    try {
      deleteJob(job.id);
      deleted.push(job.id);
    } catch {
      /* dependent outside the batch — leave it, report what did go */
    }
  }
  return { deleted };
}

export interface BatchSummary {
  batchId: string;
  batchName?: string;
  kinds: store.JobKind[];
  createdAt: string;
  total: number;
  counts: Record<store.JobStatus, number>;
  jobIds: string[];
}

export function batchSummary(batchId: string): BatchSummary | undefined {
  const jobs = store.listBatch(batchId);
  if (jobs.length === 0) return undefined;
  const counts: Record<store.JobStatus, number> = {
    draft: 0,
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const job of jobs) counts[job.status] += 1;
  const named = jobs.find((j) => j.batchName);
  return {
    batchId,
    ...(named?.batchName ? { batchName: named.batchName } : {}),
    kinds: [...new Set(jobs.map((j) => j.kind))],
    createdAt: jobs[0]!.createdAt,
    total: jobs.length,
    counts,
    jobIds: jobs.map((j) => j.id),
  };
}

export const listBatches = (): BatchSummary[] =>
  store.listBatchIds().map((id) => batchSummary(id)!).filter(Boolean);

const GIB = 1024 ** 3;

/**
 * Backend ids/aliases that consume the LOCAL machine's GPU memory, mirroring
 * blab.solvers.registry's alias table. Used only to decide whether an advisory
 * note is worth showing at queue time; the authoritative check runs in python
 * (bridge/py/vram.py) once the solve actually starts.
 */
const LOCAL_GPU_BACKEND_ALIASES = new Set([
  "julia_local",
  "local_julia",
  "beat",
  "beat_engine",
  "beat_cuda",
  "beat_gpu",
  "cuda",
  "beat_rocm",
  "rocm",
  "amd",
  "amdgpu",
]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Advisory peak-VRAM note for a solve about to be queued, read off the
 * estimates `generate` recorded on the mesh job. Purely informational — mesh
 * size is a hardware-capacity question, never a reason to refuse work.
 * Remote targets get no note: it is the remote box's VRAM that matters, and
 * the bridge does not know it.
 */
export function solveVramNote(
  meshJobId: string,
  options?: SolveOptions,
  jobTarget?: store.JobTarget,
): string | null {
  // A remote solve consumes the RENTED box's VRAM, not this machine's, so a
  // note about local capacity would be actively misleading.
  if (jobTarget && jobTarget.type === "remote") return null;
  const backend = (options?.backend ?? "beat_cuda").trim().toLowerCase();
  if (!LOCAL_GPU_BACKEND_ALIASES.has(backend)) return null;

  const vram = asRecord(asRecord(store.getJob(meshJobId)?.summary)?.vram);
  if (!vram) return null;
  // generate keys estimates by symmetry: "off" plus the sorted mirror axes it
  // detected (e.g. "xy"), matching the solve's --symmetry values.
  const requested = (options?.symmetry ?? "off").trim().toLowerCase() || "off";
  const key = requested === "off" ? "off" : [...requested].sort().join("");
  const bytes = asRecord(vram.estimate_bytes)?.[key];
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;

  const human = `${(bytes / GIB).toFixed(2)} GiB`;
  const gpu = asRecord(vram.gpu);
  const total = typeof gpu?.total_bytes === "number" ? gpu.total_bytes : null;
  if (total === null)
    return `Estimated peak GPU memory ~${human}; local VRAM could not be detected, so it was not checked.`;
  const gpuName = typeof gpu?.name === "string" ? gpu.name : "the local GPU";
  if (bytes > total)
    return (
      `WARNING: estimated peak GPU memory ~${human} exceeds the ${(total / GIB).toFixed(2)} GiB on ` +
      `${gpuName}. The solve is queued anyway and may fail with a CUDA out-of-memory error — ` +
      `coarsen the mesh, solve with symmetry, or send it to a remote target if it does.`
    );
  return `Estimated peak GPU memory ~${human} of ${(total / GIB).toFixed(2)} GiB on ${gpuName}.`;
}

/**
 * Re-ingest a job's directory after the fact: register files written post-hoc
 * (analysis plots, metrics) as artifacts, and lift metrics.json's score /
 * subscores into job.summary so the dashboard can show them. Idempotent —
 * existing artifacts are deduped by URL. SSE fires via the store mutations.
 */
export function rescanJob(id: string): store.Job {
  const job = store.getJob(id);
  if (!job) throw new ActionError(`unknown job ${id}`, 404);

  const dir = path.resolve(store.jobDir(id));
  const known = new Set(job.artifacts.map((a) => a.url));
  const usedNames = new Set(job.artifacts.map((a) => a.name));
  const walk = (abs: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // job dir missing/unreadable — nothing to ingest
    }
    for (const entry of entries) {
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(dir, full);
      if (rel === "job.log") continue; // registered by addLogArtifact
      const relUrlPath = rel.split(path.sep).map(encodeURIComponent).join("/");
      const url = `/artifacts/${id}/${relUrlPath}`;
      if (known.has(url)) continue;
      known.add(url);
      // addArtifact dedupes by name, so a basename collision (same filename in
      // two places) would silently drop the later file. Prefer the basename,
      // fall back to the job-dir-relative path, and as a last resort (a root
      // file whose relative path IS the taken basename) add a numeric suffix —
      // every distinct URL must end up registered under a unique name.
      let name = usedNames.has(entry.name) ? rel.split(path.sep).join("/") : entry.name;
      if (usedNames.has(name)) {
        const ext = path.extname(name);
        const stem = name.slice(0, name.length - ext.length);
        for (let i = 2; usedNames.has(name); i++) name = `${stem}~${i}${ext}`;
      }
      usedNames.add(name);
      store.addArtifact(id, {
        name,
        kind: store.classify(entry.name),
        url,
      });
    }
  };
  walk(dir);

  // Lift score/subscores from metrics.json (written post-hoc by the analysis
  // step). Tolerate absence and malformed content silently — the schema is
  // evolving in a parallel stream.
  const metricsFile = path.join(dir, "metrics.json");
  if (fs.existsSync(metricsFile)) {
    try {
      const metrics: unknown = JSON.parse(fs.readFileSync(metricsFile, "utf8"));
      if (metrics !== null && typeof metrics === "object" && !Array.isArray(metrics)) {
        const m = metrics as Record<string, unknown>;
        // The current metrics file is authoritative: fields it omits (or holds
        // invalid values for) are cleared from the summary (undefined =
        // delete in mergeSummary) so score and subscores never mix analysis
        // runs. Unrelated solver-summary fields are untouched.
        store.mergeSummary(id, {
          score: typeof m.score === "number" && Number.isFinite(m.score) ? m.score : undefined,
          subscores:
            m.subscores !== null && typeof m.subscores === "object" && !Array.isArray(m.subscores)
              ? m.subscores
              : undefined,
        });
      }
    } catch {
      /* malformed metrics.json — leave summary untouched */
    }
  }

  return store.getJob(id)!;
}

export function fullState() {
  const gens = generatorsCache();
  const vastKey = describeVastKey();
  const jobs = store.listJobs();
  // One history scan for the whole snapshot: every card on the schedule board
  // wants a duration, and rebuilding the sample pool per card would turn an
  // O(jobs) render into O(jobs^2).
  const pool = estimate.historySamples();
  const targets = listTargets();
  return {
    generators: gens.generators,
    generatorsError: gens.error ?? null,
    jobs,
    projects: store.listProjects(),
    queue: queue.queueSnapshot(),
    targets: targets.map((t) => ({ ...t, throughput: estimate.targetThroughput(t.id) })),
    /**
     * Per-job time estimates, keyed by job id — for everything not yet
     * finished, including the drafts sitting in the backlog column that have
     * no lane to be forecast in.
     */
    estimates: Object.fromEntries(
      jobs
        .filter((j) => !store.TERMINAL.has(j.status))
        .map((j) => [j.id, estimate.estimateJob(j, pool)]),
    ),
    batches: listBatches(),
    t3: { configured: t3Configured() },
    publicUrl: config.publicUrl,
    /**
     * Rented compute. Cached registry state only — this is the SSE snapshot
     * path and must never make an upstream call. Use GET /api/vast/instances
     * to refresh against vast.ai. The key itself is never included, only
     * whether one is configured and where it came from.
     */
    vast: {
      configured: vastKey.configured,
      keySource: vastKey.source,
      instances: vastRegistry.list(),
      activeBurnRatePerHour: Number(vastRegistry.activeBurnRatePerHour().toFixed(4)),
    },
  };
}
