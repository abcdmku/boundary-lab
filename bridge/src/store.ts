/**
 * Domain state: the job ledger.
 *
 * A job is one unit of work — a mesh generation ('mesh') or a BEM solve
 * ('solve'). Jobs exist BEFORE they run: a job created as a `draft` is fully
 * configured (params, execution target, batch grouping) but is never enqueued
 * until it is explicitly launched. That is what lets the UI show "10 meshes
 * ready" and a rack of configured-but-unstarted solves.
 *
 * Each job owns a directory DATA_DIR/jobs/<id>/ where blabctl writes its
 * outputs and where job.log accumulates raw process output. This file holds
 * only metadata; heavy artifacts stay on disk and are served by URL.
 *
 * Every mutation fans out over `emitter` ("change", {jobId}) to SSE
 * subscribers so the UI is live, and persists (debounced) to
 * DATA_DIR/state.json.
 *
 * Persisted schema history:
 *   v1 (unversioned) — { runs: Run[] }, run.parentRunId, solve params.meshRunId,
 *                       job directories under DATA_DIR/runs/<id>/
 *   v2              — { version: 2, jobs: Job[] }, job.parentJobId, solve
 *                       params.meshJobId, job.status may be "draft",
 *                       job.target / job.batchId, directories under
 *                       DATA_DIR/jobs/<id>/
 * loadStore() migrates v1 → v2 in place after backing the old file up.
 */
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { config } from "./config.ts";

export type JobKind = "mesh" | "solve";
export type JobStatus = "draft" | "queued" | "running" | "done" | "failed" | "cancelled";
export type ArtifactKind = "preview" | "plot" | "mesh" | "data" | "config" | "log";

/** Where a job executes. Mesh jobs are always local. */
export type JobTarget =
  | { type: "local" }
  | {
      type: "remote";
      /** Registry id of the compute instance (e.g. a vast.ai instance id). */
      instanceId?: string;
      /** Base URL of the remote solver server, passed to blabctl --server-url. */
      serverUrl: string;
      /** Human label for the UI; purely cosmetic. */
      label?: string;
    };

export const LOCAL_TARGET: JobTarget = { type: "local" };

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

export interface Job {
  id: string;
  kind: JobKind;
  name: string;
  status: JobStatus;
  createdAt: string;
  /** Last time the job's configuration was edited (drafts only). */
  updatedAt?: string;
  /** Set when the job left `draft` for `queued`. */
  launchedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  generator?: string;
  params: Record<string, unknown>;
  /** Execution target. Absent means local (v1 records and mesh jobs). */
  target?: JobTarget;
  /** Optional grouping so a sweep can be listed / launched / cancelled together. */
  batchId?: string;
  /** Denormalized display label for the batch (same on every job in it). */
  batchName?: string;
  parentJobId?: string;
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

export const STATE_VERSION = 2;

interface PersistedState {
  version: number;
  jobs: Job[];
}

const stateFile = () => path.join(config.dataDir, "state.json");

/**
 * Root of the per-job directories. v1 called it `runs/`; the first load after
 * the rename moves it to `jobs/`. If that move fails (a file locked by another
 * process, a different volume, …) we keep using the legacy directory for this
 * process rather than losing every artifact — the resolved root is cached.
 */
let jobsRootCache: string | null = null;
/** Set when this process is the one that moved data/runs -> data/jobs. */
let renamedJobDirsFrom: string | null = null;

function jobsRoot(): string {
  if (jobsRootCache !== null) return jobsRootCache;
  const modern = path.join(config.dataDir, "jobs");
  const legacy = path.join(config.dataDir, "runs");
  if (!fs.existsSync(modern) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, modern);
      renamedJobDirsFrom = legacy;
      console.log(`[bridge] migrated job directories ${legacy} -> ${modern}`);
    } catch (err) {
      console.error(
        `[bridge] could not rename ${legacy} -> ${modern} (${err}); continuing to use ${legacy}`,
      );
      jobsRootCache = legacy;
      return legacy;
    }
  }
  jobsRootCache = modern;
  return modern;
}

/** Text files blabctl writes that can embed absolute job-directory paths. */
const PATH_BEARING_EXTS = new Set([".json", ".toml", ".cfg", ".ini", ".txt", ".yaml", ".yml"]);
const MAX_REWRITE_BYTES = 16 * 1024 * 1024;

/**
 * blabctl records ABSOLUTE paths — `result.json`'s cleaned_msh_path, the solve
 * config's mesh reference, and the same strings mirrored into job.summary. A
 * later solve re-reads its mesh job's result.json and checks those paths
 * exist, so moving data/runs -> data/jobs without rewriting them would quietly
 * make every already-generated mesh unsolvable.
 *
 * Rewrites the old root prefix wherever it appears, in each of the three
 * encodings those files use: native separators (TOML), JSON-escaped
 * backslashes, and forward slashes.
 */
function rewriteMovedPaths(oldRoot: string, newRoot: string, jobs: Job[]) {
  const encodings: [string, string][] = [
    [oldRoot, newRoot],
    [oldRoot.split("\\").join("\\\\"), newRoot.split("\\").join("\\\\")],
    [oldRoot.split("\\").join("/"), newRoot.split("\\").join("/")],
  ].filter(([from], i, all) => all.findIndex(([f]) => f === from) === i) as [string, string][];

  const swap = (text: string) => {
    let out = text;
    for (const [from, to] of encodings) if (from !== to) out = out.split(from).join(to);
    return out;
  };

  // 1. the ledger's own copy of those strings
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return swap(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)]));
    return value;
  };
  for (const job of jobs) {
    if (job.summary !== undefined) job.summary = visit(job.summary);
    job.params = visit(job.params) as Record<string, unknown>;
  }

  // 2. the files on disk
  let rewritten = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!PATH_BEARING_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        if (fs.statSync(full).size > MAX_REWRITE_BYTES) continue;
        const text = fs.readFileSync(full, "utf8");
        const next = swap(text);
        if (next !== text) {
          fs.writeFileSync(full, next);
          rewritten++;
        }
      } catch (err) {
        console.error(`[bridge] could not rewrite paths in ${full}: ${err}`);
      }
    }
  };
  walk(newRoot);
  console.log(`[bridge] rewrote embedded ${oldRoot} paths in ${rewritten} file(s)`);
}

export const jobDir = (id: string) => path.join(jobsRoot(), id);
export const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled"]);
/** Statuses that mean "the queue owns this job right now". */
export const ACTIVE: ReadonlySet<JobStatus> = new Set(["queued", "running"]);

export const emitter = new EventEmitter();
emitter.setMaxListeners(200);

let state: PersistedState = { version: STATE_VERSION, jobs: [] };

/** Exported for tests: turn any persisted shape into the current one. */
export function migrateState(raw: unknown): { state: PersistedState; migratedFrom: number | null } {
  const obj = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : 1;
  if (version >= STATE_VERSION && Array.isArray(obj.jobs)) {
    return { state: { version: STATE_VERSION, jobs: obj.jobs as Job[] }, migratedFrom: null };
  }
  // v1: { runs: Run[] }
  const legacy = (Array.isArray(obj.runs) ? obj.runs : Array.isArray(obj.jobs) ? obj.jobs : []) as
    Record<string, unknown>[];
  const jobs: Job[] = legacy.map((r) => {
    const { parentRunId, ...rest } = r as Record<string, unknown> & { parentRunId?: unknown };
    const params = (rest.params ?? {}) as Record<string, unknown>;
    const { meshRunId, ...restParams } = params as Record<string, unknown> & { meshRunId?: unknown };
    const job = {
      ...rest,
      params: {
        ...restParams,
        // solve params: meshRunId -> meshJobId (keep an existing meshJobId if
        // a half-migrated record already has one)
        ...(meshRunId !== undefined && restParams.meshJobId === undefined
          ? { meshJobId: meshRunId }
          : {}),
      },
      ...(parentRunId !== undefined && rest.parentJobId === undefined
        ? { parentJobId: parentRunId }
        : {}),
      artifacts: Array.isArray(rest.artifacts) ? rest.artifacts : [],
    } as unknown as Job;
    // Everything that existed before targets ran on the local machine.
    if (job.target === undefined) job.target = { type: "local" };
    return job;
  });
  return { state: { version: STATE_VERSION, jobs }, migratedFrom: version };
}

export function loadStore() {
  fs.mkdirSync(jobsRoot(), { recursive: true });
  const file = stateFile();
  if (fs.existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      console.error(`[bridge] state.json unreadable, starting fresh: ${err}`);
      raw = null;
    }
    const { state: migrated, migratedFrom } = migrateState(raw);
    if (migratedFrom !== null && migrated.jobs.length > 0) {
      // Never rewrite a populated ledger without a copy of the original.
      const backup = `${file}.v${migratedFrom}.bak`;
      try {
        if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
        console.log(
          `[bridge] migrated state.json v${migratedFrom} -> v${STATE_VERSION} ` +
            `(${migrated.jobs.length} jobs); backup at ${backup}`,
        );
      } catch (err) {
        console.error(`[bridge] could not back up state.json before migrating: ${err}`);
        throw err; // refuse to migrate without a backup
      }
    }
    state = migrated;
  }
  if (renamedJobDirsFrom !== null) {
    rewriteMovedPaths(renamedJobDirsFrom, jobsRoot(), state.jobs);
    renamedJobDirsFrom = null;
  }
  // The queue is in-memory only: anything mid-flight when the bridge died is
  // dead — but its OS process may not be. Reap verified orphans BEFORE the
  // queue accepts work, or a leftover Julia solve and a new one would share
  // the GPU. Drafts were never in the queue, so they survive untouched.
  for (const job of state.jobs) {
    if (job.status === "queued" || job.status === "running") {
      if (job.status === "running" && job.pid) killVerifiedOrphan(job);
      job.status = "failed";
      job.finishedAt = now();
      job.error = "interrupted by bridge restart";
      delete job.pid;
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
 * after verifying the persisted pid still belongs to that job. PIDs get
 * recycled by the OS, so we require the live process's command line to
 * mention both blabctl and this job's id (its --out job directory) before
 * touching it. Synchronous on purpose: runs during loadStore, before the
 * server starts accepting jobs.
 */
function killVerifiedOrphan(job: Job) {
  if (!job.pid) return;
  const cmdline = processCommandLine(job.pid);
  if (cmdline === null) return; // process already gone
  if (!(/blabctl/i.test(cmdline) && cmdline.includes(job.id))) {
    console.warn(
      `[bridge] pid ${job.pid} recorded for job ${job.id} now belongs to another process; leaving it alone`,
    );
    return;
  }
  console.warn(`[bridge] reaping orphaned job process ${job.pid} (job ${job.id})`);
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(job.pid)], {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
    });
  } else {
    // Children are spawned detached (own process group) — kill the group so
    // Julia grandchildren die too, then the leader in case the group is gone.
    try {
      process.kill(-job.pid, "SIGKILL");
    } catch {
      /* group already gone */
    }
    try {
      process.kill(job.pid, "SIGKILL");
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

/** Force any debounced write to land now (shutdown paths, tests). */
export const flushState = () => persistNow();

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
const changed = (jobId?: string) => emitter.emit("change", { jobId });

// ---------- reads ----------
export const getJob = (id: string) => state.jobs.find((j) => j.id === id);

/** Newest first. */
export const listJobs = () =>
  [...state.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** All jobs in a batch, oldest first (creation order within the sweep). */
export const listBatch = (batchId: string) =>
  state.jobs.filter((j) => j.batchId === batchId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Distinct batch ids, newest batch first. */
export function listBatchIds(): string[] {
  const seen = new Map<string, string>();
  for (const job of state.jobs) {
    if (!job.batchId) continue;
    const prev = seen.get(job.batchId);
    if (prev === undefined || job.createdAt < prev) seen.set(job.batchId, job.createdAt);
  }
  return [...seen.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id);
}

// ---------- writes ----------
function newId(): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8);
    if (id.length === 6 && !getJob(id)) return id;
  }
}

/** Batch ids are visibly distinct from job ids so a mixed-up argument fails loudly. */
export const newBatchId = () => `b_${Math.random().toString(36).slice(2, 10)}`;

export function createJob(input: {
  kind: JobKind;
  name: string;
  /** Draft jobs are configured but never enqueued until launchJob(). */
  status?: Extract<JobStatus, "draft" | "queued">;
  generator?: string;
  params: Record<string, unknown>;
  target?: JobTarget;
  batchId?: string;
  batchName?: string;
  parentJobId?: string;
  workspace?: string;
  threadId?: string;
}): Job {
  const job: Job = {
    id: newId(),
    kind: input.kind,
    name: input.name,
    status: input.status ?? "queued",
    createdAt: now(),
    ...(input.generator ? { generator: input.generator } : {}),
    params: input.params,
    target: input.target ?? { type: "local" },
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.batchName ? { batchName: input.batchName } : {}),
    ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    artifacts: [],
  };
  if (job.status === "queued") job.launchedAt = job.createdAt;
  fs.mkdirSync(jobDir(job.id), { recursive: true });
  state.jobs.push(job);
  persist();
  changed(job.id);
  return job;
}

/**
 * Edit a draft's configuration. Only drafts are editable — once a job is
 * queued its params are the contract the child process was (or is about to be)
 * started with. Returns undefined when the job does not exist.
 */
export function updateJob(
  id: string,
  patch: {
    name?: string;
    generator?: string;
    params?: Record<string, unknown>;
    target?: JobTarget;
    batchId?: string | null;
    batchName?: string | null;
    parentJobId?: string;
  },
): Job | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  if (patch.name !== undefined) job.name = patch.name;
  if (patch.generator !== undefined) job.generator = patch.generator;
  if (patch.params !== undefined) job.params = patch.params;
  if (patch.target !== undefined) job.target = patch.target;
  if (patch.parentJobId !== undefined) job.parentJobId = patch.parentJobId;
  if (patch.batchId !== undefined) {
    if (patch.batchId === null) delete job.batchId;
    else job.batchId = patch.batchId;
  }
  if (patch.batchName !== undefined) {
    if (patch.batchName === null) delete job.batchName;
    else job.batchName = patch.batchName;
  }
  job.updatedAt = now();
  persist();
  changed(id);
  return job;
}

/** draft -> queued. Returns false when the job was not a draft. */
export function markQueued(id: string): boolean {
  const job = getJob(id);
  if (!job || job.status !== "draft") return false;
  job.status = "queued";
  job.launchedAt = now();
  delete job.error;
  persist();
  changed(id);
  return true;
}

export function markRunning(id: string) {
  const job = getJob(id);
  if (!job) return;
  job.status = "running";
  job.startedAt = now();
  persist();
  changed(id);
}

/** Record (or clear) the live child pid. Persists immediately — the pid must
 *  be on disk before the child does real work, or a crash right after spawn
 *  would leave an untracked orphan. */
export function setJobPid(id: string, pid: number | undefined) {
  const job = getJob(id);
  if (!job) return;
  if (pid === undefined) delete job.pid;
  else job.pid = pid;
  try {
    persistNow();
  } catch (err) {
    console.error(`[bridge] failed to persist pid for job ${id}: ${err}`);
  }
  changed(id);
}

export function setProgress(id: string, progress: Progress) {
  const job = getJob(id);
  if (!job) return;
  job.progress = progress;
  persist();
  changed(id);
}

export function finishJob(
  id: string,
  outcome: { status: "done" | "failed" | "cancelled"; summary?: unknown; error?: string },
) {
  const job = getJob(id);
  if (!job || TERMINAL.has(job.status)) return;
  job.status = outcome.status;
  job.finishedAt = now();
  if (outcome.summary !== undefined) {
    job.summary = outcome.summary;
    ingestSummaryArtifacts(job, outcome.summary);
  }
  if (outcome.error !== undefined) job.error = outcome.error;
  persist();
  changed(id);
}

export function addArtifact(id: string, artifact: Artifact) {
  const job = getJob(id);
  if (!job) return;
  if (job.artifacts.some((a) => a.name === artifact.name)) return;
  job.artifacts.push(artifact);
  persist();
  changed(id);
}

/**
 * Merge fields into job.summary (object-ifying a non-object summary) —
 * used to lift post-hoc metrics (score, subscores) into the job record.
 * A patch value of `undefined` deletes the key, so a rerun analysis that
 * drops a metric also removes the previously lifted field.
 */
export function mergeSummary(id: string, patch: Record<string, unknown>) {
  const job = getJob(id);
  if (!job) return;
  const base =
    job.summary !== null && typeof job.summary === "object" && !Array.isArray(job.summary)
      ? (job.summary as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  job.summary = merged;
  persist();
  changed(id);
}

/** Remove the job record and its directory. Caller must ensure it is not running. */
export function removeJob(id: string) {
  const i = state.jobs.findIndex((j) => j.id === id);
  if (i < 0) return;
  state.jobs.splice(i, 1);
  fs.rmSync(jobDir(id), { recursive: true, force: true });
  persist();
  changed(id);
}

// ---------- artifact ingest ----------
// NOTE: the URL prefix stays /artifacts/<jobId>/… across the run→job rename.
// Artifact URLs are embedded in already-persisted summaries and in campaign
// logs; changing the path shape would break every recorded link.
const artifactUrl = (jobId: string, basename: string) =>
  `/artifacts/${jobId}/${encodeURIComponent(basename)}`;

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
 * Walk the python result JSON for absolute file paths inside the job's
 * directory and register each as an artifact served at
 * /artifacts/<jobId>/<basename>. Files stay where python wrote them; only
 * the URL mapping is recorded. Paths outside the job dir are left untouched
 * (they are not servable and blabctl's contract is to write into --out).
 */
function ingestSummaryArtifacts(job: Job, summary: unknown) {
  const dir = path.resolve(jobDir(job.id));
  const seen = new Set(job.artifacts.map((a) => a.name));
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
      // URL must keep the path relative to the job dir — solve plots live in
      // a plots/ subdir and a basename-only URL 404s.
      const relUrlPath = rel.split(path.sep).map(encodeURIComponent).join("/");
      const basename = path.basename(resolved);
      if (seen.has(relUrlPath)) return;
      seen.add(relUrlPath);
      job.artifacts.push({
        name: basename,
        kind: classify(basename),
        url: `/artifacts/${job.id}/${relUrlPath}`,
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

/** Resolve when the job reaches a terminal status, or when timeoutMs elapses. */
export function waitForTerminal(id: string, timeoutMs: number): Promise<Job | undefined> {
  return new Promise((resolve) => {
    const check = () => {
      const job = getJob(id);
      if (!job || TERMINAL.has(job.status)) {
        cleanup();
        resolve(job);
      }
    };
    const onChange = ({ jobId }: { jobId?: string }) => {
      if (jobId === undefined || jobId === id) check();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(getJob(id));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off("change", onChange);
    };
    emitter.on("change", onChange);
    check();
  });
}
