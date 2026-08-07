/**
 * Per-target lanes: local work stays strictly serialized (the GPU rule) while
 * remote instances run in parallel — plus the target → blabctl argv mapping.
 */
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-queue-test-"));
process.env.DATA_DIR = dataDir;

const fakeBlabctl = fileURLToPath(new URL("./fixtures/fake-blabctl.mjs", import.meta.url));

let store: typeof import("../src/store.ts");
let queue: typeof import("../src/queue.ts");
let actions: typeof import("../src/actions.ts");
let targets: typeof import("../src/targets.ts");

const remote = (id: string, url: string) => ({ type: "remote" as const, instanceId: id, serverUrl: url });

function doneMesh(): string {
  const job = store.createJob({ kind: "mesh", name: "mesh", generator: "g", params: {} });
  store.finishJob(job.id, { status: "done" });
  return job.id;
}

/** A queued solve job, launched straight into its lane. */
function launchSolve(meshId: string, target: unknown, options = {}) {
  const job = actions.createDraft({ kind: "solve", meshJobId: meshId, target, options });
  actions.launchJobs({ jobIds: [job.id] });
  return store.getJob(job.id)!;
}

const laneOf = (key: string) => queue.queueSnapshot().lanes.find((l) => l.key === key);

before(async () => {
  const { config } = await import("../src/config.ts");
  config.python = process.execPath;
  config.blabctl = fakeBlabctl;
  config.repoRoot = dataDir;
  config.juliaExecutable = "C:/julia/bin/julia.exe";
  process.env.FAKE_DELAY_MS = "400";
  store = await import("../src/store.ts");
  queue = await import("../src/queue.ts");
  actions = await import("../src/actions.ts");
  targets = await import("../src/targets.ts");
  store.loadStore();
});

beforeEach(() => {
  targets.clearTargetProviders();
  queue.resetLanes();
});

describe("lane keys", () => {
  test("kind and target decide the lane", () => {
    assert.equal(queue.laneKeyFor({ kind: "mesh", target: undefined }), "local:mesh");
    // meshing never leaves the bridge host even if a target sneaks in
    assert.equal(queue.laneKeyFor({ kind: "mesh", target: remote("i-1", "http://a") }), "local:mesh");
    assert.equal(queue.laneKeyFor({ kind: "solve", target: { type: "local" } }), "local:solve");
    assert.equal(queue.laneKeyFor({ kind: "solve", target: undefined }), "local:solve");
    assert.equal(queue.laneKeyFor({ kind: "solve", target: remote("i-7", "http://a") }), "remote:i-7");
    // an instance-less pinned URL still gets its own lane
    assert.equal(
      queue.laneKeyFor({ kind: "solve", target: { type: "remote", serverUrl: "http://b:8000" } }),
      "remote:http://b:8000",
    );
  });
});

describe("blabctl argv", () => {
  test("a local solve passes the solver backend and the local Julia", () => {
    const meshId = doneMesh();
    const job = actions.createDraft({
      kind: "solve",
      meshJobId: meshId,
      options: { fmin: 200, fmax: 8000, count: 24, backend: "beat_cuda", symmetry: "xy" },
    });
    const args = queue.buildArgs(store.getJob(job.id)!);
    assert.equal(args[0], "solve");
    assert.deepEqual(args.slice(1, 5), ["--mesh-run", store.jobDir(meshId), "--out", store.jobDir(job.id)]);
    assert.ok(args.includes("--julia-exe"));
    assert.deepEqual(
      [args[args.indexOf("--backend") + 1], args[args.indexOf("--symmetry") + 1]],
      ["beat_cuda", "xy"],
    );
    assert.equal(args.includes("--server-url"), false);
  });

  test("a remote solve becomes --backend server --server-url <url>", () => {
    const job = actions.createDraft({
      kind: "solve",
      meshJobId: doneMesh(),
      target: remote("i-7", "http://gpu-7.example:8000"),
      options: { fmin: 200, fmax: 8000, count: 24, backend: "beat_cuda", symmetry: "xy" },
    });
    const args = queue.buildArgs(store.getJob(job.id)!);
    assert.equal(args[args.indexOf("--server-url") + 1], "http://gpu-7.example:8000");
    // exactly one --backend, and it is the forwarding one — never the local id
    assert.equal(args.filter((a) => a === "--backend").length, 1);
    assert.equal(args[args.indexOf("--backend") + 1], "server");
    assert.equal(args.includes("beat_cuda"), false);
    // frequency settings still travel, and no local Julia is dragged along
    assert.equal(args[args.indexOf("--count") + 1], "24");
    assert.equal(args.includes("--julia-exe"), false);
  });

  test("a mesh job builds a generate argv with a params file", () => {
    const job = store.createJob({ kind: "mesh", name: "ath waveguide!", generator: "ath", params: { a: 1 } });
    const args = queue.buildArgs(job);
    assert.equal(args[0], "generate");
    assert.equal(args[args.indexOf("--generator") + 1], "ath");
    assert.equal(args[args.indexOf("--name") + 1], "ath_waveguide_");
    const paramsFile = args[args.indexOf("--params") + 1]!;
    assert.deepEqual(JSON.parse(fs.readFileSync(paramsFile, "utf8")), { a: 1 });
  });
});

describe("lane concurrency", () => {
  test("the local solve lane runs exactly one job at a time", async () => {
    const meshId = doneMesh();
    const jobs = [1, 2, 3].map(() => launchSolve(meshId, { type: "local" }));
    const lane = laneOf("local:solve")!;
    assert.equal(lane.concurrency, 1);
    assert.deepEqual([lane.active.length, lane.queued.length], [1, 2]);
    assert.deepEqual(
      jobs.map((j) => queue.queuePosition(j.id)),
      [1, 2, 3],
      "queue positions are stable and 1-based",
    );

    await Promise.all(jobs.map((j) => store.waitForTerminal(j.id, 30_000)));
    for (const job of jobs) assert.equal(store.getJob(job.id)!.status, "done");

    // Serialization proof: no two local solves overlapped in wall-clock time.
    const windows = jobs
      .map((j) => store.getJob(j.id)!)
      .map((j) => [Date.parse(j.startedAt!), Date.parse(j.finishedAt!)] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < windows.length; i++)
      assert.ok(
        windows[i]![0] >= windows[i - 1]![1],
        `solve ${i} started at ${windows[i]![0]} before ${windows[i - 1]![1]}`,
      );
  });

  test("distinct remote instances run in parallel with each other and with local", async () => {
    const meshId = doneMesh();
    const local = launchSolve(meshId, { type: "local" });
    const a = launchSolve(meshId, remote("inst-a", "http://a:8000"));
    const b = launchSolve(meshId, remote("inst-b", "http://b:8000"));

    for (const key of ["local:solve", "remote:inst-a", "remote:inst-b"]) {
      const lane = laneOf(key)!;
      assert.equal(lane.active.length, 1, `${key} started its job immediately`);
      assert.equal(lane.queued.length, 0, `${key} has nothing waiting`);
    }
    assert.equal(
      [local, a, b].filter((j) => queue.isRunning(j.id)).length,
      3,
      "three jobs are in flight at once",
    );
    await Promise.all([local, a, b].map((j) => store.waitForTerminal(j.id, 30_000)));
    for (const job of [local, a, b]) assert.equal(store.getJob(job.id)!.status, "done");
  });

  test("two jobs on the SAME remote instance serialize", () => {
    const meshId = doneMesh();
    launchSolve(meshId, remote("inst-c", "http://c:8000"));
    launchSolve(meshId, remote("inst-c", "http://c:8000"));
    const lane = laneOf("remote:inst-c")!;
    assert.equal(lane.concurrency, 1, "default remote concurrency is 1");
    assert.deepEqual([lane.active.length, lane.queued.length], [1, 1]);
  });

  test("a remote instance may declare a higher concurrency", () => {
    targets.registerTargetProvider(() => [
      { id: "wide", type: "remote", label: "8x", serverUrl: "http://wide:8000", concurrency: 3, available: true },
    ]);
    const meshId = doneMesh();
    for (let i = 0; i < 4; i++) launchSolve(meshId, "wide");
    const lane = laneOf("remote:wide")!;
    assert.equal(lane.concurrency, 3);
    assert.deepEqual([lane.active.length, lane.queued.length], [3, 1]);
  });

  test("local concurrency is NOT configurable by a provider", () => {
    // Even if something claims the local machine can take 4 jobs, the lane
    // stays at 1 — the GPU rule is structural, not a setting.
    targets.registerTargetProvider(() => [
      { id: "local", type: "remote", label: "spoof", serverUrl: "http://x", concurrency: 4, available: true },
    ]);
    const meshId = doneMesh();
    for (let i = 0; i < 3; i++) launchSolve(meshId, { type: "local" });
    const lane = laneOf("local:solve")!;
    assert.equal(lane.concurrency, 1);
    assert.equal(lane.active.length, 1);
  });

  test("mesh and solve lanes are independent", () => {
    const meshJob = store.createJob({ kind: "mesh", name: "m", generator: "g", params: {} });
    queue.enqueue(meshJob.id);
    launchSolve(doneMesh(), { type: "local" });
    assert.equal(laneOf("local:mesh")!.active.length, 1);
    assert.equal(laneOf("local:solve")!.active.length, 1);
  });

  test("cancelling a queued job frees its slot for the next one", async () => {
    const meshId = doneMesh();
    const first = launchSolve(meshId, { type: "local" });
    const second = launchSolve(meshId, { type: "local" });
    assert.equal(queue.queuePosition(second.id), 2);
    actions.cancelJob(second.id);
    assert.equal(store.getJob(second.id)!.status, "cancelled");
    assert.equal(queue.queuePosition(second.id), 0, "dropped out of the lane");
    await store.waitForTerminal(first.id, 30_000);
  });

  test("shutdownAll kills everything in every lane", async () => {
    const meshId = doneMesh();
    const local = launchSolve(meshId, { type: "local" });
    const waiting = launchSolve(meshId, { type: "local" });
    const remoteJob = launchSolve(meshId, remote("inst-d", "http://d:8000"));
    queue.shutdownAll("test shutdown");
    assert.equal(store.getJob(waiting.id)!.status, "cancelled");
    await Promise.all([local, remoteJob].map((j) => store.waitForTerminal(j.id, 30_000)));
    for (const job of [local, remoteJob])
      assert.equal(store.getJob(job.id)!.status, "cancelled", `${job.id} cancelled`);
  });
});
