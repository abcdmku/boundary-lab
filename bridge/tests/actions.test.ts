/**
 * Draft lifecycle, sweep creation and batch-wide cancel, exercised through the
 * same actions the HTTP routes and MCP tools call.
 */
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-actions-test-"));
process.env.DATA_DIR = dataDir;

const fakeBlabctl = fileURLToPath(new URL("./fixtures/fake-blabctl.mjs", import.meta.url));

let store: typeof import("../src/store.ts");
let actions: typeof import("../src/actions.ts");
let queue: typeof import("../src/queue.ts");
let targets: typeof import("../src/targets.ts");

/** A finished mesh job the solves can point at. */
function doneMesh(name = "mesh"): string {
  const job = store.createJob({ kind: "mesh", name, generator: "ath_waveguide", params: {} });
  store.finishJob(job.id, { status: "done", summary: { triangles: 5000 } });
  return job.id;
}

before(async () => {
  const { config } = await import("../src/config.ts");
  config.python = process.execPath;
  config.blabctl = fakeBlabctl;
  config.repoRoot = dataDir;
  process.env.FAKE_DELAY_MS = "150";
  store = await import("../src/store.ts");
  actions = await import("../src/actions.ts");
  queue = await import("../src/queue.ts");
  targets = await import("../src/targets.ts");
  store.loadStore();
});

beforeEach(() => {
  targets.clearTargetProviders();
  queue.resetLanes();
});

describe("draft lifecycle", () => {
  test("a draft solve is created but never enqueued", () => {
    const meshId = doneMesh();
    const draft = actions.createDraft({ kind: "solve", meshJobId: meshId, options: { count: 12 } });
    assert.equal(draft.status, "draft");
    assert.equal(draft.params.meshJobId, meshId);
    assert.equal(draft.parentJobId, meshId);
    assert.equal(queue.queuePosition(draft.id), 0, "not in any lane");
    assert.equal(queue.isQueued(draft.id), false);
  });

  test("enqueue refuses a draft outright", () => {
    const draft = actions.createDraft({ kind: "solve", meshJobId: doneMesh() });
    queue.enqueue(draft.id);
    assert.equal(store.getJob(draft.id)!.status, "draft");
    assert.equal(queue.queuePosition(draft.id), 0);
  });

  test("a draft is freely editable before launch", () => {
    const meshId = doneMesh();
    const draft = actions.createDraft({ kind: "solve", meshJobId: meshId, options: { count: 12 } });
    const edited = actions.updateDraft(draft.id, {
      name: "renamed",
      options: { count: 48, symmetry: "xy" },
      target: { type: "remote", serverUrl: "http://box-a:8000/" },
    });
    assert.equal(edited.name, "renamed");
    assert.equal(edited.params.count, 48);
    assert.equal(edited.params.symmetry, "xy");
    assert.deepEqual(edited.target, { type: "remote", serverUrl: "http://box-a:8000" });
    assert.equal(edited.status, "draft");
  });

  test("a launched job is immutable", () => {
    const draft = actions.createDraft({ kind: "solve", meshJobId: doneMesh() });
    actions.launchJobs({ jobIds: [draft.id] });
    assert.throws(() => actions.updateDraft(draft.id, { name: "nope" }), /only drafts can be edited/);
  });

  test("launching a draft queues it in its target lane", () => {
    const draft = actions.createDraft({ kind: "solve", meshJobId: doneMesh() });
    const result = actions.launchJobs({ jobIds: [draft.id] });
    assert.equal(result.launched.length, 1);
    assert.equal(result.launched[0]!.lane, "local:solve");
    assert.ok(result.launched[0]!.queuePosition >= 1);
    assert.notEqual(store.getJob(draft.id)!.status, "draft");
  });

  test("a solve draft can be staged against a mesh that is not done yet", () => {
    const pending = store.createJob({ kind: "mesh", name: "pending", params: {} });
    const draft = actions.createDraft({ kind: "solve", meshJobId: pending.id });
    assert.equal(draft.status, "draft");
    // …but launching it before the mesh finishes is refused, not silently run.
    const result = actions.launchJobs({ jobIds: [draft.id] });
    assert.equal(result.launched.length, 0);
    assert.match(result.skipped[0]!.reason, /not done/);
    assert.equal(store.getJob(draft.id)!.status, "draft", "still a draft, still editable");
  });

  test("a draft can be deleted", () => {
    const draft = actions.createDraft({ kind: "solve", meshJobId: doneMesh() });
    actions.deleteJob(draft.id);
    assert.equal(store.getJob(draft.id), undefined);
  });

  test("deleting a mesh with a dependent draft is refused", () => {
    const meshId = doneMesh();
    actions.createDraft({ kind: "solve", meshJobId: meshId });
    assert.throws(() => actions.deleteJob(meshId), /cancel or delete them first/);
  });

  test("cancelling a draft closes it without ever running", () => {
    const draft = actions.createDraft({ kind: "solve", meshJobId: doneMesh() });
    actions.cancelJob(draft.id);
    assert.equal(store.getJob(draft.id)!.status, "cancelled");
  });
});

describe("batches", () => {
  test("meshJobIds × variants is the cross product, one batch", () => {
    const a = doneMesh("mesh-a");
    const b = doneMesh("mesh-b");
    const result = actions.createBatch({
      kind: "solve",
      name: "sweep",
      meshJobIds: [a, b],
      options: { fmin: 200, fmax: 8000, count: 24, symmetry: "off" },
      variants: [{ symmetry: "xy" }, { count: 48 }, { name: "hires", count: 96, fmax: 20000 }],
    });
    assert.equal(result.created, 6, "2 meshes × 3 variants");
    assert.equal(result.jobs.length, 6);
    assert.ok(result.batchId.startsWith("b_"));
    for (const job of result.jobs) {
      assert.equal(job.status, "draft");
      assert.equal(job.batchId, result.batchId);
      assert.equal(job.batchName, "sweep");
      // shared settings survive where the variant did not override them
      assert.equal(job.params.fmin, 200);
    }
    const byMesh = result.jobs.filter((j) => j.params.meshJobId === a);
    assert.equal(byMesh.length, 3);
    assert.deepEqual(
      byMesh.map((j) => [j.params.symmetry, j.params.count, j.params.fmax]),
      [
        ["xy", 24, 8000],
        ["off", 48, 8000],
        ["off", 96, 20000],
      ],
    );
    assert.ok(byMesh.some((j) => j.name.includes("hires")));
  });

  test("no variants means one job per mesh", () => {
    const result = actions.createBatch({
      kind: "solve",
      meshJobIds: [doneMesh(), doneMesh()],
      options: { count: 8 },
    });
    assert.equal(result.created, 2);
  });

  test("variants can pin their own targets", () => {
    const result = actions.createBatch({
      kind: "solve",
      meshJobId: doneMesh(),
      variants: [
        {},
        { target: { type: "remote", instanceId: "i-1", serverUrl: "http://a:8000" } },
        { target: "http://b:8000" },
      ],
    });
    assert.deepEqual(result.jobs.map((j) => j.target!.type), ["local", "remote", "remote"]);
    assert.deepEqual(
      result.jobs.map((j) => queue.laneKeyFor(j)),
      ["local:solve", "remote:i-1", "remote:http://b:8000"],
    );
  });

  test("mesh batches sweep generator params", () => {
    const result = actions.createBatch({
      kind: "mesh",
      generator: "ath_waveguide",
      name: "candidates",
      params: { throat_diameter_mm: 25.4 },
      variants: [{ params: { mouth_width_mm: 300 } }, { params: { mouth_width_mm: 360 } }],
    });
    assert.equal(result.created, 2);
    assert.deepEqual(result.jobs.map((j) => j.params.mouth_width_mm), [300, 360]);
    assert.ok(result.jobs.every((j) => j.params.throat_diameter_mm === 25.4));
    assert.ok(result.jobs.every((j) => j.target!.type === "local"));
  });

  test("a batch launches, lists and cancels as a unit", async () => {
    const meshId = doneMesh();
    const result = actions.createBatch({
      kind: "solve",
      meshJobId: meshId,
      variants: [{ count: 4 }, { count: 5 }, { count: 6 }],
    });
    const launched = actions.launchJobs({ batchId: result.batchId });
    assert.equal(launched.launched.length, 3);
    // Only one may be running: they all share the single local solve lane.
    const lane = queue.queueSnapshot().lanes.find((l) => l.key === "local:solve")!;
    assert.equal(lane.active.length, 1);
    assert.equal(lane.queued.length, 2);

    const summary = actions.batchSummary(result.batchId)!;
    assert.equal(summary.total, 3);
    assert.equal(summary.counts.running + summary.counts.queued, 3);

    const cancelled = actions.cancelJobs({ batchId: result.batchId });
    assert.equal(cancelled.cancelled.length, 3);
    // Queued jobs close synchronously; the running one closes when its process
    // tree actually dies.
    await Promise.all(result.jobs.map((j) => store.waitForTerminal(j.id, 20_000)));
    for (const job of store.listBatch(result.batchId))
      assert.ok(["cancelled", "failed"].includes(job.status), `${job.id} is ${job.status}`);
  });

  test("cancelling an already-finished batch reports skips, not errors", () => {
    const result = actions.createBatch({ kind: "solve", meshJobId: doneMesh(), variants: [{}] });
    actions.cancelJobs({ batchId: result.batchId });
    const again = actions.cancelJobs({ batchId: result.batchId });
    assert.equal(again.cancelled.length, 0);
    assert.equal(again.skipped.length, 1);
  });

  test("an oversized sweep is refused before anything is created", () => {
    const before = store.listJobs().length;
    assert.throws(
      () =>
        actions.createBatch({
          kind: "solve",
          meshJobId: doneMesh(),
          variants: Array.from({ length: actions.MAX_BATCH_JOBS + 1 }, (_, i) => ({ count: i })),
        }),
      /over the 200 limit/,
    );
    assert.equal(store.listJobs().length, before + 1, "only the mesh fixture was created");
  });

  test("an unknown batch id is a 404, not a silent no-op", () => {
    assert.throws(() => actions.launchJobs({ batchId: "b_nope" }), /unknown batch b_nope/);
    assert.throws(() => actions.cancelJobs({ batchId: "b_nope" }), /unknown batch b_nope/);
  });

  test("settings embedded in params are honoured, not dropped", () => {
    const draft = actions.createDraft({
      kind: "solve",
      meshJobId: doneMesh(),
      params: { fmin: 300, count: 12 },
      options: { count: 24 }, // explicit options win over params
    });
    assert.equal(draft.params.fmin, 300);
    assert.equal(draft.params.count, 24);
  });

  test("an unknown mesh aborts the whole sweep", () => {
    const before = store.listJobs().length;
    assert.throws(
      () => actions.createBatch({ kind: "solve", meshJobIds: [doneMesh(), "nope42"] }),
      /unknown job nope42/,
    );
    assert.equal(store.listJobs().length, before + 1);
  });
});

describe("targets", () => {
  test("an unknown target id is rejected", () => {
    assert.throws(
      () => actions.createDraft({ kind: "solve", meshJobId: doneMesh(), target: "ghost-instance" }),
      /unknown target "ghost-instance"/,
    );
  });

  test("a remote target without a serverUrl is rejected", () => {
    assert.throws(
      () => actions.createDraft({ kind: "solve", meshJobId: doneMesh(), target: { type: "remote" } }),
      /needs serverUrl/,
    );
  });

  test("a registered instance id resolves to its serverUrl", () => {
    targets.registerTargetProvider(() => [
      { id: "vast-42", type: "remote", label: "vast 4090", serverUrl: "http://1.2.3.4:8000/", concurrency: 2 },
    ]);
    const draft = actions.createDraft({ kind: "solve", meshJobId: doneMesh(), target: "vast-42" });
    assert.deepEqual(draft.target, {
      type: "remote",
      instanceId: "vast-42",
      serverUrl: "http://1.2.3.4:8000",
      label: "vast 4090",
    });
    assert.equal(actions.fullState().targets.length, 2);
  });

  test("mesh jobs are always local, whatever target is asked for", () => {
    const draft = actions.createDraft({
      kind: "mesh",
      generator: "ath_waveguide",
      target: "http://elsewhere:8000",
    });
    assert.deepEqual(draft.target, { type: "local" });
  });
});
