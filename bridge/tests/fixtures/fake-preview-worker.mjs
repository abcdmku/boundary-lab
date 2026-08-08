/**
 * Stand-in for bridge/py/mesh_preview_worker.py: speaks the same NDJSON
 * request/response contract without gmsh, so the preview tests stay hermetic
 * and fast.
 *
 *   FAKE_PREVIEW_DELAY_MS  how long each request "renders" (default 60)
 *   FAKE_PREVIEW_FAIL      generator id that answers {"ok": false}
 *   FAKE_PREVIEW_HANG      generator id that never answers at all
 *   FAKE_PREVIEW_LOG       file to append one line per served request to
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const delay = Number(process.env.FAKE_PREVIEW_DELAY_MS ?? 60);
const logFile = process.env.FAKE_PREVIEW_LOG;

process.stdout.write(JSON.stringify({ event: "ready" }) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const request = JSON.parse(trimmed);
  if (logFile) fs.appendFileSync(logFile, JSON.stringify(request) + "\n");
  if (request.generator === process.env.FAKE_PREVIEW_HANG) return;

  setTimeout(() => {
    if (request.generator === process.env.FAKE_PREVIEW_FAIL) {
      process.stdout.write(
        JSON.stringify({ id: request.id, ok: false, error: "ValueError: fake rejection" }) + "\n",
      );
      return;
    }
    // Real STL bytes are irrelevant here; the files only have to exist where
    // the bridge says they do, because that is what it hands the browser.
    fs.mkdirSync(request.out, { recursive: true });
    const walls = path.join(request.out, "preview_walls.stl");
    const driven = path.join(request.out, "preview_driven.stl");
    fs.writeFileSync(walls, "solid fake\nendsolid fake\n");
    fs.writeFileSync(driven, "solid fake\nendsolid fake\n");
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        ok: true,
        walls,
        driven,
        triangles: 1234,
        vertices: 617,
        bbox_mm: [10, 20, 30],
        mirror_axes: ["x"],
        quality_warning: null,
        vram_bytes: 4096,
        elapsed_ms: delay,
        params: request.params,
      }) + "\n",
    );
  }, delay);
});
