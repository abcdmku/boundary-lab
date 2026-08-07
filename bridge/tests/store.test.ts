/**
 * Model + migration: a v1 ledger ({runs: […]}, parentRunId, params.meshRunId,
 * job directories under data/runs/) must come out the other side as a v2
 * ledger with every record, artifact URL and on-disk file intact.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-store-test-"));
process.env.DATA_DIR = dataDir;

/** A faithful (trimmed) replica of the live v1 ledger: 7 runs, 1 solve. */
const LEGACY = {
  runs: [
    {
      id: "0qi2g7",
      kind: "mesh",
      name: "verify horn 2",
      status: "done",
      createdAt: "2026-08-05T10:00:00.000Z",
      finishedAt: "2026-08-05T10:01:00.000Z",
      generator: "ath_waveguide",
      params: { throat_diameter_mm: 25.4 },
      summary: { triangles: 7420, files: { mesh: `${dataDir}/runs/0qi2g7/case.msh` } },
      artifacts: [{ name: "case.msh", kind: "mesh", url: "/artifacts/0qi2g7/case.msh" }],
    },
    {
      id: "oglsjo",
      kind: "mesh",
      name: "verify3",
      status: "done",
      createdAt: "2026-08-05T11:00:00.000Z",
      params: {},
      artifacts: [],
    },
    {
      id: "xclhn4",
      kind: "mesh",
      name: "viewer-check",
      status: "done",
      createdAt: "2026-08-05T12:00:00.000Z",
      params: {},
      artifacts: [{ name: "preview.png", kind: "preview", url: "/artifacts/xclhn4/preview.png" }],
    },
    {
      id: "b6j1li",
      kind: "solve",
      name: "wg solve",
      status: "done",
      createdAt: "2026-08-05T13:00:00.000Z",
      params: { meshRunId: "xclhn4", fmin: 500, fmax: 16000, count: 24, symmetry: "off" },
      parentRunId: "xclhn4",
      summary: { score: 0.71 },
      artifacts: [{ name: "spl.png", kind: "plot", url: "/artifacts/b6j1li/plots/spl.png" }],
    },
    {
      id: "ku0tvw",
      kind: "mesh",
      name: "smoke01 t1",
      status: "failed",
      createdAt: "2026-08-06T09:00:00.000Z",
      params: {},
      error: "boom",
      artifacts: [],
    },
    {
      id: "9ycf74",
      kind: "mesh",
      name: "smoke01-t1",
      status: "done",
      createdAt: "2026-08-06T10:00:00.000Z",
      params: {},
      artifacts: [],
    },
    // A run that was mid-flight when the bridge died: the restart sweep fails it.
    {
      id: "q2vb21",
      kind: "mesh",
      name: "smoke01-t2",
      status: "running",
      createdAt: "2026-08-06T11:00:00.000Z",
      params: {},
      artifacts: [],
    },
  ],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: typeof import("../src/store.ts");

before(async () => {
  fs.mkdirSync(path.join(dataDir, "runs"), { recursive: true });
  for (const run of LEGACY.runs) {
    fs.mkdirSync(path.join(dataDir, "runs", run.id), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "runs", run.id, "job.log"), `log for ${run.id}\n`);
  }
  fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify(LEGACY, null, 2));
  store = await import("../src/store.ts");
  store.loadStore();
});

describe("v1 -> v2 migration", () => {
  test("every run survives as a job", () => {
    const jobs = store.listJobs();
    assert.equal(jobs.length, 7, "all 7 records migrated");
    assert.deepEqual(
      new Set(jobs.map((j) => j.id)),
      new Set(LEGACY.runs.map((r) => r.id)),
    );
  });

  test("parentRunId becomes parentJobId and params.meshRunId becomes meshJobId", () => {
    const solve = store.getJob("b6j1li")!;
    assert.equal(solve.parentJobId, "xclhn4");
    assert.equal(solve.params.meshJobId, "xclhn4");
    assert.equal((solve as unknown as Record<string, unknown>).parentRunId, undefined);
    assert.equal(solve.params.meshRunId, undefined);
    // untouched settings ride along
    assert.equal(solve.params.fmin, 500);
    assert.equal(solve.params.symmetry, "off");
  });

  test("pre-target records default to the local target", () => {
    for (const job of store.listJobs()) assert.deepEqual(job.target, { type: "local" });
  });

  test("artifact URLs keep the /artifacts/<id>/… shape", () => {
    assert.equal(store.getJob("0qi2g7")!.artifacts[0]!.url, "/artifacts/0qi2g7/case.msh");
    assert.equal(store.getJob("b6j1li")!.artifacts[0]!.url, "/artifacts/b6j1li/plots/spl.png");
  });

  test("summaries and errors are preserved verbatim", () => {
    assert.equal((store.getJob("b6j1li")!.summary as Record<string, unknown>).score, 0.71);
    assert.equal(store.getJob("ku0tvw")!.error, "boom");
  });

  test("the original ledger is backed up before being rewritten", () => {
    const backup = path.join(dataDir, "state.json.v1.bak");
    assert.ok(fs.existsSync(backup), "state.json.v1.bak exists");
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, "utf8")), LEGACY);
  });

  test("the new ledger is versioned and keyed 'jobs'", () => {
    const written = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
    assert.equal(written.version, 2);
    assert.ok(Array.isArray(written.jobs));
    assert.equal(written.runs, undefined);
  });

  test("job directories move from data/runs to data/jobs with their files", () => {
    assert.ok(fs.existsSync(path.join(dataDir, "jobs")), "data/jobs exists");
    assert.ok(!fs.existsSync(path.join(dataDir, "runs")), "data/runs is gone");
    for (const run of LEGACY.runs) {
      const log = path.join(store.jobDir(run.id), "job.log");
      assert.ok(fs.existsSync(log), `${run.id}/job.log moved`);
      assert.equal(fs.readFileSync(log, "utf8"), `log for ${run.id}\n`);
    }
  });

  test("migrating twice is a no-op", () => {
    const again = store.migrateState(
      JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8")),
    );
    assert.equal(again.migratedFrom, null);
    assert.equal(again.state.jobs.length, 7);
  });
});

describe("restart sweep", () => {
  test("a running job is failed, a done job is untouched", () => {
    assert.equal(store.getJob("q2vb21")!.status, "failed");
    assert.equal(store.getJob("q2vb21")!.error, "interrupted by bridge restart");
    assert.equal(store.getJob("9ycf74")!.status, "done");
  });

  test("drafts survive a restart untouched", () => {
    const draft = store.createJob({
      kind: "mesh",
      status: "draft",
      name: "staged",
      generator: "ath_waveguide",
      params: { a: 1 },
    });
    store.flushState(); // the ledger write is debounced; land it first
    store.loadStore(); // simulate a bridge restart against the same data dir
    const after = store.getJob(draft.id)!;
    assert.equal(after.status, "draft", "a draft is not swept into failed");
    assert.deepEqual(after.params, { a: 1 });
  });
});

describe("draft mutations", () => {
  test("updateJob edits config and stamps updatedAt", () => {
    const job = store.createJob({ kind: "mesh", status: "draft", name: "a", params: {} });
    assert.equal(job.updatedAt, undefined);
    const updated = store.updateJob(job.id, { name: "b", params: { x: 2 } })!;
    assert.equal(updated.name, "b");
    assert.deepEqual(updated.params, { x: 2 });
    assert.ok(updated.updatedAt);
  });

  test("markQueued only promotes drafts", () => {
    const draft = store.createJob({ kind: "mesh", status: "draft", name: "c", params: {} });
    assert.equal(store.markQueued(draft.id), true);
    assert.equal(store.getJob(draft.id)!.status, "queued");
    assert.ok(store.getJob(draft.id)!.launchedAt);
    assert.equal(store.markQueued(draft.id), false, "a queued job cannot be re-launched");
  });

  test("batch grouping is listable", () => {
    const batchId = store.newBatchId();
    const a = store.createJob({ kind: "mesh", status: "draft", name: "x", params: {}, batchId });
    const b = store.createJob({ kind: "mesh", status: "draft", name: "y", params: {}, batchId });
    const ids = store.listBatch(batchId).map((j) => j.id);
    assert.deepEqual(new Set(ids), new Set([a.id, b.id]));
    assert.ok(store.listBatchIds().includes(batchId));
  });
});
