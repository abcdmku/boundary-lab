/**
 * Dispatching a solve to a rented GPU: how a `vast:<id>` target resolves
 * through the instance registry, the job record it produces, the argv blabctl
 * actually receives, and the guards that stop a job being queued against a box
 * that cannot take it.
 *
 * The registry is wired to the generic target machinery by
 * `src/vast/targets.ts` — this suite exercises that seam end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-vast-target-"));
process.env.DATA_DIR = path.join(tempDir, "data");
process.env.VAST_API_KEY_FILE = path.join(tempDir, "no-such-key");

const store = await import("../src/store.ts");
const actions = await import("../src/actions.ts");
const queue = await import("../src/queue.ts");
const targets = await import("../src/targets.ts");
const registry = await import("../src/vast/registry.ts");
const { registerVastTargets } = await import("../src/vast/targets.ts");
import type { ManagedInstance } from "../src/vast/types.ts";

store.loadStore();
registerVastTargets();

const INSTANCE_ID = 20250806;
const TARGET_ID = `vast:${INSTANCE_ID}`;
const SERVER_URL = "http://65.130.162.74:33526";

const reset = () => {
  for (const entry of registry.list()) registry.forget(entry.id);
  queue.resetLanes();
};

const seed = (overrides: Partial<ManagedInstance> = {}): ManagedInstance =>
  registry.add({
    id: INSTANCE_ID,
    label: "boundary-lab-solver",
    status: "ready",
    gpuName: "RTX 4090",
    numGpus: 1,
    pricePerHour: 0.3421,
    offerId: 11223344,
    image: "nvidia/cuda:12.6.3-runtime-ubuntu24.04",
    diskGb: 60,
    solverPort: 8765,
    serverUrl: SERVER_URL,
    ssh: null,
    createdAt: new Date().toISOString(),
    provisionedAt: new Date().toISOString(),
    error: null,
    progress: null,
    lastHealth: { checkedAt: new Date().toISOString(), ok: true },
    live: null,
    ...overrides,
  });

/** A completed mesh job to hang solves off. */
function meshJob(): string {
  const mesh = store.createJob({ kind: "mesh", name: "test mesh", params: {} });
  store.finishJob(mesh.id, { status: "done" });
  return mesh.id;
}

const throwsWith = (fn: () => unknown, status: number, pattern: RegExp) =>
  assert.throws(fn, (err: Error & { status?: number }) => {
    assert.equal(err.status, status, err.message);
    assert.match(err.message, pattern);
    return true;
  });

// ---------------------------------------------------------------------------
// target resolution
// ---------------------------------------------------------------------------

test("local is the default and needs no remote", () => {
  for (const input of [undefined, null, "", "local", "  local  "]) {
    assert.deepEqual(targets.normalizeTarget(input), { type: "local" }, `input ${JSON.stringify(input)}`);
  }
});

test("a ready, healthy vast instance resolves to its server URL", () => {
  reset();
  seed();
  assert.deepEqual(targets.normalizeTarget(TARGET_ID), {
    type: "remote",
    instanceId: TARGET_ID,
    serverUrl: SERVER_URL,
    label: "RTX 4090 — boundary-lab-solver",
  });
});

test("an explicit http(s) URL is accepted as an escape hatch", () => {
  assert.deepEqual(targets.normalizeTarget("http://192.168.1.50:8765/"), {
    type: "remote",
    serverUrl: "http://192.168.1.50:8765",
  });
});

test("an unmanaged vast instance is a 404", () => {
  reset();
  throwsWith(() => actions.startSolve({ meshJobId: meshJob(), target: "vast:999999" }), 404, /unknown target/);
});

test("an unprovisioned instance is refused with instructions, not queued", () => {
  reset();
  seed({ status: "provisioning", lastHealth: null });
  throwsWith(
    () => actions.startSolve({ meshJobId: meshJob(), target: TARGET_ID }),
    409,
    /provision it first/,
  );
});

test("a ready instance that has failed its health check is refused", () => {
  reset();
  seed({ lastHealth: { checkedAt: new Date().toISOString(), ok: false, error: "connection refused" } });
  throwsWith(() => actions.startSolve({ meshJobId: meshJob(), target: TARGET_ID }), 409, /connection refused/);
});

test("a stopped instance cannot take work", () => {
  reset();
  seed({ status: "stopped", serverUrl: null });
  throwsWith(() => actions.startSolve({ meshJobId: meshJob(), target: TARGET_ID }), 409, /not ready/);
});

test("a destroyed instance is gone, not merely unavailable", () => {
  reset();
  seed({ status: "destroyed" });
  assert.equal(
    targets.listTargets().some((t) => t.id === TARGET_ID),
    false,
    "destroyed instances are not listed at all",
  );
});

test("a malformed target is rejected", () => {
  reset();
  for (const input of ["vast:", "vast:abc", "remote", "ftp://x", "vast:1:2"]) {
    assert.throws(() => targets.normalizeTarget(input), /unknown target/, input);
  }
});

test("an unavailable instance is still LISTED, with the reason", () => {
  reset();
  seed({ status: "provisioning", lastHealth: null });
  const target = targets.listTargets().find((t) => t.id === TARGET_ID)!;
  assert.equal(target.available, false);
  assert.match(target.unavailableReason!, /provision it first/);
  assert.equal(target.info!.pricePerHour, 0.3421, "cost is visible so a UI can show what is burning");
});

// ---------------------------------------------------------------------------
// the job record + dispatch argv
// ---------------------------------------------------------------------------

test("a local solve records the local target and keeps the caller's backend", () => {
  reset();
  const job = actions.startSolve({
    meshJobId: meshJob(),
    options: { backend: "beat_cuda", fmin: 200, count: 10 },
  });
  assert.deepEqual(job.target, { type: "local" });
  assert.equal(job.params.backend, "beat_cuda");
  assert.equal(queue.laneKeyFor(job), "local:solve");
});

test("a vast solve records the instance id and its server URL", () => {
  reset();
  seed();
  const job = actions.startSolve({
    meshJobId: meshJob(),
    target: TARGET_ID,
    options: { fmin: 200, fmax: 2000, count: 10 },
  });
  assert.equal(job.target!.type, "remote");
  assert.equal((job.target as { instanceId?: string }).instanceId, TARGET_ID);
  assert.equal((job.target as { serverUrl: string }).serverUrl, SERVER_URL);
  // Its own lane: a rented box runs in parallel with the local GPU.
  assert.equal(queue.laneKeyFor(job), `remote:${TARGET_ID}`);
});

test("a remote solve drops the caller's backend, which belongs to the server", () => {
  reset();
  seed();
  const job = actions.startSolve({
    meshJobId: meshJob(),
    target: TARGET_ID,
    options: { backend: "beat_cuda" },
  });
  // blabctl rejects --server-url unless the backend is `server`.
  assert.equal(queue.buildArgs(store.getJob(job.id)!).includes("beat_cuda"), false);
});

test("an unusable target fails the request instead of queueing a doomed job", () => {
  reset();
  seed({ status: "error", lastHealth: null });
  const mesh = meshJob();
  const before = store.listJobs().filter((job) => job.kind === "solve").length;
  assert.throws(() => actions.startSolve({ meshJobId: mesh, target: TARGET_ID }));
  // The target is resolved before the job record is created, so a refusal
  // leaves nothing behind to fail an hour later.
  assert.equal(
    store.listJobs().filter((job) => job.kind === "solve").length,
    before,
    "no solve job may have been created",
  );
});

test("a remote solve is dispatched to blabctl as --backend server --server-url", () => {
  reset();
  seed();
  const job = actions.startSolve({
    meshJobId: meshJob(),
    target: TARGET_ID,
    options: { fmin: 200, fmax: 2000, count: 10, symmetry: "xy" },
  });
  const args = queue.buildArgs(store.getJob(job.id)!);
  const backendIndex = args.indexOf("--backend");
  assert.ok(backendIndex >= 0, "a remote solve must pin the backend");
  assert.equal(args[backendIndex + 1], "server");
  assert.equal(args[args.indexOf("--server-url") + 1], SERVER_URL);
  // Exactly one --backend: a duplicate would make blabctl take the wrong one.
  assert.equal(args.filter((arg) => arg === "--backend").length, 1);
  // The local Julia path is meaningless for a solve running elsewhere.
  assert.ok(!args.includes("--julia-exe"));
  // Ordinary solve options still ride along.
  assert.equal(args[args.indexOf("--fmin") + 1], "200");
  assert.equal(args[args.indexOf("--count") + 1], "10");
  assert.equal(args[args.indexOf("--symmetry") + 1], "xy");
});

// ---------------------------------------------------------------------------
// batching across rented boxes
// ---------------------------------------------------------------------------

test("a draft may be staged against an instance that is not ready yet", () => {
  reset();
  seed({ status: "provisioning", lastHealth: null });
  // Staging is allowed against a raw URL even while the box provisions; the
  // readiness check is what LAUNCH enforces.
  const draft = actions.createDraft({ kind: "solve", meshJobId: meshJob(), target: SERVER_URL });
  assert.equal(draft.status, "draft");
});

test("a sweep can fan out across several rented boxes, one lane each", () => {
  reset();
  seed();
  registry.add({ ...seed(), id: 20250807, label: "second", serverUrl: "http://10.0.0.9:8765" });
  const result = actions.createBatch({
    kind: "solve",
    meshJobId: meshJob(),
    variants: [{ target: TARGET_ID }, { target: "vast:20250807" }, {}],
  });
  assert.deepEqual(result.jobs.map((job) => queue.laneKeyFor(job)), [
    `remote:${TARGET_ID}`,
    "remote:vast:20250807",
    "local:solve",
  ]);
});
