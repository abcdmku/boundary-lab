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
  const run = store.createRun({
    kind: "solve",
    name: input.name?.trim() || `solve ${mesh.name}`,
    params: {
      meshRunId: input.meshRunId,
      ...(opts.fmin !== undefined ? { fmin: opts.fmin } : {}),
      ...(opts.fmax !== undefined ? { fmax: opts.fmax } : {}),
      ...(opts.count !== undefined ? { count: opts.count } : {}),
      ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
      ...(opts.symmetry !== undefined ? { symmetry: opts.symmetry } : {}),
    },
    parentRunId: input.meshRunId,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
  queue.enqueue(run.id);
  return store.getRun(run.id)!;
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
      store.addArtifact(id, {
        name: entry.name,
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
        const patch: Record<string, unknown> = {};
        if (typeof m.score === "number" && Number.isFinite(m.score)) patch.score = m.score;
        if (m.subscores !== null && typeof m.subscores === "object" && !Array.isArray(m.subscores))
          patch.subscores = m.subscores;
        if (Object.keys(patch).length > 0) store.mergeSummary(id, patch);
      }
    } catch {
      /* malformed metrics.json — leave summary untouched */
    }
  }

  return store.getRun(id)!;
}

export function fullState() {
  const gens = generatorsCache();
  return {
    generators: gens.generators,
    generatorsError: gens.error ?? null,
    runs: store.listRuns(),
    queue: queue.queueSnapshot(),
    t3: { configured: t3Configured() },
    publicUrl: config.publicUrl,
  };
}
