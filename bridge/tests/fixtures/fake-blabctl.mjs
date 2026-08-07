/**
 * Stand-in for bridge/py/blabctl.py in the queue tests: speaks the same NDJSON
 * contract, records the argv it was called with, and takes a controllable
 * amount of time so lane concurrency is observable.
 *
 *   FAKE_DELAY_MS  how long to "work" before emitting the result (default 300)
 *   FAKE_FAIL      emit {"ok":false} instead of a success result
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

// Capability probe (targets.blabctlSupportsServerUrl) shells out to
// `solve --help` and reads the argparse banner. FAKE_NO_SERVER_URL makes this
// stand-in look like a blabctl from before the remote-solve flag landed.
if (argv.includes("--help")) {
  const serverUrl = process.env.FAKE_NO_SERVER_URL ? "" : " [--server-url SERVER_URL]";
  process.stdout.write(
    `usage: blabctl solve [-h] --mesh-run MESH_RUN --out OUT [--fmin FMIN] [--fmax FMAX]\n` +
      `                     [--count COUNT] [--backend BACKEND] [--symmetry {off,x,xy}]${serverUrl}\n`,
  );
  process.exit(0);
}

const outIndex = argv.indexOf("--out");
const outDir = outIndex >= 0 ? argv[outIndex + 1] : null;
const delay = Number(process.env.FAKE_DELAY_MS ?? 300);

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "argv.json"), JSON.stringify(argv, null, 2));
  // A start marker with a timestamp lets a test prove two jobs overlapped.
  fs.appendFileSync(path.join(outDir, "started-at"), `${Date.now()}\n`);
}

process.stdout.write(
  JSON.stringify({ event: "progress", stage: "fake", message: "working", done: 0, total: 1 }) + "\n",
);

setTimeout(() => {
  if (process.env.FAKE_FAIL) {
    process.stdout.write(JSON.stringify({ event: "result", ok: false, error: "fake failure" }) + "\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ event: "result", ok: true, fake: true, argv }) + "\n");
  process.exit(0);
}, delay);
