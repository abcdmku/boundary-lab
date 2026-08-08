/**
 * Domain state: projects, and the job ledger underneath them.
 *
 * A job is one unit of work — a mesh generation ('mesh') or a BEM solve
 * ('solve'). Jobs exist BEFORE they run: a job created as a `draft` is fully
 * configured (params, execution target, project grouping) but is never enqueued
 * until it is explicitly launched. That is what lets the UI show "10 meshes
 * ready" and a rack of configured-but-unstarted solves.
 *
 * The shape the domain actually has, and which this file now models directly:
 *
 *   project ──┬── mesh (root)         the geometry family being explored
 *             │     ├── mesh variant  same design, different params
 *             │     └── mesh variant
 *             └── each mesh ── many solves   coarse preview, fine verification,
 *                                            symmetry on/off, a remote rerun …
 *
 * One mesh having MANY solves is the normal case, not the exception: `solve`
 * jobs carry `parentJobId` = the mesh they read. Mesh variants carry
 * `variantOf` = the mesh they were derived from, so an optimization campaign's
 * twenty trial geometries read as one lineage instead of twenty unrelated jobs.
 *
 * `priority` is the scheduling order — see queue.ts. It is persisted (not just
 * an in-memory queue index) so a hand-arranged run order survives a restart.
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
 *   v3              — { version: 3, jobs, projects: Project[] }, job.projectId,
 *                       job.variantOf (mesh lineage), job.priority (run order).
 *                       batchId/batchName are kept as the record of which one
 *                       request created a job; grouping moved to projects.
 * loadStore() migrates in place, oldest → newest, after backing the old file up.
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

/**
 * A design being explored: the family a mesh, its variants and all their
 * solves belong to. Projects hold no configuration of their own — they are
 * the unit the human (and the optimization loop) thinks in, and the unit the
 * UI groups by. Deleting one never deletes jobs; it only unassigns them.
 */
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt?: string;
  /** What this design is trying to achieve — free text, shown on the card. */
  goal?: string;
  /** Index into the UI's accent palette; purely cosmetic. */
  color?: number;
  /** Archived projects stay queryable but drop out of the default view. */
  archived?: boolean;
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
  /** The design this job belongs to. Absent = unassigned (see listProjects). */
  projectId?: string;
  /**
   * Mesh jobs only: the mesh this one is a variant of. Absent on a root mesh.
   * A variant is a re-generation of the same design with different params —
   * exactly what an optimization campaign produces one trial at a time.
   */
  variantOf?: string;
  /**
   * Scheduling order within an execution lane; lower runs first. Persisted so
   * a hand-arranged order survives a bridge restart. Absent = "wherever the
   * creation order puts it" (normalizePriorities backfills on load).
   */
  priority?: number;
  /** Optional grouping so one create request can be listed / cancelled together. */
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

export const STATE_VERSION = 3;

interface PersistedState {
  version: number;
  jobs: Job[];
  projects: Project[];
  /**
   * Feature-owned top-level sections (see readSection/writeSection). Keeps
   * state.json a single file with a single atomic writer while letting modules
   * like vast/ own their own slice without this file knowing the shape.
   */
  [section: string]: unknown;
}

/** Keys this file owns; everything else in state.json is a feature section. */
const RESERVED_KEYS = new Set(["version", "jobs", "runs", "projects"]);

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

/**
 * Priorities are spaced rather than consecutive so a drag-and-drop reorder can
 * drop a job BETWEEN two others by taking the midpoint, without renumbering
 * the rest of the lane. reorderPriorities() re-spaces when the gap closes.
 */
export const PRIORITY_STEP = 1000;

/**
 * Where the planned backlog numbers from. Deliberately far above any lane's
 * numbering so that launching a draft APPENDS to its lane rather than jumping
 * the queue: the backlog's internal order is meaningful, its position relative
 * to already-queued work is not. An explicit drop position still wins — that
 * path renumbers the destination lane (see queue.place).
 */
export const BACKLOG_PRIORITY_BASE = 1_000_000;

export const emitter = new EventEmitter();
emitter.setMaxListeners(200);

let state: PersistedState = { version: STATE_VERSION, jobs: [], projects: [] };

/**
 * v2 -> v3: give the existing ledger the structure it always implied.
 *
 * A v2 *mesh* batch was already a family of variants — one generator, one set
 * of base params, N param overrides — so each such batch becomes a project,
 * its oldest mesh becomes the lineage root and the rest become that root's
 * variants. Solves inherit their mesh's project, because a solve belongs to
 * whatever design its mesh belongs to.
 *
 * Nothing is invented beyond that: meshes created one at a time stay
 * unassigned (the UI shows them in an "Unassigned" bucket) rather than being
 * scattered into a project each, which would be noise dressed up as structure.
 */
function adoptV3Structure(jobs: Job[]): Project[] {
  const projects: Project[] = [];
  const oldest = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const meshBatches = new Map<string, Job[]>();
  for (const job of oldest) {
    if (job.kind !== "mesh" || !job.batchId) continue;
    const list = meshBatches.get(job.batchId);
    if (list) list.push(job);
    else meshBatches.set(job.batchId, [job]);
  }

  for (const [batchId, meshes] of meshBatches) {
    // A one-mesh "batch" is not a family; leave it unassigned like any other
    // standalone mesh.
    if (meshes.length < 2) continue;
    const project: Project = {
      id: `p_${batchId.replace(/^b_/, "")}`,
      name: meshes[0]!.batchName?.trim() || `${meshes[0]!.generator ?? "mesh"} sweep`,
      createdAt: meshes[0]!.createdAt,
    };
    projects.push(project);
    const [root, ...rest] = meshes;
    root!.projectId = project.id;
    for (const variant of rest) {
      variant.projectId = project.id;
      // Never overwrite a lineage that is already recorded — a half-migrated
      // or hand-edited ledger must not have its real parentage flattened.
      variant.variantOf ??= root!.id;
    }
  }

  const projectOfMesh = new Map(oldest.filter((j) => j.kind === "mesh").map((j) => [j.id, j.projectId]));
  for (const job of oldest) {
    if (job.kind !== "solve" || job.projectId) continue;
    const owner = projectOfMesh.get(String(job.parentJobId ?? job.params?.meshJobId ?? ""));
    if (owner) job.projectId = owner;
  }

  // Creation order IS the historical run order; make it explicit so the
  // schedule board has something stable to sort by from the first render.
  oldest.forEach((job, i) => {
    if (typeof job.priority !== "number") job.priority = (i + 1) * PRIORITY_STEP;
  });
  return projects;
}

/** Exported for tests: turn any persisted shape into the current one. */
export function migrateState(raw: unknown): { state: PersistedState; migratedFrom: number | null } {
  const obj = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : 1;
  // Feature sections (vast/, …) are owned by other modules and pass through
  // untouched. Dropping them here would silently destroy, say, the record of
  // which cloud instances are rented and billing by the second.
  const sections = Object.fromEntries(
    Object.entries(obj).filter(([key]) => !RESERVED_KEYS.has(key)),
  );
  const projects = Array.isArray(obj.projects) ? (obj.projects as Project[]) : [];
  if (version >= STATE_VERSION && Array.isArray(obj.jobs)) {
    return {
      state: { ...sections, version: STATE_VERSION, jobs: obj.jobs as Job[], projects },
      migratedFrom: null,
    };
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
  // v2 -> v3 runs for v1 records too: they pass through the v2 shape on the
  // way, and a one-shot load must not leave half a migration behind.
  const adopted = adoptV3Structure(jobs);
  return {
    state: { ...sections, version: STATE_VERSION, jobs, projects: [...projects, ...adopted] },
    migratedFrom: version,
  };
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

// ---------- projects ----------
/** Oldest first — a project list reads as the order the designs were started. */
export const listProjects = (): Project[] =>
  [...state.projects].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export const getProject = (id: string) => state.projects.find((p) => p.id === id);

export function createProject(input: { name: string; goal?: string; color?: number }): Project {
  const project: Project = {
    id: `p_${Math.random().toString(36).slice(2, 10)}`,
    name: input.name,
    createdAt: now(),
    ...(input.goal ? { goal: input.goal } : {}),
    ...(typeof input.color === "number" ? { color: input.color } : {}),
  };
  state.projects.push(project);
  persist();
  changed();
  return project;
}

export function updateProject(
  id: string,
  patch: { name?: string; goal?: string | null; color?: number; archived?: boolean },
): Project | undefined {
  const project = getProject(id);
  if (!project) return undefined;
  if (patch.name !== undefined) project.name = patch.name;
  if (patch.goal !== undefined) {
    if (patch.goal === null) delete project.goal;
    else project.goal = patch.goal;
  }
  if (patch.color !== undefined) project.color = patch.color;
  if (patch.archived !== undefined) project.archived = patch.archived;
  project.updatedAt = now();
  persist();
  changed();
  return project;
}

/**
 * Forget a project. Its jobs are UNASSIGNED, never deleted — a project is a
 * label on work that took GPU-hours to produce, and dropping the label must
 * not drop the work. Returns how many jobs were unassigned.
 */
export function removeProject(id: string): number {
  const i = state.projects.findIndex((p) => p.id === id);
  if (i < 0) return 0;
  state.projects.splice(i, 1);
  let unassigned = 0;
  for (const job of state.jobs) {
    if (job.projectId !== id) continue;
    delete job.projectId;
    unassigned++;
  }
  persist();
  changed();
  return unassigned;
}

/** Every job in a project, oldest first. */
export const listProjectJobs = (projectId: string) =>
  state.jobs
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Solves that read this mesh, oldest first. The many side of one-mesh-many-solves. */
export const listSolvesOfMesh = (meshJobId: string) =>
  state.jobs
    .filter(
      (j) =>
        j.kind === "solve" &&
        (j.parentJobId === meshJobId || j.params?.meshJobId === meshJobId),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Meshes derived from this mesh, oldest first. */
export const listVariantsOfMesh = (meshJobId: string) =>
  state.jobs
    .filter((j) => j.kind === "mesh" && j.variantOf === meshJobId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

// ---------- scheduling order ----------
/** Priority that puts a job at the end of everything currently known. */
export function nextPriority(): number {
  let max = 0;
  for (const job of state.jobs) if (typeof job.priority === "number" && job.priority > max) max = job.priority;
  return max + PRIORITY_STEP;
}

/** Effective priority of a job — creation order is the implicit default. */
export const priorityOf = (job: Job): number =>
  typeof job.priority === "number" ? job.priority : Number.MAX_SAFE_INTEGER;

/**
 * Write an explicit order onto a list of jobs. Callers pass the ids in the
 * order they should run; this re-spaces them by PRIORITY_STEP starting from
 * `startAt` so later midpoint inserts have room again.
 */
export function reorderPriorities(orderedIds: string[], startAt = PRIORITY_STEP) {
  orderedIds.forEach((id, i) => {
    const job = getJob(id);
    if (job) job.priority = startAt + i * PRIORITY_STEP;
  });
  persist();
  changed();
}

export function setPriority(id: string, priority: number) {
  const job = getJob(id);
  if (!job) return;
  job.priority = priority;
  persist();
  changed(id);
}

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
 * Replace a feature-owned section and persist. Emits a change with no jobId,
 * which the SSE stream turns into a full-state push — so UI clients see
 * section updates on the same live channel as jobs.
 *
 * Persists synchronously rather than on the debounce: sections track things
 * like rented cloud instances that cost money by the second, and a crash in
 * the debounce window must never lose the record of one.
 */
export function writeSection(key: string, value: unknown) {
  if (RESERVED_KEYS.has(key)) throw new Error(`"${key}" is not a feature section`);
  state[key] = value;
  try {
    persistNow();
  } catch (err) {
    console.error(`[bridge] failed to persist section "${key}": ${err}`);
  }
  changed();
}

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

// ---------- feature sections ----------
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
  projectId?: string;
  variantOf?: string;
  priority?: number;
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
    priority: input.priority ?? nextPriority(),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.variantOf ? { variantOf: input.variantOf } : {}),
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
    projectId?: string | null;
    variantOf?: string | null;
    priority?: number;
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
  if (patch.priority !== undefined) job.priority = patch.priority;
  if (patch.projectId !== undefined) {
    if (patch.projectId === null) delete job.projectId;
    else job.projectId = patch.projectId;
  }
  if (patch.variantOf !== undefined) {
    if (patch.variantOf === null) delete job.variantOf;
    else job.variantOf = patch.variantOf;
  }
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

/**
 * queued -> draft: put a launched-but-not-started job back on the shelf.
 *
 * The inverse of markQueued, and the reason a mis-aimed sweep does not have to
 * be cancelled and rebuilt — dragging a card out of a lane holds it instead of
 * destroying it. A RUNNING job can never come back this way; its child process
 * has already started, and only cancel() speaks to that.
 */
export function markDraft(id: string): boolean {
  const job = getJob(id);
  if (!job || job.status !== "queued") return false;
  job.status = "draft";
  delete job.launchedAt;
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
  // Re-root any variants of the mesh being removed onto ITS parent, so a
  // deleted middle of a lineage does not orphan everything below it into
  // pointing at an id that no longer resolves.
  const grandparent = state.jobs[i]!.variantOf;
  for (const job of state.jobs) {
    if (job.variantOf !== id) continue;
    if (grandparent) job.variantOf = grandparent;
    else delete job.variantOf;
  }
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
