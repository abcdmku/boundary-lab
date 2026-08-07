/**
 * Provisioning: script-argument construction, SSH command assembly, and the
 * progress-marker protocol. No SSH connection is ever opened here — only the
 * pure builders are exercised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-vast-provision-"));
process.env.DATA_DIR = path.join(tempDir, "data");

const {
  buildProvisionEnv,
  buildEnvPrefix,
  buildRemoteCommand,
  buildSshArgs,
  shellQuote,
  parseMarker,
  probeHealth,
  extractSolverLabels,
  BOOTSTRAP_SCRIPT,
  REMOTE_SCRIPT_PATH,
} = await import("../src/vast/provision.ts");
const { config } = await import("../src/config.ts");

const sshEndpoint = { host: "65.130.162.74", port: 33525, user: "root", direct: true };

// ---------------------------------------------------------------------------
// provisioning environment
// ---------------------------------------------------------------------------

test("the default environment fully describes the remote run", () => {
  const env = buildProvisionEnv();
  assert.equal(env.BLAB_SERVER_PORT, String(config.vast.solverPort));
  assert.equal(env.BLAB_SOLVER, "beat_cuda");
  assert.equal(env.BLAB_CACHE_ROOT, config.vast.cacheRoot);
  assert.equal(env.BLAB_REPO_URL, config.vast.repoUrl);
  assert.equal(env.BLAB_REPO_REF, config.vast.repoRef);
  // Must bind all interfaces: solve traffic arrives through docker's NAT, so
  // a loopback bind would be unreachable from outside the container.
  assert.equal(env.BLAB_SERVER_HOST, "0.0.0.0");
  assert.equal(env.BLAB_BUILD_SYSIMAGE, "0", "the slow sysimage build is opt-in");
});

test("BLAB_FORCE is only present when a re-run is actually forced", () => {
  assert.ok(!("BLAB_FORCE" in buildProvisionEnv()));
  assert.ok(!("BLAB_FORCE" in buildProvisionEnv({ force: false })));
  assert.equal(buildProvisionEnv({ force: true }).BLAB_FORCE, "1");
});

test("overrides reach the remote environment", () => {
  const env = buildProvisionEnv({
    solverPort: 9100,
    repoRef: "feat/thing",
    solver: "beat_cpu",
    cacheRoot: "/data/cache",
    juliaThreads: "8",
    buildSysimage: true,
    healthTimeoutSeconds: 900,
  });
  assert.equal(env.BLAB_SERVER_PORT, "9100");
  assert.equal(env.BLAB_REPO_REF, "feat/thing");
  assert.equal(env.BLAB_SOLVER, "beat_cpu");
  assert.equal(env.BLAB_CACHE_ROOT, "/data/cache");
  assert.equal(env.BLAB_JULIA_THREADS, "8");
  assert.equal(env.BLAB_BUILD_SYSIMAGE, "1");
  assert.equal(env.BLAB_HEALTH_TIMEOUT, "900");
});

// ---------------------------------------------------------------------------
// shell quoting
// ---------------------------------------------------------------------------

test("values are single-quoted so shell metacharacters cannot escape", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("with space"), "'with space'");
  assert.equal(shellQuote("a;rm -rf /"), "'a;rm -rf /'");
  assert.equal(shellQuote("$(whoami)"), "'$(whoami)'");
  assert.equal(shellQuote("back`tick`"), "'back`tick`'");
});

test("an embedded single quote is escaped rather than closing the quote", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

/**
 * A POSIX single-quoted token is inert iff it starts and ends with a quote and
 * every interior quote belongs to a `'\''` escape sequence. Checking that
 * property is the real test — the payload text itself is *expected* to appear
 * verbatim inside the quotes, harmlessly.
 */
function isInertlyQuoted(token: string): boolean {
  if (!token.startsWith("'") || !token.endsWith("'")) return false;
  // Remove the escape sequences, then the outer quotes: nothing should remain.
  const withoutEscapes = token.slice(1, -1).split(`'\\''`).join("");
  return !withoutEscapes.includes("'");
}

test("a branch name containing shell metacharacters stays inert", () => {
  const payload = "'; touch /tmp/pwned; #";
  const quoted = shellQuote(payload);
  assert.equal(quoted, `''\\''; touch /tmp/pwned; #'`);
  assert.ok(isInertlyQuoted(quoted), `payload could break out of quoting: ${quoted}`);

  const command = buildRemoteCommand(buildProvisionEnv({ repoRef: payload }));
  assert.ok(command.includes(`BLAB_REPO_REF=${quoted}`), "the value must reach the command quoted");
});

test("every provisioning value is inertly quoted, whatever it contains", () => {
  const nasties = ["a b", "it's", "$(id)", "`id`", "x\ny", '"dq"', "back\\slash", "*", "&& rm -rf /"];
  for (const nasty of nasties) {
    assert.ok(isInertlyQuoted(shellQuote(nasty)), `not inert: ${nasty}`);
  }
});

test("the env prefix is a sequence of KEY='value' assignments", () => {
  const prefix = buildEnvPrefix({ A: "1", B: "two words" });
  assert.equal(prefix, "A='1' B='two words'");
});

test("the remote command runs the uploaded script under bash with the env prefix", () => {
  const command = buildRemoteCommand({ BLAB_SERVER_PORT: "8765" });
  assert.equal(command, `BLAB_SERVER_PORT='8765' bash ${REMOTE_SCRIPT_PATH}`);
});

// ---------------------------------------------------------------------------
// ssh args
// ---------------------------------------------------------------------------

test("ssh args are non-interactive and carry the port, user and host", () => {
  const args = buildSshArgs(sshEndpoint, "echo hi");
  // BatchMode is load-bearing: without it a missing key becomes a password
  // prompt that blocks a detached child forever.
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("StrictHostKeyChecking=accept-new"));
  assert.deepEqual(args.slice(-2), ["root@65.130.162.74", "echo hi"]);
  const portIndex = args.indexOf("-p");
  assert.equal(args[portIndex + 1], "33525");
});

test("keepalives are set so a long silent build is not dropped by an idle NAT", () => {
  const args = buildSshArgs(sshEndpoint, "x");
  assert.ok(args.includes("ServerAliveInterval=30"));
  assert.ok(args.includes("ServerAliveCountMax=20"));
});

test("an identity file is passed with IdentitiesOnly so agent keys cannot shadow it", () => {
  const args = buildSshArgs(sshEndpoint, "x", { identityFile: "C:/keys/vast_ed25519" });
  assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.equal(args[args.indexOf("-i") + 1], "C:/keys/vast_ed25519");
});

test("no identity file means no -i, leaving ssh-agent to answer", () => {
  const args = buildSshArgs(sshEndpoint, "x", { identityFile: null });
  assert.ok(!args.includes("-i"));
});

test("host keys are kept in the bridge data dir, not the user's known_hosts", () => {
  const args = buildSshArgs(sshEndpoint, "x");
  const knownHosts = args.find((arg) => arg.startsWith("UserKnownHostsFile="));
  assert.ok(knownHosts?.includes("vast_known_hosts"));
});

// ---------------------------------------------------------------------------
// progress markers
// ---------------------------------------------------------------------------

test("stage, skip, ok, fail and result markers parse", () => {
  assert.deepEqual(parseMarker("::blab:stage:julia:installing Julia"), {
    kind: "stage",
    stage: "julia",
    message: "installing Julia",
  });
  assert.deepEqual(parseMarker("::blab:skip:python:venv already matches"), {
    kind: "skip",
    stage: "python",
    message: "venv already matches",
  });
  assert.deepEqual(parseMarker("::blab:ok:repo"), { kind: "ok", stage: "repo", message: "" });
  assert.deepEqual(parseMarker("::blab:fail:health:no response in 300 s"), {
    kind: "fail",
    stage: "health",
    message: "no response in 300 s",
  });
});

test("a result marker keeps its JSON payload intact", () => {
  const marker = parseMarker('::blab:result:{"repoRev":"abc","port":8765}');
  assert.equal(marker?.kind, "result");
  assert.deepEqual(JSON.parse(marker!.message), { repoRev: "abc", port: 8765 });
});

test("a message containing colons is not truncated", () => {
  const marker = parseMarker("::blab:stage:julia:pinning runtime 12.6: this takes a while");
  assert.equal(marker?.message, "pinning runtime 12.6: this takes a while");
});

test("ordinary output is not mistaken for a marker", () => {
  assert.equal(parseMarker("Resolving deltas: 100% (42/42), done."), null);
  assert.equal(parseMarker(""), null);
  assert.equal(parseMarker("::blab:"), null);
  assert.equal(parseMarker("::blab:nonsense:x"), null);
});

test("markers are recognised with surrounding whitespace", () => {
  assert.equal(parseMarker("  ::blab:ok:repo  ")?.stage, "repo");
});

// ---------------------------------------------------------------------------
// the bootstrap script itself
// ---------------------------------------------------------------------------

test("the bootstrap script ships with the bridge and is a bash script", () => {
  assert.ok(fs.existsSync(BOOTSTRAP_SCRIPT), `missing ${BOOTSTRAP_SCRIPT}`);
  const script = fs.readFileSync(BOOTSTRAP_SCRIPT, "utf8");
  assert.ok(script.startsWith("#!/usr/bin/env bash"));
  assert.match(script, /set -euo pipefail/);
});

test("every BLAB_ variable the builder sends is consumed by the script", () => {
  const script = fs.readFileSync(BOOTSTRAP_SCRIPT, "utf8");
  const sent = Object.keys(buildProvisionEnv({ force: true }));
  for (const name of sent) {
    assert.match(script, new RegExp(`\\$\\{${name}`), `${name} is sent but never read by the script`);
  }
});

test("the script emits every marker kind the parser understands", () => {
  const script = fs.readFileSync(BOOTSTRAP_SCRIPT, "utf8");
  for (const kind of ["stage", "skip", "ok", "fail", "result"]) {
    assert.match(script, new RegExp(`::blab:${kind}`), `the script never emits a ${kind} marker`);
  }
});

// ---------------------------------------------------------------------------
// health probe
// ---------------------------------------------------------------------------

test("a healthy server yields ok plus the payload", async () => {
  const payload = { status: "ok", solver: "beat_cuda", backend: "beat_cuda" };
  const fetchImpl = (async (url: string) => {
    assert.ok(String(url).endsWith("/health"));
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  const health = await probeHealth("http://1.2.3.4:33526", { fetchImpl });
  assert.equal(health.ok, true);
  assert.deepEqual(health.payload, payload);
});

test("a trailing slash on the server URL does not produce a double slash", async () => {
  let seen = "";
  const fetchImpl = (async (url: string) => {
    seen = String(url);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await probeHealth("http://1.2.3.4:33526/", { fetchImpl });
  assert.equal(seen, "http://1.2.3.4:33526/health");
});

test("an unreachable server is a result, never an exception", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const health = await probeHealth("http://1.2.3.4:33526", { fetchImpl });
  assert.equal(health.ok, false);
  assert.match(health.error ?? "", /ECONNREFUSED/);
});

test("an HTTP error status is reported as unhealthy", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 502 })) as typeof fetch;
  const health = await probeHealth("http://1.2.3.4:33526", { fetchImpl });
  assert.equal(health.ok, false);
  assert.equal(health.error, "HTTP 502");
});

test("solver labels are lifted out of a health payload, tolerating any shape", () => {
  assert.deepEqual(extractSolverLabels({ solver: "beat_cuda", backend: "beat_cuda", extra: 1 }), {
    solver: "beat_cuda",
    backend: "beat_cuda",
  });
  // The parallel server stream is adding GPU/VRAM fields; unknown shapes must
  // pass through without breaking this.
  assert.deepEqual(extractSolverLabels({ gpu: { name: "RTX 4090" } }), {});
  assert.deepEqual(extractSolverLabels(null), {});
  assert.deepEqual(extractSolverLabels("not an object"), {});
});
