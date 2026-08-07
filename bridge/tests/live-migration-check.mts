/**
 * One-shot verification against a COPY of a real bridge/data directory.
 * Not part of `npm test` (it needs live data); run it before deploying a
 * schema change:
 *
 *   cp -r bridge/data /tmp/blab-check
 *   DATA_DIR=/tmp/blab-check npx tsx tests/live-migration-check.mts
 */
import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error("set DATA_DIR to a COPY of bridge/data");

const before = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
const legacyRuns: Record<string, unknown>[] = before.runs ?? before.jobs;
const beforeFiles = new Map<string, number>();
const walk = (root: string, base: string) => {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, base);
    else beforeFiles.set(path.relative(base, full).split(path.sep).join("/"), fs.statSync(full).size);
  }
};
walk(path.join(dataDir, "runs"), path.join(dataDir, "runs"));

/** Artifact URLs whose file was ALREADY missing before we touched anything —
 *  dangling records from hand-edited job dirs, not migration damage. */
const danglingBefore = new Set<string>();
for (const run of legacyRuns) {
  const id = String(run.id);
  for (const artifact of (run.artifacts ?? []) as { url: string }[]) {
    const rel = decodeURIComponent(artifact.url.replace(`/artifacts/${id}/`, ""));
    if (!fs.existsSync(path.join(dataDir, "runs", id, ...rel.split("/"))))
      danglingBefore.add(artifact.url);
  }
}

const store = await import("../src/store.ts");
store.loadStore();

const problems: string[] = [];
const check = (ok: boolean, msg: string) => {
  if (!ok) problems.push(msg);
  console.log(`${ok ? "  ok  " : " FAIL "} ${msg}`);
};

const jobs = store.listJobs();
check(jobs.length === legacyRuns.length, `all ${legacyRuns.length} records migrated (got ${jobs.length})`);

for (const run of legacyRuns) {
  const id = String(run.id);
  const job = store.getJob(id);
  if (!job) {
    check(false, `job ${id} present`);
    continue;
  }
  check(job.name === run.name, `${id} name preserved`);
  check(
    job.parentJobId === (run.parentRunId ?? (run as { parentJobId?: string }).parentJobId),
    `${id} parent link preserved`,
  );
  const legacyParams = (run.params ?? {}) as Record<string, unknown>;
  if (legacyParams.meshRunId)
    check(job.params.meshJobId === legacyParams.meshRunId, `${id} params.meshRunId -> meshJobId`);
  const legacyArtifacts = (run.artifacts ?? []) as { url: string }[];
  check(
    job.artifacts.length === legacyArtifacts.length &&
      legacyArtifacts.every((a) => job.artifacts.some((b) => b.url === a.url)),
    `${id} keeps all ${legacyArtifacts.length} artifact URLs verbatim`,
  );
  for (const artifact of job.artifacts) {
    if (danglingBefore.has(artifact.url)) {
      console.log(` skip  ${id} artifact ${artifact.name} was already missing before migration`);
      continue;
    }
    const rel = decodeURIComponent(artifact.url.replace(`/artifacts/${id}/`, ""));
    const file = path.join(store.jobDir(id), ...rel.split("/"));
    check(fs.existsSync(file), `${id} artifact ${artifact.name} resolves on disk`);
  }
}

// every file that lived under data/runs is still there under data/jobs
let moved = 0;
for (const [rel, size] of beforeFiles) {
  const file = path.join(dataDir, "jobs", ...rel.split("/"));
  if (fs.existsSync(file) && fs.statSync(file).size === size) moved++;
}
check(moved === beforeFiles.size, `all ${beforeFiles.size} files moved to data/jobs intact (${moved})`);
check(fs.existsSync(path.join(dataDir, "state.json.v1.bak")), "v1 backup written");

store.flushState();
const after = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
check(after.version === 2 && Array.isArray(after.jobs) && !after.runs, "state.json is v2");

console.log(problems.length === 0 ? "\nLIVE MIGRATION OK" : `\n${problems.length} PROBLEM(S)`);
process.exit(problems.length === 0 ? 0 : 1);
