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
 *   cancelJobs / deleteJob
 */
import fs from "node:fs";
import path from "node:path";
import { config, t3Configured } from "./config.ts";
import * as store from "./store.ts";
import * as queue from "./queue.ts";
import {
  blabctlSupportsServerUrl,
  listTargets,
  normalizeTarget,
  targetLabel,
  TargetError,
} from "./targets.ts";
import { generatorsCache, getGenerator } from "./generators.ts";

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
    if (err instanceof TargetError) throw new ActionError(err.message);
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
  batchId?: string;
  workspace?: string;
  threadId?: string;
}): store.Job {
  requireGenerator(input.generator);
  const job = store.createJob({
    kind: "mesh",
    name: input.name?.trim() || `${input.generator} mesh`,
    generator: input.generator,
    params: input.params ?? {},
    target: { type: "local" }, // meshing always runs on the bridge host
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
  const jobTarget = target(input.target);
  requireTargetRunnable({ target: jobTarget });
  const job = store.createJob({
    kind: "solve",
    name: input.name?.trim() || `solve ${mesh.name}`,
    params: solveParams(input.meshJobId, input.options),
    target: jobTarget,
    parentJobId: input.meshJobId,
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
    return store.createJob({
      kind: "mesh",
      status: "draft",
      name: input.name?.trim() || `${generator} mesh`,
      generator,
      params: input.params ?? {},
      target: { type: "local" },
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
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.batchName ? { batchName: input.batchName } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
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
              batchId,
              ...(batchName ? { batchName } : {}),
              ...(input.workspace ? { workspace: input.workspace } : {}),
              ...(input.threadId ? { threadId: input.threadId } : {}),
            });
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
          requireTargetRunnable(job);
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
        requireTargetRunnable(job);
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
  return {
    generators: gens.generators,
    generatorsError: gens.error ?? null,
    jobs: store.listJobs(),
    queue: queue.queueSnapshot(),
    targets: listTargets(),
    batches: listBatches(),
    t3: { configured: t3Configured() },
    publicUrl: config.publicUrl,
  };
}
