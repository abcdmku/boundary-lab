/**
 * Provisioning a rented vast.ai instance into a working Boundary Lab solve
 * server, over SSH.
 *
 * Shape of the operation:
 *   1. wait for first boot   — poll the contract until the container is
 *                              running and its port mapping has appeared
 *   2. copy the bootstrap    — bridge/provision/vast_bootstrap.sh, piped over
 *                              stdin (no scp dependency)
 *   3. run it                — with configuration passed as environment
 *                              variables, streaming its progress markers
 *   4. verify                — GET /health on the PUBLIC url, proving the
 *                              port mapping works from here, not just inside
 *                              the container
 *
 * The heavy lifting (idempotence, caching onto the persistent disk, stage
 * fingerprinting) lives in the shell script; this file owns transport,
 * progress translation, and failure attribution. Everything that builds a
 * command line is a pure exported function so it can be unit tested without
 * touching the network or spawning anything.
 *
 * FAILURE MODES, and how each is reported:
 *   - contract never boots      -> "starting" stage fails with vast's status_msg
 *   - dead-end container state  -> fails fast (exited/offline never recover)
 *   - SSH unreachable           -> "ssh" stage, after bounded retries; the
 *                                  usual cause is the host's direct ports
 *                                  still opening, so retries are expected
 *   - SSH auth rejected         -> "ssh" stage, with the key file named
 *   - a bootstrap stage fails   -> that stage's name and the script's message
 *   - server starts but /health -> "verify" stage; the container is healthy
 *     is unreachable publicly      internally, so this is a port-mapping
 *                                  problem, and is reported as such
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { config } from "../config.ts";
import type { VastClient } from "./client.ts";
import { fatalInstanceReason, normalizeInstance, resolveServerUrl } from "./normalize.ts";
import * as registry from "./registry.ts";
import type { ManagedInstance, VastSshEndpoint } from "./types.ts";

export const BOOTSTRAP_SCRIPT = path.join(config.bridgeRoot, "provision", "vast_bootstrap.sh");
/** Where the script lands on the instance. */
export const REMOTE_SCRIPT_PATH = "/tmp/blab_bootstrap.sh";

export interface ProvisionOptions {
  /** Container-internal port for the blab server. */
  solverPort?: number;
  repoUrl?: string;
  repoRef?: string;
  cacheRoot?: string;
  solver?: string;
  juliaThreads?: string;
  /** Re-run every stage, ignoring the instance's stage stamps. */
  force?: boolean;
  /** Build the Julia sysimage — much faster solver start-up, ~20 min to build. */
  buildSysimage?: boolean;
  /** Seconds the remote script waits for /health before giving up. */
  healthTimeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// pure builders (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Environment handed to the bootstrap script. Keys mirror the `BLAB_*`
 * variables the script documents; nothing else is passed, so the remote
 * environment is fully described by this one function.
 */
export function buildProvisionEnv(options: ProvisionOptions = {}): Record<string, string> {
  const env: Record<string, string> = {
    BLAB_CACHE_ROOT: options.cacheRoot ?? config.vast.cacheRoot,
    BLAB_REPO_URL: options.repoUrl ?? config.vast.repoUrl,
    BLAB_REPO_REF: options.repoRef ?? config.vast.repoRef,
    BLAB_SERVER_PORT: String(options.solverPort ?? config.vast.solverPort),
    // Must bind all interfaces: the solve traffic arrives through docker's
    // published-port NAT, so a loopback bind would be unreachable.
    BLAB_SERVER_HOST: "0.0.0.0",
    BLAB_SOLVER: options.solver ?? "beat_cuda",
    BLAB_JULIA_THREADS: options.juliaThreads ?? "auto",
    BLAB_BUILD_SYSIMAGE: options.buildSysimage ? "1" : "0",
    BLAB_HEALTH_TIMEOUT: String(options.healthTimeoutSeconds ?? 300),
  };
  // Only send BLAB_FORCE when forcing: its mere presence with any value other
  // than "1" would be confusing in the remote log.
  if (options.force) env.BLAB_FORCE = "1";
  return env;
}

/** POSIX single-quote quoting for a value interpolated into a remote command. */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** `KEY='value' KEY2='value2'` prefix for the remote command. */
export function buildEnvPrefix(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

/** The exact remote command line that runs the bootstrap. */
export function buildRemoteCommand(env: Record<string, string>, scriptPath = REMOTE_SCRIPT_PATH): string {
  return `${buildEnvPrefix(env)} bash ${scriptPath}`;
}

export interface SshOptions {
  identityFile?: string | null;
  connectTimeoutSeconds?: number;
  knownHostsFile?: string;
}

/**
 * argv for `ssh`. BatchMode=yes is load-bearing: without it a missing key
 * turns into a password prompt that blocks forever on a detached child.
 * accept-new trusts a first-seen host but still catches a changed key, which
 * is the right trade for ephemeral rented boxes.
 */
export function buildSshArgs(
  endpoint: VastSshEndpoint,
  remoteCommand: string,
  options: SshOptions = {},
): string[] {
  const knownHosts = options.knownHostsFile ?? path.join(config.dataDir, "vast_known_hosts");
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", `ConnectTimeout=${options.connectTimeoutSeconds ?? 20}`,
    // Provisioning has multi-minute silent stretches (Julia precompile); without
    // keepalives an idle NAT on the path drops the session mid-build.
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=20",
    "-p", String(endpoint.port),
  ];
  const identity = options.identityFile ?? config.vast.sshKeyFile;
  if (identity) args.push("-o", "IdentitiesOnly=yes", "-i", identity);
  args.push(`${endpoint.user}@${endpoint.host}`, remoteCommand);
  return args;
}

// ---------------------------------------------------------------------------
// progress markers
// ---------------------------------------------------------------------------

export interface BootstrapMarker {
  kind: "stage" | "skip" | "ok" | "fail" | "result";
  stage: string;
  message: string;
}

/**
 * Parse one `::blab:<kind>:...` line. Returns null for ordinary output, which
 * the caller sends straight to the log.
 */
export function parseMarker(line: string): BootstrapMarker | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("::blab:")) return null;
  const rest = trimmed.slice("::blab:".length);
  const kindEnd = rest.indexOf(":");
  if (kindEnd < 0) return null;
  const kind = rest.slice(0, kindEnd);
  const remainder = rest.slice(kindEnd + 1);
  if (kind === "result") return { kind: "result", stage: "result", message: remainder };
  if (kind !== "stage" && kind !== "skip" && kind !== "ok" && kind !== "fail") return null;
  if (kind === "ok") return { kind, stage: remainder, message: "" };
  const stageEnd = remainder.indexOf(":");
  if (stageEnd < 0) return { kind, stage: remainder, message: "" };
  return { kind, stage: remainder.slice(0, stageEnd), message: remainder.slice(stageEnd + 1) };
}

// ---------------------------------------------------------------------------
// health probe
// ---------------------------------------------------------------------------

/**
 * GET {serverUrl}/health. Used both as the last provisioning step and as the
 * standalone health endpoint. Never throws — a failed probe is a result, not
 * an exception, because "the box is down" is normal operating information.
 */
export async function probeHealth(
  serverUrl: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; payload?: unknown; error?: string; latencyMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(`${serverUrl.replace(/\/$/, "")}/health`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, latencyMs };
    const payload: unknown = await response.json();
    return { ok: true, payload, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, error: aborted ? "timed out" : String(err), latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll a fresh contract until the container is running and its ports are
 * published. Fails fast on states that can never recover — waiting on those
 * just burns storage charges.
 */
export async function waitForInstanceReady(
  client: VastClient,
  instanceId: number,
  options: { solverPort: number; timeoutMs?: number; pollMs?: number; onProgress?: (message: string) => void },
): Promise<{ ssh: VastSshEndpoint; serverUrl: string | null }> {
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const pollMs = options.pollMs ?? 10_000; // vast asks for >= 10 s here
  const deadline = Date.now() + timeoutMs;
  let lastSeen = "pending";
  while (Date.now() < deadline) {
    const raw = await client.getInstance(instanceId);
    if (!raw) throw new Error(`instance ${instanceId} no longer exists on vast.ai`);
    const fatal = fatalInstanceReason(raw);
    if (fatal) throw new Error(`instance ${instanceId} will not start — ${fatal}`);
    const instance = normalizeInstance(raw, { solverPort: options.solverPort });
    lastSeen = instance.actualStatus ?? "pending";
    options.onProgress?.(`vast status: ${lastSeen}${instance.statusMsg ? ` — ${instance.statusMsg}` : ""}`);
    if (instance.running && instance.ssh) {
      return { ssh: instance.ssh, serverUrl: resolveServerUrl(raw, options.solverPort) };
    }
    await sleep(pollMs);
  }
  throw new Error(
    `instance ${instanceId} did not become ready within ${Math.round(timeoutMs / 60_000)} min ` +
      `(last status: ${lastSeen})`,
  );
}

interface SshRunResult {
  code: number | null;
  markers: BootstrapMarker[];
  failure: BootstrapMarker | null;
  result: string | null;
}

/**
 * Run one SSH command, streaming stdout through the marker parser and
 * appending everything to `logFile`. stdin, when given, is piped to the
 * remote command — that is how the bootstrap script gets copied across.
 */
function runSsh(
  endpoint: VastSshEndpoint,
  remoteCommand: string,
  options: {
    stdin?: string;
    logFile?: string;
    onMarker?: (marker: BootstrapMarker) => void;
    timeoutMs?: number;
  } = {},
): Promise<SshRunResult> {
  return new Promise((resolve, reject) => {
    const args = buildSshArgs(endpoint, remoteCommand);
    const child = spawn("ssh", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const logStream = options.logFile ? fs.createWriteStream(options.logFile, { flags: "a" }) : null;
    const markers: BootstrapMarker[] = [];
    let failure: BootstrapMarker | null = null;
    let result: string | null = null;
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      logStream?.end();
      fn();
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      logStream?.write(`${line}\n`);
      const marker = parseMarker(line);
      if (!marker) return;
      markers.push(marker);
      if (marker.kind === "fail") failure = marker;
      if (marker.kind === "result") result = marker.message;
      options.onMarker?.(marker);
    });
    child.stderr.on("data", (chunk: Buffer) => logStream?.write(chunk));

    child.on("error", (err) => finish(() => reject(new Error(`failed to run ssh: ${err.message}`))));
    child.on("close", (code) => finish(() => resolve({ code, markers, failure, result })));

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Wait for SSH to answer. A freshly booted vast container routinely refuses
 * connections for a minute or two while the host router opens the mapped
 * port, so a single failure means nothing.
 */
async function waitForSsh(
  endpoint: VastSshEndpoint,
  options: { attempts?: number; delayMs?: number; onProgress?: (message: string) => void } = {},
): Promise<void> {
  const attempts = options.attempts ?? 20;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.onProgress?.(`ssh attempt ${attempt}/${attempts} to ${endpoint.host}:${endpoint.port}`);
    try {
      const { code } = await runSsh(endpoint, "echo blab-ssh-ok", { timeoutMs: 45_000 });
      if (code === 0) return;
      lastError = `ssh exited ${code}`;
    } catch (err) {
      lastError = String(err);
    }
    await sleep(options.delayMs ?? 15_000);
  }
  throw new Error(
    `could not establish SSH to ${endpoint.user}@${endpoint.host}:${endpoint.port} after ${attempts} attempts ` +
      `(${lastError}). Check that the private key is loaded in your ssh-agent or set VAST_SSH_KEY_FILE, and ` +
      `that the matching public key was registered on vast.ai before the instance was created.`,
  );
}

/**
 * Full provisioning run for a registry entry. Long-running (a cold box spends
 * most of an hour in the Julia stage) and intended to be started without
 * awaiting: progress lands in the registry, which fans out over SSE.
 *
 * Idempotent end to end — re-running against a provisioned instance skips
 * every cached stage and just restarts the server, which is also the
 * supported way to pick up a new repo revision.
 */
export async function provisionInstance(
  client: VastClient,
  entry: ManagedInstance,
  options: ProvisionOptions = {},
): Promise<ManagedInstance> {
  const instanceId = entry.id;
  const solverPort = options.solverPort ?? entry.solverPort;
  const logFile = path.join(config.dataDir, "vast", `provision-${instanceId}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const progress = (stage: string, message: string) => {
    registry.setProgress(instanceId, stage, message);
    fs.appendFileSync(logFile, `[bridge] ${stage}: ${message}\n`);
  };

  try {
    registry.setStatus(instanceId, "starting");
    progress("starting", "waiting for the vast.ai container to boot");
    const ready = await waitForInstanceReady(client, instanceId, {
      solverPort,
      onProgress: (message) => progress("starting", message),
    });
    registry.patch(instanceId, { ssh: ready.ssh, serverUrl: ready.serverUrl });

    registry.setStatus(instanceId, "provisioning");
    progress("ssh", `connecting to ${ready.ssh.user}@${ready.ssh.host}:${ready.ssh.port}`);
    await waitForSsh(ready.ssh, { onProgress: (message) => progress("ssh", message) });

    // Copy the bootstrap. Normalizing CRLF matters: this repo is developed on
    // Windows and bash rejects a script with carriage returns in its shebang.
    progress("upload", "copying the bootstrap script");
    const script = fs.readFileSync(BOOTSTRAP_SCRIPT, "utf8").replace(/\r\n/g, "\n");
    const upload = await runSsh(ready.ssh, `cat > ${REMOTE_SCRIPT_PATH}`, {
      stdin: script,
      timeoutMs: 120_000,
    });
    if (upload.code !== 0) throw new Error(`failed to copy the bootstrap script (ssh exited ${upload.code})`);

    const env = buildProvisionEnv({ ...options, solverPort });
    progress("bootstrap", "running the bootstrap script");
    const run = await runSsh(ready.ssh, buildRemoteCommand(env), {
      logFile,
      timeoutMs: 3 * 60 * 60_000, // a cold Julia+CUDA build is genuinely slow
      onMarker: (marker) => {
        if (marker.kind === "stage") progress(marker.stage, marker.message);
        else if (marker.kind === "skip") progress(marker.stage, `${marker.message} (cached)`);
        else if (marker.kind === "ok") progress(marker.stage, "done");
      },
    });
    if (run.code !== 0) {
      const failure: BootstrapMarker | null = run.failure;
      throw new Error(
        failure
          ? `provisioning failed in the "${failure.stage}" stage: ${failure.message} (see ${logFile})`
          : `the bootstrap script exited ${run.code} (see ${logFile})`,
      );
    }

    // Re-read the contract: the public port mapping may only have appeared
    // once the server bound the port.
    const raw = await client.getInstance(instanceId);
    const serverUrl = raw ? resolveServerUrl(raw, solverPort) : null;
    if (!serverUrl)
      throw new Error(
        `the solve server started on the instance but vast.ai published no external mapping for port ` +
          `${solverPort}. The instance was likely rented from an offer with too few free host ports — ` +
          `search with minDirectPorts >= 2.`,
      );

    progress("verify", `checking ${serverUrl}/health from the bridge`);
    const health = await probeHealth(serverUrl, { timeoutMs: 20_000 });
    if (!health.ok)
      throw new Error(
        `the solve server is healthy inside the container but ${serverUrl}/health is unreachable from the ` +
          `bridge (${health.error}). This is a port-mapping/firewall problem, not a solver problem.`,
      );

    registry.patch(instanceId, {
      serverUrl,
      provisionedAt: new Date().toISOString(),
      error: null,
      progress: { stage: "ready", message: "solve server is live", at: new Date().toISOString() },
    });
    registry.setHealth(instanceId, {
      checkedAt: new Date().toISOString(),
      ok: true,
      payload: health.payload,
      latencyMs: health.latencyMs,
      ...extractSolverLabels(health.payload),
    });
    const provisioned = registry.get(instanceId);
    // The entry can be forgotten while a multi-hour provision is in flight.
    // That is a legitimate operator action, not an error to throw over.
    if (!provisioned) throw new Error(`instance ${instanceId} was removed from the registry during provisioning`);
    return provisioned;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    registry.setStatus(instanceId, "error", message);
    fs.appendFileSync(logFile, `[bridge] FAILED: ${message}\n`);
    throw err;
  }
}

/** Pull the solver/backend labels out of a /health payload, if present. */
export function extractSolverLabels(payload: unknown): { solver?: string; backend?: string } {
  if (payload === null || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  return {
    ...(typeof record.solver === "string" ? { solver: record.solver } : {}),
    ...(typeof record.backend === "string" ? { backend: record.backend } : {}),
  };
}
