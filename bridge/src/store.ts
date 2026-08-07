/**
 * Domain state: the run ledger.
 *
 * A run is one job — a mesh generation ('mesh') or a BEM solve ('solve').
 * Each run owns a directory DATA_DIR/runs/<id>/ where blabctl writes its
 * outputs and where job.log accumulates raw process output. This file holds
 * only metadata; heavy artifacts stay on disk and are served by URL.
 *
 * Every mutation fans out over `emitter` ("change", {runId}) to SSE
 * subscribers so the UI is live, and persists (debounced) to
 * DATA_DIR/state.json.
 */
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { config } from "./config.ts";

export type RunKind = "mesh" | "solve";
export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type ArtifactKind = "preview" | "plot" | "mesh" | "data" | "config" | "log";

export interface Artifact {
  name: string;
  kind: ArtifactKind;
  url: string;
}

export interface Progress {
  stage: string;
  message: string;
  done?: number;
  total?: number;
}

export interface Run {
  id: string;
  kind: RunKind;
  name: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  generator?: string;
  params: Record<string, unknown>;
  parentRunId?: string;
  workspace?: string;
  threadId?: string;
  progress?: Progress;
  /** OS pid of the live blabctl child, persisted so a restarted bridge can
   *  reap orphans. Cleared when the child exits. */
  pid?: number;
  /** The python layer's final result JSON (blabctl's "result" event). */
  summary?: unknown;
  error?: string;
  artifacts: Artifact[];
}

interface PersistedState {
  runs: Run[];
  /**
   * Feature-owned top-level sections (see readSection/writeSection). Keeps
   * state.json a single file with a single atomic writer while letting
   * modules like vast/ own their own slice without this file knowing the shape.
   */
  [section: string]: unknown;
}

const stateFile = () => path.join(config.dataDir, "state.json");
const runsRoot = () => path.join(config.dataDir, "runs");
export const runDir = (id: string) => path.join(runsRoot(), id);
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "failed", "cancelled"]);

export const emitter = new EventEmitter();
emitter.setMaxListeners(200);

let state: PersistedState = { runs: [] };

export function loadStore() {
  fs.mkdirSync(runsRoot(), { recursive: true });
  if (fs.existsSync(stateFile())) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    } catch (err) {
      console.error(`[bridge] state.json unreadable, starting fresh: ${err}`);
      state = { runs: [] };
    }
  }
  // The queue is in-memory only: anything mid-flight when the bridge died is
  // dead — but its OS process may not be. Reap verified orphans BEFORE the
  // queue accepts work, or a leftover Julia solve and a new one would share
  // the GPU.
  for (const run of state.runs) {
    if (run.status === "queued" || run.status === "running") {
      if (run.status === "running" && run.pid) killVerifiedOrphan(run);
      run.status = "failed";
      run.finishedAt = now();
      run.error = "interrupted by bridge restart";
      delete run.pid;
    }
  }
  persistNow();
}

/** Best-effort command line of a live process; null when it no longer exists. */
function processCommandLine(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      const out = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
      );
      const text = (out.stdout ?? "").trim();
      return text.length ? text : null;
    }
    if (process.platform === "linux") {
      try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        const text = raw.split("\0").join(" ").trim();
        if (text.length) return text;
      } catch {
        return null;
      }
    }
    const out = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 15_000,
    });
    const text = (out.stdout ?? "").trim();
    return text.length ? text : null;
  } catch {
    return null;
  }
}

/**
 * Kill a blabctl child left over from a previous bridge process — but only
 * after verifying the persisted pid still belongs to that run. PIDs get
 * recycled by the OS, so we require the live process's command line to
 * mention both blabctl and this run's id (its --out run directory) before
 * touching it. Synchronous on purpose: runs during loadStore, before the
 * server starts accepting jobs.
 */
function killVerifiedOrphan(run: Run) {
  if (!run.pid) return;
  const cmdline = processCommandLine(run.pid);
  if (cmdline === null) return; // process already gone
  if (!(/blabctl/i.test(cmdline) && cmdline.includes(run.id))) {
    console.warn(
      `[bridge] pid ${run.pid} recorded for run ${run.id} now belongs to another process; leaving it alone`,
    );
    return;
  }
  console.warn(`[bridge] reaping orphaned job process ${run.pid} (run ${run.id})`);
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(run.pid)], {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
    });
  } else {
    // Children are spawned detached (own process group) — kill the group so
    // Julia grandchildren die too, then the leader in case the group is gone.
    try {
      process.kill(-run.pid, "SIGKILL");
    } catch {
      /* group already gone */
    }
    try {
      process.kill(run.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// ---------- persistence (debounced) ----------
let persistTimer: NodeJS.Timeout | null = null;

function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  // Atomic replace: write a temp file, then rename over state.json. A
  // force-kill mid-write must never truncate the ledger — losing it would
  // drop the live-pid record the restart orphan-reap depends on. rename on
  // the same volume is atomic on POSIX; on Windows libuv uses
  // MoveFileEx(REPLACE_EXISTING), so state.json is always a last-good copy.
  const file = stateFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      persistNow();
    } catch (err) {
      console.error(`[bridge] failed to persist state: ${err}`);
    }
  }, 250);
}

process.on("exit", () => {
  try {
    persistNow();
  } catch {
    /* best effort */
  }
});

const now = () => new Date().toISOString();
const changed = (runId?: string) => emitter.emit("change", { runId });

// ---------- reads ----------
export const getRun = (id: string) => state.runs.find((r) => r.id === id);

/** Newest first. */
export const listRuns = () =>
  [...state.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// ---------- feature sections ----------
/**
 * Read a feature-owned section of state.json (e.g. "vast"). Returns the
 * fallback when the key is absent or holds something other than an object —
 * a hand-edited or older state file must never crash a feature module.
 * The caller owns the shape; this file only guarantees persistence.
 */
export function readSection<T>(key: string, fallback: T): T {
  const value = state[key];
  if (value === null || typeof value !== "object") return fallback;
  return value as T;
}

/**
 * Replace a feature-owned section and persist. Emits a change with no runId,
 * which the SSE stream turns into a full-state push — so UI clients see
 * section updates on the same live channel as runs.
 *
 * Persists synchronously rather than on the debounce: sections track things
 * like rented cloud instances that cost money by the second, and a crash in
 * the debounce window must never lose the record of one.
 */
export function writeSection(key: string, value: unknown) {
  if (key === "runs") throw new Error("the run ledger is not a feature section");
  state[key] = value;
  try {
    persistNow();
  } catch (err) {
    console.error(`[bridge] failed to persist section "${key}": ${err}`);
  }
  changed();
}

// ---------- writes ----------
function newId(): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8);
    if (id.length === 6 && !getRun(id)) return id;
  }
}

export function createRun(input: {
  kind: RunKind;
  name: string;
  generator?: string;
  params: Record<string, unknown>;
  parentRunId?: string;
  workspace?: string;
  threadId?: string;
}): Run {
  const run: Run = {
    id: newId(),
    kind: input.kind,
    name: input.name,
    status: "queued",
    createdAt: now(),
    ...(input.generator ? { generator: input.generator } : {}),
    params: input.params,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    artifacts: [],
  };
  fs.mkdirSync(runDir(run.id), { recursive: true });
  state.runs.push(run);
  persist();
  changed(run.id);
  return run;
}

export function markRunning(id: string) {
  const run = getRun(id);
  if (!run) return;
  run.status = "running";
  run.startedAt = now();
  persist();
  changed(id);
}

/** Record (or clear) the live child pid. Persists immediately — the pid must
 *  be on disk before the child does real work, or a crash right after spawn
 *  would leave an untracked orphan. */
export function setRunPid(id: string, pid: number | undefined) {
  const run = getRun(id);
  if (!run) return;
  if (pid === undefined) delete run.pid;
  else run.pid = pid;
  try {
    persistNow();
  } catch (err) {
    console.error(`[bridge] failed to persist pid for run ${id}: ${err}`);
  }
  changed(id);
}

export function setProgress(id: string, progress: Progress) {
  const run = getRun(id);
  if (!run) return;
  run.progress = progress;
  persist();
  changed(id);
}

export function finishRun(
  id: string,
  outcome: { status: "done" | "failed" | "cancelled"; summary?: unknown; error?: string },
) {
  const run = getRun(id);
  if (!run || TERMINAL.has(run.status)) return;
  run.status = outcome.status;
  run.finishedAt = now();
  if (outcome.summary !== undefined) {
    run.summary = outcome.summary;
    ingestSummaryArtifacts(run, outcome.summary);
  }
  if (outcome.error !== undefined) run.error = outcome.error;
  persist();
  changed(id);
}

export function addArtifact(id: string, artifact: Artifact) {
  const run = getRun(id);
  if (!run) return;
  if (run.artifacts.some((a) => a.name === artifact.name)) return;
  run.artifacts.push(artifact);
  persist();
  changed(id);
}

/**
 * Merge fields into run.summary (object-ifying a non-object summary) —
 * used to lift post-hoc metrics (score, subscores) into the run record.
 * A patch value of `undefined` deletes the key, so a rerun analysis that
 * drops a metric also removes the previously lifted field.
 */
export function mergeSummary(id: string, patch: Record<string, unknown>) {
  const run = getRun(id);
  if (!run) return;
  const base =
    run.summary !== null && typeof run.summary === "object" && !Array.isArray(run.summary)
      ? (run.summary as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  run.summary = merged;
  persist();
  changed(id);
}

/** Remove the run record and its directory. Caller must ensure it is not running. */
export function removeRun(id: string) {
  const i = state.runs.findIndex((r) => r.id === id);
  if (i < 0) return;
  state.runs.splice(i, 1);
  fs.rmSync(runDir(id), { recursive: true, force: true });
  persist();
  changed(id);
}

// ---------- artifact ingest ----------
const artifactUrl = (runId: string, basename: string) =>
  `/artifacts/${runId}/${encodeURIComponent(basename)}`;

export function classify(basename: string): ArtifactKind {
  const lower = basename.toLowerCase();
  const ext = path.extname(lower);
  if ([".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"].includes(ext))
    return lower.includes("preview") ? "preview" : "plot";
  if ([".msh", ".stl", ".obj", ".ply", ".vtk", ".vtu", ".med", ".geo"].includes(ext)) return "mesh";
  if ([".json", ".yaml", ".yml", ".toml", ".cfg", ".ini"].includes(ext)) return "config";
  if ([".log", ".txt"].includes(ext)) return "log";
  return "data";
}

/**
 * Walk the python result JSON for absolute file paths inside the run's
 * directory and register each as an artifact served at
 * /artifacts/<runId>/<basename>. Files stay where python wrote them; only
 * the URL mapping is recorded. Paths outside the run dir are left untouched
 * (they are not servable and blabctl's contract is to write into --run-dir).
 */
function ingestSummaryArtifacts(run: Run, summary: unknown) {
  const dir = path.resolve(runDir(run.id));
  const seen = new Set(run.artifacts.map((a) => a.name));
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (!path.isAbsolute(value)) return;
      let resolved: string;
      try {
        resolved = path.resolve(value);
      } catch {
        return;
      }
      const rel = path.relative(dir, resolved);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return;
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return;
      // URL must keep the path relative to the run dir — solve plots live in
      // a plots/ subdir and a basename-only URL 404s.
      const relUrlPath = rel.split(path.sep).map(encodeURIComponent).join("/");
      const basename = path.basename(resolved);
      if (seen.has(relUrlPath)) return;
      seen.add(relUrlPath);
      run.artifacts.push({
        name: basename,
        kind: classify(basename),
        url: `/artifacts/${run.id}/${relUrlPath}`,
      });
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(summary);
}

/** Register the raw process log as an artifact (idempotent). */
export function addLogArtifact(id: string) {
  addArtifact(id, { name: "job.log", kind: "log", url: artifactUrl(id, "job.log") });
}

/** Resolve when the run reaches a terminal status, or when timeoutMs elapses. */
export function waitForTerminal(id: string, timeoutMs: number): Promise<Run | undefined> {
  return new Promise((resolve) => {
    const check = () => {
      const run = getRun(id);
      if (!run || TERMINAL.has(run.status)) {
        cleanup();
        resolve(run);
      }
    };
    const onChange = ({ runId }: { runId?: string }) => {
      if (runId === undefined || runId === id) check();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(getRun(id));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off("change", onChange);
    };
    emitter.on("change", onChange);
    check();
  });
}
