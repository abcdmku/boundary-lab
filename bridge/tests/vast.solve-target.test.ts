/**
 * Dispatching a solve to a rented GPU: target resolution, the argv blabctl
 * actually receives, and the guards that stop a run being queued against a box
 * that cannot take it.
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
const registry = await import("../src/vast/registry.ts");
const { positiveNumber } = await import("../src/config.ts");
import type { ManagedInstance } from "../src/vast/types.ts";

store.loadStore();

const reset = () => {
  for (const entry of registry.list()) registry.forget(entry.id);
};

const seed = (overrides: Partial<ManagedInstance> = {}): ManagedInstance =>
  registry.add({
    id: 20250806,
    label: "boundary-lab-solver",
    status: "ready",
    gpuName: "RTX 4090",
    numGpus: 1,
    pricePerHour: 0.3421,
    offerId: 11223344,
    image: "nvidia/cuda:12.6.3-runtime-ubuntu24.04",
    diskGb: 60,
    solverPort: 8765,
    serverUrl: "http://65.130.162.74:33526",
    ssh: null,
    createdAt: new Date().toISOString(),
    provisionedAt: new Date().toISOString(),
    error: null,
    progress: null,
    lastHealth: { checkedAt: new Date().toISOString(), ok: true },
    live: null,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// target resolution
// ---------------------------------------------------------------------------

test("local is the default and needs no remote", () => {
  for (const input of [undefined, "", "local", "LOCAL", "  local  "]) {
    const target = actions.resolveSolveTarget(input);
    assert.equal(target.kind, "local", `input ${JSON.stringify(input)}`);
    assert.equal(target.serverUrl, null);
  }
});

test("a ready, healthy vast instance resolves to its server URL", () => {
  reset();
  seed();
  const target = actions.resolveSolveTarget("vast:20250806");
  assert.equal(target.kind, "vast");
  assert.equal(target.serverUrl, "http://65.130.162.74:33526");
});

test("an explicit http(s) URL is accepted as an escape hatch", () => {
  const target = actions.resolveSolveTarget("http://192.168.1.50:8765/");
  assert.equal(target.kind, "url");
  assert.equal(target.serverUrl, "http://192.168.1.50:8765", "the trailing slash is normalized away");
});

test("an unmanaged vast instance is a 404", () => {
  reset();
  assert.throws(
    () => actions.resolveSolveTarget("vast:999999"),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 404);
      assert.match(err.message, /not managed by this bridge/);
      return true;
    },
  );
});

test("an unprovisioned instance is refused with instructions, not queued", () => {
  reset();
  seed({ status: "provisioning", lastHealth: null });
  assert.throws(
    () => actions.resolveSolveTarget("vast:20250806"),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /provision it first/);
      return true;
    },
  );
});

test("a ready instance that has failed its health check is refused", () => {
  reset();
  seed({ lastHealth: { checkedAt: new Date().toISOString(), ok: false, error: "connection refused" } });
  assert.throws(
    () => actions.resolveSolveTarget("vast:20250806"),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /connection refused/);
      return true;
    },
  );
});

test("a stopped instance cannot take work", () => {
  reset();
  seed({ status: "stopped", serverUrl: null });
  assert.throws(() => actions.resolveSolveTarget("vast:20250806"), /not ready/);
});

test("a malformed target is rejected", () => {
  for (const input of ["vast:", "vast:abc", "remote", "ftp://x", "vast:1:2"]) {
    assert.throws(() => actions.resolveSolveTarget(input), /unknown solve target/, input);
  }
});

// ---------------------------------------------------------------------------
// the run record + dispatch argv
// ---------------------------------------------------------------------------

/** A completed mesh run to hang solves off. */
function meshRun(): string {
  const mesh = store.createRun({ kind: "mesh", name: "test mesh", params: {} });
  store.finishRun(mesh.id, { status: "done" });
  return mesh.id;
}

test("a local solve records no target and keeps the caller's backend", () => {
  reset();
  const run = actions.startSolve({
    meshRunId: meshRun(),
    options: { backend: "beat_cuda", fmin: 200, count: 10 },
  });
  assert.equal(run.params.target, undefined);
  assert.equal(run.params.serverUrl, undefined);
  assert.equal(run.params.backend, "beat_cuda");
});

test("a vast solve records the target and its server URL", () => {
  reset();
  seed();
  const run = actions.startSolve({
    meshRunId: meshRun(),
    options: { target: "vast:20250806", fmin: 200, fmax: 2000, count: 10 },
  });
  assert.equal(run.params.target, "vast:20250806");
  assert.equal(run.params.serverUrl, "http://65.130.162.74:33526");
});

test("a remote solve drops the caller's backend, which belongs to the server", () => {
  reset();
  seed();
  const run = actions.startSolve({
    meshRunId: meshRun(),
    options: { target: "vast:20250806", backend: "beat_cuda" },
  });
  // blabctl rejects --server-url unless the backend is `server`.
  assert.equal(run.params.backend, undefined);
});

test("an unusable target fails the request instead of queueing a doomed run", () => {
  reset();
  seed({ status: "error", lastHealth: null });
  const mesh = meshRun();
  const solvesBefore = store.listRuns().filter((run) => run.kind === "solve").length;
  assert.throws(() => actions.startSolve({ meshRunId: mesh, options: { target: "vast:20250806" } }));
  // The target is resolved before the run record is created, so a refusal
  // leaves nothing behind to fail an hour later.
  const solvesAfter = store.listRuns().filter((run) => run.kind === "solve").length;
  assert.equal(solvesAfter, solvesBefore, "no solve run may have been created");
});

test("a remote solve is dispatched to blabctl as --backend server --server-url", () => {
  reset();
  seed();
  const run = actions.startSolve({
    meshRunId: meshRun(),
    options: { target: "vast:20250806", fmin: 200, fmax: 2000, count: 10, symmetry: "xy" },
  });
  const args = queue.buildArgs(store.getRun(run.id)!);
  const backendIndex = args.indexOf("--backend");
  assert.ok(backendIndex >= 0, "a remote solve must pin the backend");
  assert.equal(args[backendIndex + 1], "server");
  assert.equal(args[args.indexOf("--server-url") + 1], "http://65.130.162.74:33526");
  // Exactly one --backend: a duplicate would make blabctl take the wrong one.
  assert.equal(args.filter((arg) => arg === "--backend").length, 1);
  // The local Julia path is meaningless for a solve running elsewhere.
  assert.ok(!args.includes("--julia-exe"));
  // Ordinary solve options still ride along.
  assert.equal(args[args.indexOf("--fmin") + 1], "200");
  assert.equal(args[args.indexOf("--symmetry") + 1], "xy");
});

test("a local solve is dispatched unchanged, with no server flags", () => {
  reset();
  const run = actions.startSolve({
    meshRunId: meshRun(),
    options: { backend: "beat_cuda", fmin: 200 },
  });
  const args = queue.buildArgs(store.getRun(run.id)!);
  assert.ok(!args.includes("--server-url"), "a local solve must not be sent anywhere");
  assert.equal(args[args.indexOf("--backend") + 1], "beat_cuda");
});

test("the local VRAM note is suppressed for a remote solve", () => {
  reset();
  seed();
  const mesh = store.createRun({ kind: "mesh", name: "m", params: {} });
  store.finishRun(mesh.id, {
    status: "done",
    summary: {
      vram: {
        estimate_bytes: { off: 40 * 1024 ** 3 },
        gpu: { name: "RTX 5080", total_bytes: 16 * 1024 ** 3 },
      },
    },
  });
  // Locally this mesh would warn loudly about exceeding 16 GiB.
  assert.match(actions.solveVramNote(mesh.id, { backend: "beat_cuda" }) ?? "", /WARNING/);
  // On a rented box the local card's capacity is irrelevant and the note would
  // be actively misleading.
  assert.equal(actions.solveVramNote(mesh.id, { backend: "beat_cuda", target: "vast:20250806" }), null);
});

// ---------------------------------------------------------------------------
// config hardening
// ---------------------------------------------------------------------------

test("a non-numeric price ceiling falls back instead of becoming NaN", () => {
  // NaN would make every `price > ceiling` comparison false, silently
  // disabling the spend cap — the opposite of what setting it means.
  for (const bad of ["oops", "2.0.0", "-1", "0", "NaN", "Infinity"]) {
    const value = positiveNumber(bad, 2.0, "VAST_MAX_PRICE_PER_HOUR");
    assert.ok(Number.isFinite(value) && value > 0, `${bad} produced ${value}`);
    assert.equal(value, 2.0);
  }
});

test("a valid price ceiling is honoured, and an unset one defaults", () => {
  assert.equal(positiveNumber("0.75", 2.0, "X"), 0.75);
  assert.equal(positiveNumber(undefined, 2.0, "X"), 2.0);
  assert.equal(positiveNumber("   ", 2.0, "X"), 2.0);
});
