/**
 * The reworked model: projects, mesh variants, one-mesh-many-solves, and the
 * schedule board's write path (slots, run order, retarget, hold).
 *
 * The claims worth pinning down are the ones a UI cannot check for itself:
 * that a hand-arranged order is persisted rather than incidental, that a
 * not-yet-started job can change machines safely, that a running one cannot,
 * and that slot counts really gate concurrency.
 */
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-schedule-test-"));
process.env.DATA_DIR = dataDir;

const fakeBlabctl = fileURLToPath(new URL("./fixtures/fake-blabctl.mjs", import.meta.url));

let store: typeof import("../src/store.ts");
let actions: typeof import("../src/actions.ts");
let queue: typeof import("../src/queue.ts");
let targets: typeof import("../src/targets.ts");
let estimate: typeof import("../src/estimate.ts");

function doneMesh(name = "mesh", triangles = 5000, params: Record<string, unknown> = {}): string {
  const job = store.createJob({ kind: "mesh", name, generator: "ath_waveguide", params });
  store.finishJob(job.id, { status: "done", summary: { triangles } });
  return job.id;
}

const draftSolve = (meshId: string, options: Record<string, unknown> = {}) =>
  actions.createDraft({ kind: "solve", meshJobId: meshId, options });

const laneOf = (key: string) => queue.queueSnapshot().lanes.find((l) => l.key === key);

before(async () => {
  const { config } = await import("../src/config.ts");
  config.python = process.execPath;
  config.blabctl = fakeBlabctl;
  config.repoRoot = dataDir;
  // Long enough that a started job is still running when the assertions run.
  process.env.FAKE_DELAY_MS = "4000";
  store = await import("../src/store.ts");
  actions = await import("../src/actions.ts");
  queue = await import("../src/queue.ts");
  targets = await import("../src/targets.ts");
  estimate = await import("../src/estimate.ts");
  store.loadStore();
});

beforeEach(() => {
  targets.clearTargetProviders();
  targets.setTargetConfig("local", { slots: null, devices: null });
  queue.resetLanes();
});

describe("projects", () => {
  test("a project can be referenced by name and is created on first use", () => {
    const created = actions.resolveProject("cd90x60");
    assert.equal(created!.name, "cd90x60");
    // The same name resolves to the SAME project — otherwise every trial of a
    // campaign would file itself under a fresh duplicate.
    assert.equal(actions.resolveProject("cd90x60")!.id, created!.id);
    assert.equal(actions.resolveProject(created!.id)!.id, created!.id);
  });

  test("explicit project creation is name-idempotent and restores an archived match", () => {
    const created = actions.createProject({ name: "No duplicates" });
    assert.equal(actions.createProject({ name: " no DUPLICATES " }).id, created.id);
    actions.updateProject(created.id, { archived: true });
    const restored = actions.createProject({ name: "No duplicates" });
    assert.equal(restored.id, created.id);
    assert.equal(restored.archived, false);
  });

  test("renaming a project cannot steal another project's name", () => {
    const first = actions.createProject({ name: "first unique" });
    const second = actions.createProject({ name: "second unique" });
    assert.throws(
      () => actions.updateProject(second.id, { name: first.name.toUpperCase() }),
      /already exists/,
    );
  });

  test("a solve inherits its mesh's project", () => {
    const project = actions.createProject({ name: "inherit" });
    const mesh = store.createJob({
      kind: "mesh",
      name: "m",
      generator: "g",
      params: {},
      projectId: project.id,
    });
    store.finishJob(mesh.id, { status: "done" });
    const solve = actions.startSolve({ meshJobId: mesh.id });
    assert.equal(solve.projectId, project.id);
  });

  test("moving a mesh carries its solves and variants with it", () => {
    const from = actions.createProject({ name: "from" });
    const to = actions.createProject({ name: "to" });
    const mesh = store.createJob({
      kind: "mesh",
      name: "root",
      generator: "g",
      params: { a: 1 },
      projectId: from.id,
    });
    store.finishJob(mesh.id, { status: "done" });
    const solve = actions.createDraft({ kind: "solve", meshJobId: mesh.id });
    const variant = actions.createMeshVariant({ meshJobId: mesh.id, params: { a: 2 } });

    actions.assignProject([mesh.id], to.id);
    assert.equal(store.getJob(mesh.id)!.projectId, to.id);
    assert.equal(store.getJob(solve.id)!.projectId, to.id, "the solve follows its mesh");
    assert.equal(store.getJob(variant.id)!.projectId, to.id, "the variant follows its parent");
  });

  test("deleting a project unassigns its jobs instead of destroying them", () => {
    const project = actions.createProject({ name: "doomed" });
    const mesh = store.createJob({
      kind: "mesh",
      name: "m",
      generator: "g",
      params: {},
      projectId: project.id,
    });
    assert.deepEqual(actions.deleteProject(project.id), { unassigned: 1 });
    assert.ok(store.getJob(mesh.id), "the job survives");
    assert.equal(store.getJob(mesh.id)!.projectId, undefined);
  });
});

describe("mesh variants", () => {
  test("a variant is the parent's params patched, and records the lineage", () => {
    const root = doneMesh("cd90", 5000, { throat: 35, mouth: 300, depth: 140 });
    const variant = actions.createMeshVariant({ meshJobId: root, params: { mouth: 340 } });
    assert.equal(variant.variantOf, root);
    assert.equal(variant.generator, "ath_waveguide");
    // Untouched params come along; only the patch differs.
    assert.deepEqual(variant.params, { throat: 35, mouth: 340, depth: 140 });
    assert.match(variant.name, /mouth=340/);
    assert.equal(variant.status, "draft", "variants are staged, not run, by default");
  });

  test("one mesh holds many solves, and they are listed as such", () => {
    const mesh = doneMesh("many");
    const coarse = actions.createDraft({ kind: "solve", meshJobId: mesh, options: { count: 24 } });
    const fine = actions.createDraft({ kind: "solve", meshJobId: mesh, options: { count: 96 } });
    assert.deepEqual(
      store.listSolvesOfMesh(mesh).map((s) => s.id),
      [coarse.id, fine.id],
    );
  });

  test("deleting a mesh mid-lineage re-roots its variants rather than orphaning them", () => {
    const root = doneMesh("root", 5000, { a: 1 });
    const middle = actions.createMeshVariant({ meshJobId: root, params: { a: 2 } });
    const leaf = actions.createMeshVariant({ meshJobId: middle.id, params: { a: 3 } });
    actions.deleteJob(middle.id);
    assert.equal(store.getJob(leaf.id)!.variantOf, root);
  });
});

describe("slots", () => {
  test("the local lane runs one solve at a time by default", async () => {
    const mesh = doneMesh();
    const a = draftSolve(mesh);
    const b = draftSolve(mesh);
    actions.launchJobs({ jobIds: [a.id, b.id] });
    const lane = laneOf("local:solve")!;
    assert.equal(lane.concurrency, 1);
    assert.deepEqual(lane.active, [a.id]);
    assert.deepEqual(lane.queued, [b.id]);
    queue.cancel(a.id);
    queue.cancel(b.id);
  });

  test("raising the slot count lets that many run, and pins a device per slot", () => {
    actions.setTargetSlots("local", { slots: 2, devices: ["0", "1"] });
    const mesh = doneMesh();
    const a = draftSolve(mesh);
    const b = draftSolve(mesh);
    const c = draftSolve(mesh);
    actions.launchJobs({ jobIds: [a.id, b.id, c.id] });
    const lane = laneOf("local:solve")!;
    assert.equal(lane.concurrency, 2);
    assert.equal(lane.active.length, 2, "two slots, two running");
    assert.deepEqual(lane.queued, [c.id], "the third waits for a slot");
    assert.deepEqual(
      lane.slots.map((s) => s.device).sort(),
      ["0", "1"],
      "each running job owns a distinct device",
    );
    for (const job of [a, b, c]) queue.cancel(job.id);
  });

  test("sharing a device without pinning one warns, pinning one does not", () => {
    const shared = actions.setTargetSlots("local", { slots: 2 });
    assert.match(String(shared.warning), /share/i);
    const pinned = actions.setTargetSlots("local", { devices: ["0", "1"] });
    assert.equal(pinned.warning, null);
  });

  test("an absurd slot count is refused rather than accepted and thrashed", () => {
    assert.throws(() => actions.setTargetSlots("local", { slots: 99 }), /capped/);
    assert.throws(() => actions.setTargetSlots("local", { slots: 0.5 }), /positive/);
  });

  test("a provider-managed slot count cannot be overridden", () => {
    targets.registerTargetProvider(() => [
      {
        id: "fixed-box",
        type: "remote",
        label: "fixed box",
        serverUrl: "http://fixed:8765",
        concurrency: 1,
        slotsLocked: true,
        slotLockReason: "server accepts one solve at a time",
        available: true,
      },
    ]);
    assert.throws(
      () => actions.setTargetSlots("fixed-box", { slots: 2 }),
      /one solve at a time/,
    );
    assert.equal(targets.getTarget("fixed-box")!.concurrency, 1);
  });
});

describe("the schedule board's write path", () => {
  test("run order is the persisted priority, not arrival order", () => {
    const mesh = doneMesh();
    const first = draftSolve(mesh);
    const second = draftSolve(mesh);
    const third = draftSolve(mesh);
    // Nothing may start while the assertions run: fill the single slot first.
    const blocker = draftSolve(mesh);
    actions.launchJobs({ jobIds: [blocker.id, first.id, second.id, third.id] });
    assert.deepEqual(laneOf("local:solve")!.queued, [first.id, second.id, third.id]);

    actions.scheduleJobs([{ jobId: third.id, column: "local", position: 0 }]);
    assert.deepEqual(laneOf("local:solve")!.queued, [third.id, first.id, second.id]);

    // The order survives losing the in-memory lanes — that is the point of
    // persisting it rather than keeping a queue array. A fresh blocker takes
    // the single slot so the rebuilt lane has a waiting line to sort at all.
    queue.resetLanes();
    const blocker2 = draftSolve(mesh);
    actions.launchJobs({ jobIds: [blocker2.id] });
    for (const id of [first.id, second.id, third.id]) queue.enqueue(id);
    assert.deepEqual(laneOf("local:solve")!.queued, [third.id, first.id, second.id]);
    for (const job of [blocker, blocker2, first, second, third]) queue.cancel(job.id);
  });

  test("a queued job can change machines; a running one cannot", () => {
    targets.registerTargetProvider(() => [
      {
        id: "box-a",
        type: "remote",
        label: "box-a",
        serverUrl: "http://box-a:8765",
        concurrency: 1,
        available: true,
      },
    ]);
    const mesh = doneMesh();
    const running = draftSolve(mesh);
    const waiting = draftSolve(mesh);
    actions.launchJobs({ jobIds: [running.id, waiting.id] });

    const result = actions.scheduleJobs([
      { jobId: waiting.id, column: "box-a" },
      { jobId: running.id, column: "box-a" },
    ]);
    assert.deepEqual(
      result.moved.map((m) => m.jobId),
      [waiting.id],
    );
    assert.match(result.skipped[0]!.reason, /running/);
    assert.equal(store.getJob(waiting.id)!.target!.type, "remote");
    assert.deepEqual(laneOf("local:solve")!.queued, [], "it left the local lane");
    assert.deepEqual(laneOf("remote:box-a")!.active, [waiting.id]);
    queue.cancel(running.id);
    queue.cancel(waiting.id);
  });

  test("a job launched from the backlog appends, it does not cut the queue", () => {
    const mesh = doneMesh();
    const blocker = draftSolve(mesh);
    const waiting = draftSolve(mesh);
    actions.launchJobs({ jobIds: [blocker.id, waiting.id] });

    // Hold-then-relaunch renumbers the held job into the backlog's range; if
    // that range overlapped the lane's, it would come back at the FRONT.
    const jumper = draftSolve(mesh);
    actions.scheduleJobs([{ jobId: jumper.id, column: actions.PLANNED_COLUMN, position: 0 }]);
    actions.launchJobs({ jobIds: [jumper.id] });
    assert.deepEqual(laneOf("local:solve")!.queued, [waiting.id, jumper.id]);
    for (const job of [blocker, waiting, jumper]) queue.cancel(job.id);
  });

  test("dropping a queued job back on the backlog holds it as a draft", () => {
    const mesh = doneMesh();
    const blocker = draftSolve(mesh);
    const held = draftSolve(mesh);
    actions.launchJobs({ jobIds: [blocker.id, held.id] });
    assert.equal(store.getJob(held.id)!.status, "queued");

    actions.scheduleJobs([{ jobId: held.id, column: actions.PLANNED_COLUMN }]);
    const after = store.getJob(held.id)!;
    assert.equal(after.status, "draft", "held, not cancelled");
    assert.equal(after.params.meshJobId, mesh, "its configuration is intact");
    assert.deepEqual(laneOf("local:solve")!.queued, []);
    queue.cancel(blocker.id);
  });

  test("a mesh job refuses to be aimed at a remote machine", () => {
    targets.registerTargetProvider(() => [
      {
        id: "box-b",
        type: "remote",
        label: "box-b",
        serverUrl: "http://box-b:8765",
        concurrency: 1,
        available: true,
      },
    ]);
    const draft = actions.createDraft({ kind: "mesh", generator: "g", params: {} });
    const result = actions.scheduleJobs([{ jobId: draft.id, column: "box-b" }]);
    assert.deepEqual(result.moved, []);
    assert.match(result.skipped[0]!.reason, /bridge host/);
  });
});

describe("estimates", () => {
  test("a solve is predicted from the most similar finished one", () => {
    const mesh = doneMesh("sized", 6000);
    // One measured sample: 6000 triangles × 24 points took 60 s.
    const sample = store.createJob({
      kind: "solve",
      name: "sample",
      params: { meshJobId: mesh, count: 24 },
      parentJobId: mesh,
    });
    store.markRunning(sample.id);
    const job = store.getJob(sample.id)!;
    job.startedAt = new Date(Date.now() - 60_000).toISOString();
    store.finishJob(sample.id, { status: "done" });

    // Same mesh, four times the frequency points: cost is linear in count.
    const draft = actions.createDraft({ kind: "solve", meshJobId: mesh, options: { count: 96 } });
    const est = estimate.estimateJob(store.getJob(draft.id)!);
    assert.equal(est.basis, "history");
    assert.ok(
      est.totalSeconds! > 200 && est.totalSeconds! < 280,
      `expected ~240 s, got ${est.totalSeconds}`,
    );
  });

  test("with no comparable history the answer is null, not a guess", () => {
    // A mesh whose triangle count was never recorded gives nothing to scale by.
    const mesh = store.createJob({ kind: "mesh", name: "unknown", generator: "g", params: {} });
    store.finishJob(mesh.id, { status: "done" });
    const draft = actions.createDraft({ kind: "solve", meshJobId: mesh.id });
    const est = estimate.estimateJob(store.getJob(draft.id)!);
    assert.equal(est.basis, "none");
    assert.equal(est.totalSeconds, null);
  });

  test("a lane forecast schedules waiting jobs into the slot that frees first", () => {
    const pool = [
      { targetId: "local", triangles: 1000, count: 10, seconds: 100 },
      { targetId: "local", triangles: 1000, count: 10, seconds: 100 },
      { targetId: "local", triangles: 1000, count: 10, seconds: 100 },
    ];
    const mesh = doneMesh("forecast", 1000);
    const ids = [10, 10, 10].map(
      (count) => actions.createDraft({ kind: "solve", meshJobId: mesh, options: { count } }).id,
    );
    // Two slots, three jobs: the third starts when the first slot frees.
    const forecast = estimate.laneForecast([], ids, 2, pool);
    assert.equal(forecast.entries[0]!.startsInSeconds, 0);
    assert.equal(forecast.entries[1]!.startsInSeconds, 0);
    assert.equal(forecast.entries[2]!.startsInSeconds, 100);
    assert.equal(forecast.clearInSeconds, 200);
  });
});
