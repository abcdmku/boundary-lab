/**
 * The live mesh editor's preview loop: coalescing (a newer edit supersedes an
 * older one instead of queueing behind it), worker recovery, and the artifact
 * path guards.
 *
 * The scratch path is reachable by anything that can talk to the bridge and
 * names a directory chosen by the caller, so its validation is tested as
 * carefully as the behaviour above it.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-preview-test-"));
process.env.DATA_DIR = dataDir;

const fakeWorker = fileURLToPath(new URL("./fixtures/fake-preview-worker.mjs", import.meta.url));
const requestLog = path.join(dataDir, "requests.ndjson");

let preview: typeof import("../src/preview.ts");

const servedRequests = (): Array<{ generator: string; params: Record<string, unknown> }> =>
  fs.existsSync(requestLog)
    ? fs
        .readFileSync(requestLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

before(async () => {
  const { config } = await import("../src/config.ts");
  config.python = process.execPath;
  config.previewWorker = fakeWorker;
  config.repoRoot = dataDir;
  process.env.FAKE_PREVIEW_DELAY_MS = "80";
  process.env.FAKE_PREVIEW_FAIL = "broken_generator";
  process.env.FAKE_PREVIEW_LOG = requestLog;
  preview = await import("../src/preview.ts");
});

beforeEach(() => {
  fs.rmSync(requestLog, { force: true });
});

// A live worker holds the event loop open; without this the runner waits for
// the idle timeout before it can exit.
after(() => preview.shutdownPreview());

const render = (sessionId: string, generator = "axisym_horn", params = {}) =>
  preview.requestPreview({ sessionId, generator, params });

describe("preview rendering", () => {
  test("renders params and returns URLs under the session's generation", async () => {
    const result = await render("ed-basic", "axisym_horn", { mouth_diameter: 300 });
    assert.equal(result.superseded, undefined);
    assert.equal(result.wallsUrl, "/api/preview/ed-basic/1/preview_walls.stl");
    assert.equal(result.drivenUrl, "/api/preview/ed-basic/1/preview_driven.stl");
    assert.equal(result.triangles, 1234);
    assert.deepEqual(result.bboxMm, [10, 20, 30]);
    assert.equal(result.vramBytes, 4096);
    assert.deepEqual(servedRequests()[0].params, { mouth_diameter: 300 });
  });

  test("each render gets its own generation, so a URL's contents never change", async () => {
    const first = await render("ed-seq");
    const second = await render("ed-seq");
    assert.equal(first.seq + 1, second.seq);
    assert.notEqual(first.wallsUrl, second.wallsUrl);
  });

  test("a generator that rejects the params fails the request, not the worker", async () => {
    await assert.rejects(render("ed-invalid", "broken_generator"), (err: Error) => {
      assert.match(err.message, /fake rejection/);
      assert.equal((err as InstanceType<typeof preview.PreviewError>).status, 422);
      return true;
    });
    // The next edit still renders: the worker survived.
    const after = await render("ed-invalid");
    assert.equal(after.superseded, undefined);
  });
});

describe("coalescing", () => {
  test("a newer edit supersedes an older queued one, and only the newest renders", async () => {
    // The first render occupies the worker; the next three queue, and each
    // displaces the one before it. This is what makes dragging a slider cost
    // one regeneration per settle rather than one per pixel.
    const all = await Promise.all([
      render("ed-drag", "axisym_horn", { length: 100 }),
      render("ed-drag", "axisym_horn", { length: 110 }),
      render("ed-drag", "axisym_horn", { length: 120 }),
      render("ed-drag", "axisym_horn", { length: 130 }),
    ]);

    const superseded = all.filter((r) => r.superseded);
    const rendered = all.filter((r) => !r.superseded);
    assert.equal(superseded.length, 2, "the two middle edits should never have been drawn");
    assert.equal(rendered.length, 2);

    const lengths = servedRequests().map((r) => r.params.length);
    assert.deepEqual(lengths, [100, 130], "only the in-flight and the newest edit reach the worker");
  });

  test("separate sessions never supersede each other", async () => {
    const [a, b] = await Promise.all([
      render("ed-one", "axisym_horn", { length: 100 }),
      render("ed-two", "axisym_horn", { length: 200 }),
    ]);
    assert.equal(a.superseded, undefined);
    assert.equal(b.superseded, undefined);
    assert.equal(servedRequests().length, 2);
  });
});

describe("session scratch directories", () => {
  test("keeps only the newest generations on disk", async () => {
    for (let i = 0; i < 6; i++) await render("ed-prune");
    const kept = fs
      .readdirSync(path.join(dataDir, "preview", "ed-prune"))
      .map(Number)
      .sort((x, y) => x - y);
    assert.deepEqual(kept, [4, 5, 6]);
  });

  test("dropSession removes the session's geometry", async () => {
    await render("ed-drop");
    const dir = path.join(dataDir, "preview", "ed-drop");
    assert.ok(fs.existsSync(dir));
    preview.dropSession("ed-drop");
    assert.ok(!fs.existsSync(dir));
  });

  test("rejects a sessionId that is not a plain name", async () => {
    for (const bad of ["../escape", "a/b", "", "x".repeat(65), "a b"])
      await assert.rejects(render(bad), /sessionId must match/);
  });
});

describe("resolvePreviewFile", () => {
  let seq: number;
  before(async () => {
    seq = (await render("ed-serve")).seq;
  });

  test("resolves the two files the worker actually produces", () => {
    for (const name of ["preview_walls.stl", "preview_driven.stl"]) {
      const file = preview.resolvePreviewFile("ed-serve", String(seq), name);
      assert.ok(file && fs.existsSync(file), `${name} should resolve`);
    }
  });

  test("refuses anything outside the allowlist", () => {
    const refused = [
      ["ed-serve", String(seq), "result.json"],
      ["ed-serve", String(seq), "../../state.json"],
      ["ed-serve", String(seq), "..\\preview_walls.stl"],
      ["../ed-serve", String(seq), "preview_walls.stl"],
      ["ed-serve", "../" + seq, "preview_walls.stl"],
      ["ed-serve", "not-a-number", "preview_walls.stl"],
      ["ed-serve", String(seq + 99), "preview_walls.stl"],
    ] as const;
    for (const [session, generation, file] of refused)
      assert.equal(
        preview.resolvePreviewFile(session, generation, file),
        null,
        `${session}/${generation}/${file} must not resolve`,
      );
  });
});

describe("worker recovery", () => {
  test("a dead worker is replaced on the next edit", async () => {
    await render("ed-recover");
    // Simulate the worker dying between edits (a crash, an OOM, a stray kill).
    preview.shutdownPreview();
    const after = await render("ed-recover");
    assert.equal(after.superseded, undefined);
    assert.equal(after.triangles, 1234);
  });
});
