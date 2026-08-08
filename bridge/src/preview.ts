/**
 * Live mesh preview: the geometry loop behind the mesh editor.
 *
 * Deliberately outside the job queue. A preview is not a job — it produces no
 * board row, no run directory and no artifacts anybody keeps, and it must not
 * wait behind a queued solve. It is a cheap, throwaway, CPU-only render of
 * "what would this parameter set look like", answered in ~0.2 s.
 *
 * Three things make that latency possible:
 *   - one warm python worker (bridge/py/mesh_preview_worker.py) holds the
 *     gmsh/meshio imports, which otherwise dominate the round trip;
 *   - exactly one request is in flight at a time (gmsh is not reentrant), with
 *     at most one QUEUED request per session — a newer edit supersedes the
 *     older one instead of queueing behind it, so dragging a slider costs one
 *     regeneration per settle, not one per pixel;
 *   - results land in a per-session scratch directory the browser fetches from
 *     directly, so a 400 KB STL never travels through JSON.
 *
 * Lifecycle: the worker starts on the first preview and is shut down again
 * after `config.previewIdleSeconds` of silence, or once it has served
 * RECYCLE_AFTER requests — a bounded lifetime is the cheap defence against a
 * long editing session accumulating gmsh state.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { config } from "./config.ts";
import { killTree } from "./queue.ts";

/** Scratch generations kept per session — enough that the browser can still fetch the one it is drawing. */
const KEEP_GENERATIONS = 3;
/** Sessions untouched for this long are swept from disk. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Requests served before the worker is recycled. */
const RECYCLE_AFTER = 200;
/** A single preview that takes longer than this means the worker is wedged. */
const REQUEST_TIMEOUT_MS = 90_000;

/** Session ids come from the browser, and name a directory. Keep them boring. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The only two files the worker produces, and so the only two we will serve. */
const SERVABLE = new Set(["preview_walls.stl", "preview_driven.stl"]);

export class PreviewError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface PreviewResult {
  superseded?: true;
  seq: number;
  wallsUrl: string | null;
  drivenUrl: string | null;
  triangles: number;
  vertices: number | null;
  bboxMm: number[] | null;
  mirrorAxes: string[];
  qualityWarning: string | null;
  vramBytes: number | null;
  elapsedMs: number;
  /** Full parameter set after the generator's schema defaults were applied. */
  params: Record<string, unknown>;
}

interface WorkerResponse {
  id?: number;
  ok?: boolean;
  error?: string;
  walls?: string | null;
  driven?: string | null;
  triangles?: number;
  vertices?: number | null;
  bbox_mm?: number[] | null;
  mirror_axes?: string[];
  quality_warning?: string | null;
  vram_bytes?: number | null;
  elapsed_ms?: number;
  params?: Record<string, unknown>;
}

interface PendingRequest {
  sessionId: string;
  generator: string;
  params: Record<string, unknown>;
  resolve: (result: PreviewResult) => void;
  reject: (err: Error) => void;
}

const previewRoot = () => path.join(config.dataDir, "preview");

// ---------------------------------------------------------------- sessions ---

interface Session {
  seq: number;
  touchedAt: number;
}
const sessions = new Map<string, Session>();

function sessionDir(sessionId: string) {
  return path.join(previewRoot(), sessionId);
}

function assertSessionId(sessionId: unknown): string {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId))
    throw new PreviewError("sessionId must match [A-Za-z0-9_-]{1,64}");
  return sessionId;
}

/** Drop one editor's scratch geometry. Called when the editor closes. */
export function dropSession(sessionId: string) {
  sessions.delete(sessionId);
  fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
}

/**
 * Sweep sessions no editor has touched in a while. Browsers close without
 * warning, so the DELETE on unmount is a courtesy, never the guarantee.
 */
function sweepSessions() {
  const now = Date.now();
  for (const [id, session] of sessions)
    if (now - session.touchedAt > SESSION_TTL_MS) dropSession(id);
  // Directories with no live session (left by a previous bridge process).
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(previewRoot(), { withFileTypes: true });
  } catch {
    return; // nothing generated yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || sessions.has(entry.name)) continue;
    fs.rmSync(path.join(previewRoot(), entry.name), { recursive: true, force: true });
  }
}

/** Keep only the newest few generations, so a long session is O(1) on disk. */
function pruneGenerations(sessionId: string, currentSeq: number) {
  const dir = sessionDir(sessionId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const seq = Number(entry);
    if (!Number.isFinite(seq) || seq > currentSeq - KEEP_GENERATIONS) continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Resolve a preview artifact URL to a file on disk, or null.
 *
 * The three components are validated rather than merely joined: `sessionId`
 * and `seq` are shapes, `file` is an allowlist, and the result is still
 * containment-checked. This path is reachable by anything that can talk to the
 * bridge, and it names a directory chosen by the caller.
 */
export function resolvePreviewFile(sessionId: string, seq: string, file: string): string | null {
  if (!SESSION_ID_RE.test(sessionId) || !/^\d{1,12}$/.test(seq) || !SERVABLE.has(file)) return null;
  const dir = path.resolve(sessionDir(sessionId), seq);
  const resolved = path.resolve(dir, file);
  if (path.relative(dir, resolved) !== file) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

// ------------------------------------------------------------------ worker ---

interface Worker {
  child: ChildProcess;
  rl: readline.Interface;
  served: number;
  /** Tail of the worker's stderr, so an unexplained exit says why. */
  lastStderr: string;
}

let worker: Worker | null = null;
let inFlight: { id: number; seq: number; request: PendingRequest; timer: NodeJS.Timeout } | null =
  null;
/** At most one waiting request per session; a newer edit replaces the older. */
const queued = new Map<string, PendingRequest>();
let nextRequestId = 1;
let idleTimer: NodeJS.Timeout | null = null;

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stopWorker(), config.previewIdleSeconds * 1000);
  idleTimer.unref?.();
}

function stopWorker(reason?: string) {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = worker;
  worker = null;
  if (!current) return;
  current.rl.close();
  killTree(current.child);
  if (reason && inFlight) failInFlight(new PreviewError(reason, 503));
}

function failInFlight(err: Error) {
  const current = inFlight;
  inFlight = null;
  if (!current) return;
  clearTimeout(current.timer);
  current.request.reject(err);
}

function startWorker(): Worker {
  const child = spawn(config.python, [config.previewWorker], {
    cwd: config.repoRoot,
    env: {
      ...process.env,
      ...(config.juliaExecutable
        ? { BLAB_JULIA_EXECUTABLE: config.juliaExecutable, BLAB_JULIA_EXE: config.juliaExecutable }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(process.platform === "win32" ? {} : { detached: true }),
  });

  const rl = readline.createInterface({ input: child.stdout! });
  const started: Worker = { child, rl, served: 0, lastStderr: "" };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let message: WorkerResponse;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // a stray non-NDJSON line is not fatal
    }
    if (message.id === undefined || message.id === null) return; // {"event":"ready"} and friends
    onResponse(started, message);
  });

  // gmsh, meshio and Ath all write to stderr constantly, and none of it is
  // interesting while previews are succeeding. Drain the pipe (an unread one
  // eventually blocks the child) and keep only the tail, which is the only
  // explanation available if the worker dies mid-request.
  child.stderr?.on("data", (chunk: Buffer) => {
    started.lastStderr = (started.lastStderr + chunk.toString()).slice(-2000);
  });
  child.on("error", (err) => {
    if (worker === started) worker = null;
    failInFlight(new PreviewError(`failed to spawn ${config.python}: ${err.message}`, 503));
  });
  child.on("close", (code) => {
    if (worker === started) worker = null;
    const tail = started.lastStderr.trim().split(/\r?\n/).slice(-3).join(" / ");
    failInFlight(
      new PreviewError(
        `preview worker exited (code ${code}) before answering${tail ? ` — ${tail}` : ""}`,
        503,
      ),
    );
    pump();
  });

  return started;
}

function ensureWorker(): Worker {
  if (!worker || worker.child.exitCode !== null || worker.child.signalCode !== null) {
    worker = startWorker();
  }
  armIdleTimer();
  return worker;
}

function onResponse(from: Worker, message: WorkerResponse) {
  const current = inFlight;
  if (!current || current.id !== message.id) return; // a superseded/timed-out reply
  inFlight = null;
  clearTimeout(current.timer);
  from.served += 1;

  const { request, seq } = current;
  if (message.ok !== true) {
    request.reject(new PreviewError(message.error || "preview failed", 422));
  } else {
    const base = `/api/preview/${request.sessionId}/${seq}/`;
    request.resolve({
      seq,
      wallsUrl: message.walls ? `${base}${path.basename(message.walls)}` : null,
      drivenUrl: message.driven ? `${base}${path.basename(message.driven)}` : null,
      triangles: message.triangles ?? 0,
      vertices: message.vertices ?? null,
      bboxMm: message.bbox_mm ?? null,
      mirrorAxes: message.mirror_axes ?? [],
      qualityWarning: message.quality_warning ?? null,
      vramBytes: message.vram_bytes ?? null,
      elapsedMs: message.elapsed_ms ?? 0,
      params: message.params ?? {},
    });
    pruneGenerations(request.sessionId, seq);
  }

  if (from.served >= RECYCLE_AFTER && queued.size === 0) stopWorker();
  pump();
}

/** Send the oldest waiting request, if the worker is free. */
function pump() {
  if (inFlight || queued.size === 0) return;
  const [sessionId, request] = queued.entries().next().value as [string, PendingRequest];
  queued.delete(sessionId);

  const session = sessions.get(sessionId);
  if (!session) return pump(); // session was dropped while waiting

  session.seq += 1;
  session.touchedAt = Date.now();
  const outDir = path.join(sessionDir(sessionId), String(session.seq));

  let active: Worker;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    active = ensureWorker();
  } catch (err) {
    request.reject(new PreviewError(err instanceof Error ? err.message : String(err), 503));
    return pump();
  }

  const id = nextRequestId++;
  const seq = session.seq;
  const timer = setTimeout(() => {
    // A wedged gmsh must not wedge the editor: drop the worker, let the next
    // edit start a fresh one.
    stopWorker();
    failInFlight(new PreviewError("preview timed out", 504));
    pump();
  }, REQUEST_TIMEOUT_MS);
  timer.unref?.();
  inFlight = { id, seq, request, timer };

  active.child.stdin!.write(
    JSON.stringify({ id, generator: request.generator, params: request.params, out: outDir }) + "\n",
  );
}

/**
 * Render one parameter set. Resolves with `{superseded: true}` when a newer
 * edit from the same session overtook this one before it ever ran — the caller
 * has already moved on, and regenerating geometry nobody will look at is the
 * whole thing this loop exists to avoid.
 */
export async function requestPreview(input: {
  sessionId: string;
  generator: string;
  params?: Record<string, unknown>;
}): Promise<PreviewResult> {
  const sessionId = assertSessionId(input.sessionId);
  if (typeof input.generator !== "string" || !input.generator)
    throw new PreviewError("generator (string) is required");

  let session = sessions.get(sessionId);
  if (!session) {
    sweepSessions();
    session = { seq: 0, touchedAt: Date.now() };
    sessions.set(sessionId, session);
  }
  session.touchedAt = Date.now();

  return new Promise<PreviewResult>((resolve, reject) => {
    const superseded = queued.get(sessionId);
    if (superseded)
      superseded.resolve({
        superseded: true,
        seq: -1,
        wallsUrl: null,
        drivenUrl: null,
        triangles: 0,
        vertices: null,
        bboxMm: null,
        mirrorAxes: [],
        qualityWarning: null,
        vramBytes: null,
        elapsedMs: 0,
        params: {},
      });
    queued.set(sessionId, {
      sessionId,
      generator: input.generator,
      params: input.params ?? {},
      resolve,
      reject,
    });
    pump();
  });
}

/** Bridge shutdown: kill the worker tree and take the scratch geometry with it. */
export function shutdownPreview() {
  queued.clear();
  stopWorker("bridge shutdown");
  fs.rmSync(previewRoot(), { recursive: true, force: true });
}
