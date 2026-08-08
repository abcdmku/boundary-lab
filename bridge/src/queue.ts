/**
 * The job queue: one lane per execution target.
 *
 *   'local:mesh'          — generate jobs on this machine (fast, 5 min timeout)
 *   'local:solve'         — BEM solves on this machine's GPU (long, 4 h timeout)
 *   'remote:<instanceId>' — BEM solves dispatched to a remote solver server
 *
 * HARD RULE (GPU safety on this machine): the LOCAL lanes must never run two
 * jobs at once. That is enforced structurally — `local:*` lanes are built with
 * concurrency 1 and pump() only starts a job while `active.size < concurrency`.
 * Remote lanes get their concurrency from the target registry (default 1 per
 * instance), so N cloud instances run N solves in parallel while local stays
 * strictly serialized.
 *
 * Jobs spawn `PYTHON BLABCTL <args>` (no shell), cwd REPO_ROOT, with
 * BLAB_JULIA_EXECUTABLE/BLAB_JULIA_EXE in the child env. stdout is parsed as
 * NDJSON (blabctl's contract — see bridge/py/blabctl.py):
 *
 *   {"event":"progress","stage":"...","message":"...","done":3,"total":10}
 *   {"event":"result","ok":true, ...final summary JSON...}   (always the last line)
 *   {"event":"result","ok":false,"error":"..."}
 *
 * Non-JSON stdout lines and all stderr append to <jobDir>/job.log.
 *
 * Cancellation kills the whole child process tree (Windows: taskkill /F /T).
 * On solve completion, if the job is correlated to a live t3 thread, the
 * bridge dispatches a wake-up thread.turn.start with a compact summary.
 */
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { config, t3Configured } from "./config.ts";
import * as store from "./store.ts";
import * as t3 from "./t3.ts";
import { targetConcurrency, targetLabel } from "./targets.ts";
import { threadInfo } from "./threads.ts";

const TIMEOUT_MS: Record<store.JobKind, number> = {
  mesh: 5 * 60_000,
  solve: 4 * 60 * 60_000,
};

interface ActiveJob {
  jobId: string;
  child: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
}

interface Lane {
  key: string;
  kind: store.JobKind;
  /** "local" or the remote instance id / server url. */
  targetId: string;
  label: string;
  concurrency: number;
  queue: string[];
  /** Insertion-ordered so queue positions are stable. */
  active: Map<string, ActiveJob>;
}

export const LOCAL_MESH_LANE = "local:mesh";
export const LOCAL_SOLVE_LANE = "local:solve";

const lanes = new Map<string, Lane>();

/** Lane key for a job — derived purely from kind + target, so it is stable
 *  for the whole job lifetime (the target of a queued job cannot change). */
export function laneKeyFor(job: Pick<store.Job, "kind" | "target">): string {
  if (job.kind === "mesh") return LOCAL_MESH_LANE; // meshing is always local
  const target = job.target;
  if (!target || target.type === "local") return LOCAL_SOLVE_LANE;
  return `remote:${target.instanceId ?? target.serverUrl}`;
}

function ensureLane(job: store.Job): Lane {
  const key = laneKeyFor(job);
  const isLocal = key === LOCAL_MESH_LANE || key === LOCAL_SOLVE_LANE;
  // Local concurrency is not configurable: one GPU, one job.
  const concurrency = isLocal ? 1 : targetConcurrency(job.target);
  let lane = lanes.get(key);
  if (!lane) {
    lane = {
      key,
      kind: job.kind,
      targetId: isLocal ? "local" : (job.target as { instanceId?: string; serverUrl: string }).instanceId ??
        (job.target as { serverUrl: string }).serverUrl,
      label: isLocal ? (job.kind === "mesh" ? "local mesh" : "local solve") : targetLabel(job.target),
      concurrency,
      queue: [],
      active: new Map(),
    };
    lanes.set(key, lane);
  } else {
    // A remote instance's configured concurrency can change while the bridge
    // runs (registry refresh) — pick it up, but never below the running count.
    lane.concurrency = concurrency;
  }
  return lane;
}

/** Drop an idle remote lane so the snapshot does not accumulate dead instances. */
function pruneLane(lane: Lane) {
  if (lane.key === LOCAL_MESH_LANE || lane.key === LOCAL_SOLVE_LANE) return;
  if (lane.active.size === 0 && lane.queue.length === 0) lanes.delete(lane.key);
}

const laneIds = (lane: Lane) => [...lane.active.keys(), ...lane.queue];

/**
 * Lane-by-lane view of the queue, execution order first. The two local lanes
 * are always present so the UI has a stable frame even when idle.
 */
export function queueSnapshot() {
  for (const seed of [
    { key: LOCAL_MESH_LANE, kind: "mesh" as const },
    { key: LOCAL_SOLVE_LANE, kind: "solve" as const },
  ]) {
    if (!lanes.has(seed.key))
      lanes.set(seed.key, {
        key: seed.key,
        kind: seed.kind,
        targetId: "local",
        label: seed.kind === "mesh" ? "local mesh" : "local solve",
        concurrency: 1,
        queue: [],
        active: new Map(),
      });
  }
  return {
    lanes: [...lanes.values()].map((lane) => ({
      key: lane.key,
      kind: lane.kind,
      targetId: lane.targetId,
      label: lane.label,
      concurrency: lane.concurrency,
      active: [...lane.active.keys()],
      queued: [...lane.queue],
    })),
  };
}

function findLane(jobId: string): Lane | undefined {
  for (const lane of lanes.values())
    if (lane.active.has(jobId) || lane.queue.includes(jobId)) return lane;
  return undefined;
}

/** 1-based position in the job's lane (<= concurrency means running now). 0 if not queued. */
export const queuePosition = (jobId: string): number => {
  const lane = findLane(jobId);
  if (!lane) return 0;
  return laneIds(lane).indexOf(jobId) + 1;
};

/** Lane key a job currently sits in (or would sit in, if it is a draft). */
export const laneOf = (jobId: string): string | null => {
  const job = store.getJob(jobId);
  return job ? laneKeyFor(job) : null;
};

export function enqueue(jobId: string) {
  const job = store.getJob(jobId);
  // Drafts are deliberately not enqueueable: only markQueued() (launch) makes
  // a job eligible, so a configured-but-unlaunched job can never start work.
  if (!job || job.status !== "queued") return;
  const lane = ensureLane(job);
  if (lane.queue.includes(jobId) || lane.active.has(jobId)) return;
  lane.queue.push(jobId);
  pump(lane);
}

export const isRunning = (jobId: string) => {
  for (const lane of lanes.values()) if (lane.active.has(jobId)) return true;
  return false;
};

export const isQueued = (jobId: string) => {
  for (const lane of lanes.values()) if (lane.queue.includes(jobId)) return true;
  return false;
};

/** Drop a queued (not yet started) job from its lane. */
export function removeQueued(jobId: string) {
  for (const lane of [...lanes.values()]) {
    const i = lane.queue.indexOf(jobId);
    if (i >= 0) {
      lane.queue.splice(i, 1);
      pruneLane(lane);
    }
  }
}

export function cancel(jobId: string) {
  const job = store.getJob(jobId);
  if (!job) return;
  // A draft never reached the queue — cancelling it just closes the record.
  if (job.status === "draft") {
    store.finishJob(jobId, { status: "cancelled" });
    return;
  }
  if (isQueued(jobId)) {
    removeQueued(jobId);
    store.finishJob(jobId, { status: "cancelled" });
    return;
  }
  for (const lane of lanes.values()) {
    const active = lane.active.get(jobId);
    if (active) {
      active.cancelled = true;
      killTree(active.child);
    }
  }
}

/**
 * Kill a python child and everything under it. Exported because the preview
 * worker (src/preview.ts) has the same problem this solves: its generators
 * shell out to Ath.exe, and a lone kill of python would leave that orphaned.
 */
export function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // taskkill /T takes the whole tree — python child + any Julia grandchildren.
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  } else {
    // The child was spawned detached, so it leads its own process group.
    // Kill the group (negative pid) so Julia grandchildren die with it —
    // a lone SIGKILL to python would leave Julia holding the GPU.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Bridge is shutting down (SIGINT/SIGTERM): kill every active child tree so no
 * orphan keeps the GPU, mark those jobs cancelled, and drop the queues so the
 * close-handler pump cannot start new work.
 */
export function shutdownAll(reason: string) {
  for (const lane of lanes.values()) {
    // Close the waiting jobs honestly rather than leaving them "queued" for the
    // next start's restart sweep to relabel as an interrupted failure.
    for (const jobId of lane.queue.splice(0)) store.finishJob(jobId, { status: "cancelled", error: reason });
    for (const active of lane.active.values()) {
      active.cancelled = true;
      killTree(active.child);
      store.finishJob(active.jobId, { status: "cancelled", error: reason });
      store.setJobPid(active.jobId, undefined);
    }
  }
}

function pump(lane: Lane) {
  while (lane.active.size < lane.concurrency) {
    const jobId = lane.queue.shift();
    if (jobId === undefined) break;
    const job = store.getJob(jobId);
    if (!job || job.status !== "queued") continue; // deleted or cancelled while waiting
    startJob(job, lane);
  }
  pruneLane(lane);
}

/**
 * blabctl's --name is validated as a safe filename stem (it becomes
 * <name>.msh / <name>.cfg inside the job dir), but job names are
 * human-readable display strings ("ath_waveguide mesh"). Slug the display
 * name into a stem blabctl accepts; the job record keeps the pretty name.
 */
function fileStem(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "case";
}

/** Exported for tests: the exact blabctl argv a job would be started with. */
export function buildArgs(job: store.Job): string[] {
  const dir = store.jobDir(job.id);
  if (job.kind === "mesh") {
    // blabctl takes params as a JSON file, not inline.
    const paramsFile = path.join(dir, "params.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(paramsFile, JSON.stringify(job.params ?? {}, null, 2));
    return [
      "generate",
      "--generator",
      String(job.generator ?? ""),
      "--params",
      paramsFile,
      "--out",
      dir,
      "--name",
      fileStem(job.name),
    ];
  }
  // solve: params = { meshJobId, fmin?, fmax?, count?, backend?, symmetry? }
  //
  // A remote target means the solve runs on another machine (a rented vast.ai
  // GPU, or any reachable `blab server`): blabctl inlines the config and mesh
  // into the request and streams results back, so no shared filesystem is
  // needed. blabctl rejects --server-url unless the backend is `server`, and
  // the local Julia path is meaningless there, so both are handled explicitly.
  const remote = job.target && job.target.type === "remote" ? job.target : null;
  const args = [
    "solve",
    "--mesh-run",
    store.jobDir(String(job.params.meshJobId)),
    "--out",
    dir,
    // Only pass an explicit Julia when configured, and only for local work —
    // otherwise let blabctl's own resolution (env, known install, PATH) find
    // it. A remote solve runs Julia on the server, not here.
    ...(config.juliaExecutable && !remote ? ["--julia-exe", config.juliaExecutable] : []),
  ];
  if (remote) {
    // Remote execution: blabctl's `server` backend forwards the solve to the
    // instance's HTTP API (--server-url is added by the blabctl stream). The
    // job's own `backend` param describes a LOCAL solver and is not passed —
    // the remote server picks its own.
    args.push("--backend", "server", "--server-url", remote.serverUrl);
  }
  for (const key of ["fmin", "fmax", "count", "backend", "symmetry"] as const) {
    if (remote && key === "backend") continue;
    const value = job.params[key];
    if (value !== undefined && value !== null) args.push(`--${key}`, String(value));
  }
  return args;
}

function startJob(job: store.Job, lane: Lane) {
  const kind = job.kind;
  const dir = store.jobDir(job.id);
  fs.mkdirSync(dir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(dir, "job.log"), { flags: "a" });
  store.addLogArtifact(job.id);
  store.markRunning(job.id);

  let resultEvent: unknown;
  let errorMsg: string | undefined;
  let spawnError: string | undefined;

  const child = spawn(config.python, [config.blabctl, ...buildArgs(job)], {
    cwd: config.repoRoot,
    env: {
      ...process.env,
      ...(config.juliaExecutable
        ? {
            BLAB_JULIA_EXECUTABLE: config.juliaExecutable,
            BLAB_JULIA_EXE: config.juliaExecutable, // the name blabctl actually reads
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // POSIX: own process group so killTree can SIGKILL python + Julia together.
    detached: process.platform !== "win32",
  });
  const active: ActiveJob = { jobId: job.id, child, cancelled: false, timedOut: false };
  lane.active.set(job.id, active);
  if (child.pid) store.setJobPid(job.id, child.pid);

  const timer = setTimeout(() => {
    active.timedOut = true;
    killTree(child);
  }, TIMEOUT_MS[kind]);

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const eventKind = parsed.event ?? parsed.type;
        if (eventKind === "progress") {
          store.setProgress(job.id, {
            stage: String(parsed.stage ?? ""),
            message: String(parsed.message ?? ""),
            ...(typeof parsed.done === "number" ? { done: parsed.done } : {}),
            ...(typeof parsed.total === "number" ? { total: parsed.total } : {}),
          });
          return;
        }
        if (eventKind === "warning") {
          // Advisory only — never fails the job. The durable copy lives in the
          // result summary; this is the human-readable trace in job.log.
          logStream.write(`WARNING [${String(parsed.stage ?? "")}] ${String(parsed.message ?? "")}\n`);
          return;
        }
        if (eventKind === "result") {
          const { event: _event, type: _type, ok, ...summary } = parsed;
          if (ok === false) {
            errorMsg = String(parsed.error ?? "unknown blabctl error");
          } else {
            resultEvent = summary;
          }
          return;
        }
        // Unknown JSON event — keep it in the log for debugging.
      } catch {
        /* fall through to the log */
      }
    }
    logStream.write(line + "\n");
  });
  child.stderr!.on("data", (chunk: Buffer) => logStream.write(chunk));

  child.on("error", (err) => {
    spawnError = `failed to spawn ${config.python}: ${err.message}`;
    // 'close' may never fire when spawn itself failed
    finalize();
  });

  let finalized = false;
  const finalize = (code?: number | null) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timer);
    rl.close();
    logStream.end();
    lane.active.delete(job.id);
    store.setJobPid(job.id, undefined);

    if (active.cancelled) {
      store.finishJob(job.id, { status: "cancelled" });
    } else if (active.timedOut) {
      store.finishJob(job.id, {
        status: "failed",
        error: `timed out after ${TIMEOUT_MS[kind] / 60_000} min`,
        ...(resultEvent !== undefined ? { summary: resultEvent } : {}),
      });
    } else if (spawnError !== undefined) {
      store.finishJob(job.id, { status: "failed", error: spawnError });
    } else if (errorMsg !== undefined || code !== 0) {
      store.finishJob(job.id, {
        status: "failed",
        error: errorMsg ?? `blabctl exited with code ${code} (see job.log)`,
        ...(resultEvent !== undefined ? { summary: resultEvent } : {}),
      });
    } else if (resultEvent === undefined) {
      store.finishJob(job.id, {
        status: "failed",
        error: "blabctl exited 0 without emitting a result event (see job.log)",
      });
    } else {
      store.finishJob(job.id, { status: "done", summary: resultEvent });
    }

    void wakeThread(job.id);
    pump(lane);
  };

  child.on("close", (code) => finalize(code));
}

/**
 * The wake-up pattern: a solve's owning thread was told "do not wait" — when
 * the job lands, start a turn on that thread with a compact result summary.
 * Pseudo-thread ids (standalone:/project:) are not real t3 threads; skip them.
 */
async function wakeThread(jobId: string) {
  const job = store.getJob(jobId);
  if (!job || job.kind !== "solve") return;
  if (!t3Configured() || !job.threadId || job.threadId.includes(":")) return;
  try {
    const thread = await threadInfo(job.threadId);
    const vramWarning = (job.summary as Record<string, unknown> | undefined)?.vram_warning;
    const lines = [
      `Boundary Lab solve job ${job.id} ("${job.name}") finished: ${job.status.toUpperCase()}.`,
      `Target: ${targetLabel(job.target)}.`,
      ...(job.batchId ? [`Batch: ${job.batchId}.`] : []),
      ...(job.error ? [`Error: ${job.error}`] : []),
      ...(typeof vramWarning === "string" && vramWarning ? [`VRAM warning: ${vramWarning}`] : []),
      ...(job.artifacts.length
        ? [
            "Artifacts:",
            ...job.artifacts.map((a) => `- ${a.name} (${a.kind}): ${config.publicUrl}${a.url}`),
          ]
        : []),
      `Details: get_job {"job_id":"${job.id}"} · UI: ${config.publicUrl}/`,
    ];
    await t3.startTurn(job.threadId, lines.join("\n"), {
      runtimeMode: thread?.runtimeMode,
      interactionMode: thread?.interactionMode,
    });
  } catch (err) {
    console.error(`[bridge] wake-up for job ${jobId} failed: ${err}`);
  }
}

/** Test helper: forget every lane (does not touch running children). */
export function resetLanes() {
  lanes.clear();
}
