/**
 * The job queue: two lanes, each strict concurrency 1.
 *
 *   'mesh'  — generate jobs (fast, 5 min timeout)
 *   'solve' — BEM solves   (long, 4 h timeout)
 *
 * HARD RULE (GPU safety on this machine): the solve lane must never run two
 * jobs at once. That is enforced structurally — a lane holds at most one
 * active child, and pump() only starts a job when `active` is null.
 *
 * Jobs spawn `PYTHON BLABCTL <args>` (no shell), cwd REPO_ROOT, with
 * BLAB_JULIA_EXECUTABLE/BLAB_JULIA_EXE in the child env. stdout is parsed as
 * NDJSON (blabctl's contract — see bridge/py/blabctl.py):
 *
 *   {"event":"progress","stage":"...","message":"...","done":3,"total":10}
 *   {"event":"result","ok":true, ...final summary JSON...}   (always the last line)
 *   {"event":"result","ok":false,"error":"..."}
 *
 * Non-JSON stdout lines and all stderr append to <runDir>/job.log.
 *
 * Cancellation kills the whole child process tree (Windows: taskkill /F /T).
 * On solve completion, if the run is correlated to a live t3 thread, the
 * bridge dispatches a wake-up thread.turn.start with a compact summary.
 */
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { config, t3Configured } from "./config.ts";
import * as store from "./store.ts";
import * as t3 from "./t3.ts";
import { threadInfo } from "./threads.ts";

const TIMEOUT_MS: Record<store.RunKind, number> = {
  mesh: 5 * 60_000,
  solve: 4 * 60 * 60_000,
};

interface Lane {
  queue: string[];
  active: { runId: string; child: ChildProcess; cancelled: boolean; timedOut: boolean } | null;
}

const lanes: Record<store.RunKind, Lane> = {
  mesh: { queue: [], active: null },
  solve: { queue: [], active: null },
};

/** Active + waiting run ids per lane, in execution order. */
export const queueSnapshot = () => ({
  mesh: laneIds("mesh"),
  solve: laneIds("solve"),
});

const laneIds = (kind: store.RunKind) => {
  const lane = lanes[kind];
  return [...(lane.active ? [lane.active.runId] : []), ...lane.queue];
};

/** 1-based position in the lane (1 = running now). 0 if not in the lane. */
export const queuePosition = (runId: string): number => {
  for (const kind of ["mesh", "solve"] as const) {
    const i = laneIds(kind).indexOf(runId);
    if (i >= 0) return i + 1;
  }
  return 0;
};

export function enqueue(runId: string) {
  const run = store.getRun(runId);
  if (!run || run.status !== "queued") return;
  lanes[run.kind].queue.push(runId);
  pump(run.kind);
}

export const isRunning = (runId: string) =>
  lanes.mesh.active?.runId === runId || lanes.solve.active?.runId === runId;

export const isQueued = (runId: string) =>
  lanes.mesh.queue.includes(runId) || lanes.solve.queue.includes(runId);

/** Drop a queued (not yet started) run from its lane. */
export function removeQueued(runId: string) {
  for (const lane of Object.values(lanes)) {
    const i = lane.queue.indexOf(runId);
    if (i >= 0) lane.queue.splice(i, 1);
  }
}

export function cancel(runId: string) {
  const run = store.getRun(runId);
  if (!run) return;
  if (isQueued(runId)) {
    removeQueued(runId);
    store.finishRun(runId, { status: "cancelled" });
    return;
  }
  for (const lane of Object.values(lanes)) {
    if (lane.active?.runId === runId) {
      lane.active.cancelled = true;
      killTree(lane.active.child);
    }
  }
}

function killTree(child: ChildProcess) {
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
 * orphan keeps the GPU, mark those runs cancelled, and drop the queues so the
 * close-handler pump cannot start new work.
 */
export function shutdownAll(reason: string) {
  for (const lane of Object.values(lanes)) {
    lane.queue.length = 0;
    if (lane.active) {
      lane.active.cancelled = true;
      killTree(lane.active.child);
      store.finishRun(lane.active.runId, { status: "cancelled", error: reason });
      store.setRunPid(lane.active.runId, undefined);
    }
  }
}

function pump(kind: store.RunKind) {
  const lane = lanes[kind];
  if (lane.active) return; // strict concurrency 1 per lane
  const runId = lane.queue.shift();
  if (runId === undefined) return;
  const run = store.getRun(runId);
  if (!run || run.status !== "queued") {
    pump(kind);
    return;
  }
  startJob(run);
}

/**
 * blabctl's --name is validated as a safe filename stem (it becomes
 * <name>.msh / <name>.cfg inside the run dir), but run names are
 * human-readable display strings ("ath_waveguide mesh"). Slug the display
 * name into a stem blabctl accepts; the run record keeps the pretty name.
 */
function fileStem(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "case";
}

function buildArgs(run: store.Run): string[] {
  const dir = store.runDir(run.id);
  if (run.kind === "mesh") {
    // blabctl takes params as a JSON file, not inline.
    const paramsFile = path.join(dir, "params.json");
    fs.writeFileSync(paramsFile, JSON.stringify(run.params ?? {}, null, 2));
    return [
      "generate",
      "--generator",
      String(run.generator ?? ""),
      "--params",
      paramsFile,
      "--out",
      dir,
      "--name",
      fileStem(run.name),
    ];
  }
  // solve: params = { meshRunId, fmin?, fmax?, count?, backend?, symmetry? }
  const args = [
    "solve",
    "--mesh-run",
    store.runDir(String(run.params.meshRunId)),
    "--out",
    dir,
    // Only pass an explicit Julia when configured — otherwise let blabctl's
    // own resolution (env, known install, PATH) find it.
    ...(config.juliaExecutable ? ["--julia-exe", config.juliaExecutable] : []),
  ];
  for (const key of ["fmin", "fmax", "count", "backend", "symmetry"] as const) {
    const value = run.params[key];
    if (value !== undefined && value !== null) args.push(`--${key}`, String(value));
  }
  return args;
}

function startJob(run: store.Run) {
  const kind = run.kind;
  const lane = lanes[kind];
  const dir = store.runDir(run.id);
  fs.mkdirSync(dir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(dir, "job.log"), { flags: "a" });
  store.addLogArtifact(run.id);
  store.markRunning(run.id);

  let resultEvent: unknown;
  let errorMsg: string | undefined;
  let spawnError: string | undefined;

  const child = spawn(config.python, [config.blabctl, ...buildArgs(run)], {
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
  const active = { runId: run.id, child, cancelled: false, timedOut: false };
  lane.active = active;
  if (child.pid) store.setRunPid(run.id, child.pid);

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
          store.setProgress(run.id, {
            stage: String(parsed.stage ?? ""),
            message: String(parsed.message ?? ""),
            ...(typeof parsed.done === "number" ? { done: parsed.done } : {}),
            ...(typeof parsed.total === "number" ? { total: parsed.total } : {}),
          });
          return;
        }
        if (eventKind === "warning") {
          // Advisory only — never fails the run. The durable copy lives in the
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
    if (lane.active?.runId === run.id) lane.active = null;
    store.setRunPid(run.id, undefined);

    if (active.cancelled) {
      store.finishRun(run.id, { status: "cancelled" });
    } else if (active.timedOut) {
      store.finishRun(run.id, {
        status: "failed",
        error: `timed out after ${TIMEOUT_MS[kind] / 60_000} min`,
        ...(resultEvent !== undefined ? { summary: resultEvent } : {}),
      });
    } else if (spawnError !== undefined) {
      store.finishRun(run.id, { status: "failed", error: spawnError });
    } else if (errorMsg !== undefined || code !== 0) {
      store.finishRun(run.id, {
        status: "failed",
        error: errorMsg ?? `blabctl exited with code ${code} (see job.log)`,
        ...(resultEvent !== undefined ? { summary: resultEvent } : {}),
      });
    } else if (resultEvent === undefined) {
      store.finishRun(run.id, {
        status: "failed",
        error: "blabctl exited 0 without emitting a result event (see job.log)",
      });
    } else {
      store.finishRun(run.id, { status: "done", summary: resultEvent });
    }

    void wakeThread(run.id);
    pump(kind);
  };

  child.on("close", (code) => finalize(code));
}

/**
 * The wake-up pattern: a solve's owning thread was told "do not wait" — when
 * the job lands, start a turn on that thread with a compact result summary.
 * Pseudo-thread ids (standalone:/project:) are not real t3 threads; skip them.
 */
async function wakeThread(runId: string) {
  const run = store.getRun(runId);
  if (!run || run.kind !== "solve") return;
  if (!t3Configured() || !run.threadId || run.threadId.includes(":")) return;
  try {
    const thread = await threadInfo(run.threadId);
    const vramWarning = (run.summary as Record<string, unknown> | undefined)?.vram_warning;
    const lines = [
      `Boundary Lab solve run ${run.id} ("${run.name}") finished: ${run.status.toUpperCase()}.`,
      ...(run.error ? [`Error: ${run.error}`] : []),
      ...(typeof vramWarning === "string" && vramWarning ? [`VRAM warning: ${vramWarning}`] : []),
      ...(run.artifacts.length
        ? [
            "Artifacts:",
            ...run.artifacts.map((a) => `- ${a.name} (${a.kind}): ${config.publicUrl}${a.url}`),
          ]
        : []),
      `Details: get_run {"run_id":"${run.id}"} · UI: ${config.publicUrl}/`,
    ];
    await t3.startTurn(run.threadId, lines.join("\n"), {
      runtimeMode: thread?.runtimeMode,
      interactionMode: thread?.interactionMode,
    });
  } catch (err) {
    console.error(`[bridge] wake-up for run ${runId} failed: ${err}`);
  }
}
