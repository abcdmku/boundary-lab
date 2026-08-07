/**
 * The one internal API for actions. A UI button and an MCP tool that do the
 * same thing call the same function here — never two code paths.
 */
import fs from "node:fs";
import path from "node:path";
import { config, t3Configured } from "./config.ts";
import * as store from "./store.ts";
import * as queue from "./queue.ts";
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
  /**
   * Where to run: "local" (default), "vast:<instanceId>" for a managed rented
   * GPU, or an explicit http(s) URL of any reachable `blab server`.
   * See resolveSolveTarget.
   */
  target?: string;
}

export interface ResolvedTarget {
  id: string;
  kind: "local" | "vast" | "url";
  /** null for local; the base URL of a remote `blab server` otherwise. */
  serverUrl: string | null;
}

/**
 * Turn a target id into something the solve can actually be dispatched to.
 *
 * A remote target must be provably usable before a run is queued — a solve
 * that fails an hour later because the box was never provisioned is far worse
 * than an immediate, explanatory refusal. For a managed vast instance that
 * means: in the registry, status "ready", a known server URL, and a passing
 * health check. The bare-URL form is the escape hatch for a `blab server`
 * this bridge does not manage, and is taken on trust.
 */
export function resolveSolveTarget(target?: string): ResolvedTarget {
  const requested = (target ?? "local").trim();
  if (requested === "" || requested.toLowerCase() === "local")
    return { id: "local", kind: "local", serverUrl: null };

  if (/^https?:\/\//i.test(requested))
    return { id: requested, kind: "url", serverUrl: requested.replace(/\/$/, "") };

  const vastMatch = /^vast:(\d+)$/.exec(requested);
  if (!vastMatch)
    throw new ActionError(
      `unknown solve target "${requested}" — expected "local", "vast:<instanceId>", or an http(s) URL`,
    );

  const instanceId = Number(vastMatch[1]);
  const instance = vastRegistry.get(instanceId);
  if (!instance)
    throw new ActionError(`vast instance ${instanceId} is not managed by this bridge`, 404);
  if (instance.status !== "ready" || !instance.serverUrl)
    throw new ActionError(
      `vast instance ${instanceId} is "${instance.status}", not ready — provision it first ` +
        `(POST /api/vast/instances/${instanceId}/provision)`,
      409,
    );
  if (instance.lastHealth?.ok !== true)
    throw new ActionError(
      `vast instance ${instanceId} has not passed a health check` +
        `${instance.lastHealth?.error ? ` (last error: ${instance.lastHealth.error})` : ""} — ` +
        `re-check it with POST /api/vast/instances/${instanceId}/health`,
      409,
    );
  return { id: requested, kind: "vast", serverUrl: instance.serverUrl };
}

export function startGenerate(input: {
  generator: string;
  name?: string;
  params?: Record<string, unknown>;
  workspace?: string;
  threadId?: string;
}): store.Run {
  if (!input.generator) throw new ActionError("generator is required");
  // Only reject unknown ids when we actually have a catalog — with the python
  // layer missing the job itself will fail with a useful log instead.
  if (generatorsCache().generators.length > 0 && !getGenerator(input.generator)) {
    throw new ActionError(
      `unknown generator "${input.generator}" — known: ${generatorsCache()
        .generators.map((g) => g.id)
        .join(", ")}`,
    );
  }
  const run = store.createRun({
    kind: "mesh",
    name: input.name?.trim() || `${input.generator} mesh`,
    generator: input.generator,
    params: input.params ?? {},
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
  queue.enqueue(run.id);
  return store.getRun(run.id)!;
}

export function startSolve(input: {
  meshRunId: string;
  name?: string;
  options?: SolveOptions;
  workspace?: string;
  threadId?: string;
}): store.Run {
  const mesh = store.getRun(input.meshRunId);
  if (!mesh) throw new ActionError(`unknown run ${input.meshRunId}`, 404);
  if (mesh.kind !== "mesh") throw new ActionError(`run ${input.meshRunId} is not a mesh run`);
  if (mesh.status !== "done")
    throw new ActionError(`mesh run ${input.meshRunId} is ${mesh.status}, not done`);
  const opts = input.options ?? {};
  // Resolve before creating the run: an unusable target must fail the request,
  // not leave a queued run that dies on dispatch.
  const target = resolveSolveTarget(opts.target);
  const run = store.createRun({
    kind: "solve",
    name: input.name?.trim() || `solve ${mesh.name}`,
    params: {
      meshRunId: input.meshRunId,
      ...(opts.fmin !== undefined ? { fmin: opts.fmin } : {}),
      ...(opts.fmax !== undefined ? { fmax: opts.fmax } : {}),
      ...(opts.count !== undefined ? { count: opts.count } : {}),
      // A remote solve is dispatched with --backend server, so the caller's
      // backend choice belongs to the server and is not passed through here.
      ...(opts.backend !== undefined && target.kind === "local" ? { backend: opts.backend } : {}),
      ...(opts.symmetry !== undefined ? { symmetry: opts.symmetry } : {}),
      ...(target.kind === "local" ? {} : { target: target.id, serverUrl: target.serverUrl }),
    },
    parentRunId: input.meshRunId,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
  queue.enqueue(run.id);
  return store.getRun(run.id)!;
}

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
 * estimates `generate` recorded on the mesh run. Purely informational — mesh
 * size is a hardware-capacity question, never a reason to refuse work.
 */
export function solveVramNote(meshRunId: string, options?: SolveOptions): string | null {
  // A remote solve consumes the RENTED box's VRAM, not this machine's, so a
  // note about local capacity would be actively misleading.
  const requestedTarget = (options?.target ?? "local").trim().toLowerCase();
  if (requestedTarget !== "" && requestedTarget !== "local") return null;
  const backend = (options?.backend ?? "beat_cuda").trim().toLowerCase();
  if (!LOCAL_GPU_BACKEND_ALIASES.has(backend)) return null;

  const vram = asRecord(asRecord(store.getRun(meshRunId)?.summary)?.vram);
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
      `coarsen the mesh or solve with symmetry if it does.`
    );
  return `Estimated peak GPU memory ~${human} of ${(total / GIB).toFixed(2)} GiB on ${gpuName}.`;
}

export function cancelRun(id: string): store.Run {
  const run = store.getRun(id);
  if (!run) throw new ActionError(`unknown run ${id}`, 404);
  queue.cancel(id);
  return store.getRun(id)!;
}

export function deleteRun(id: string) {
  const run = store.getRun(id);
  if (!run) throw new ActionError(`unknown run ${id}`, 404);
  if (run.status === "running" || queue.isRunning(id))
    throw new ActionError(`run ${id} is running — cancel it first`, 409);
  // A queued/running solve reads its mesh run's directory (result.json, mesh
  // files) when it starts — deleting the mesh out from under it guarantees a
  // late failure. Block until those solves finish or are cancelled.
  const dependents = store
    .listRuns()
    .filter((r) => r.parentRunId === id && !store.TERMINAL.has(r.status))
    .map((r) => r.id);
  if (dependents.length > 0)
    throw new ActionError(
      `run ${id} is the mesh for pending solve run(s) ${dependents.join(", ")} — cancel them first`,
      409,
    );
  queue.removeQueued(id);
  store.removeRun(id);
}

/**
 * Re-ingest a run's directory after the fact: register files written post-hoc
 * (analysis plots, metrics) as artifacts, and lift metrics.json's score /
 * subscores into run.summary so the dashboard can show them. Idempotent —
 * existing artifacts are deduped by URL. SSE fires via the store mutations.
 */
export function rescanRun(id: string): store.Run {
  const run = store.getRun(id);
  if (!run) throw new ActionError(`unknown run ${id}`, 404);

  const dir = path.resolve(store.runDir(id));
  const known = new Set(run.artifacts.map((a) => a.url));
  const usedNames = new Set(run.artifacts.map((a) => a.name));
  const walk = (abs: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // run dir missing/unreadable — nothing to ingest
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
      // fall back to the run-dir-relative path, and as a last resort (a root
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

  return store.getRun(id)!;
}

export function fullState() {
  const gens = generatorsCache();
  const vastKey = describeVastKey();
  return {
    generators: gens.generators,
    generatorsError: gens.error ?? null,
    runs: store.listRuns(),
    queue: queue.queueSnapshot(),
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
