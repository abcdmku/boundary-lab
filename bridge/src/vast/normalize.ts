/**
 * Raw vast.ai rows -> the shapes this bridge and its UI speak.
 *
 * Everything here is pure and total: hosts return sparse rows and two of
 * vast's own published specs are stale, so every field is defensive. The
 * conversions that matter:
 *
 *   gpu_ram (MB, 1000-based)          -> gpuRamGb
 *   offer.storage_cost ($/GB/month)   -> storageCostPerGbMonth
 *   instance.storage_cost ($/hour)    -> storageCostPerHour     (SAME KEY!)
 *   start_date (epoch s)              -> uptimeSeconds, estimatedCostUsd
 *   ports {"22/tcp":[{HostPort:"33525"}]} -> { "22/tcp": 33525 } and an ssh endpoint
 */
import type {
  RawPortBindings,
  RawVastInstance,
  RawVastOffer,
  VastInstance,
  VastOffer,
  VastSshEndpoint,
} from "./types.ts";

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};
const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** vast counts VRAM in MB where 1 GB == 1000 MB. */
const mbToGb = (value: unknown): number | null => {
  const mb = num(value);
  return mb === null ? null : Math.round((mb / 1000) * 10) / 10;
};

const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

// ---------------------------------------------------------------------------
// offers
// ---------------------------------------------------------------------------

export function normalizeOffer(raw: RawVastOffer): VastOffer {
  const pricePerHour = num(raw.dph_total) ?? 0;
  return {
    id: num(raw.id) ?? -1,
    machineId: num(raw.machine_id),
    hostId: num(raw.host_id),
    gpuName: str(raw.gpu_name) ?? "unknown GPU",
    numGpus: num(raw.num_gpus) ?? 1,
    gpuRamGb: mbToGb(raw.gpu_ram) ?? 0,
    gpuTotalRamGb: mbToGb(raw.gpu_total_ram) ?? 0,
    gpuArch: str(raw.gpu_arch),
    cpuName: str(raw.cpu_name),
    cpuCores: num(raw.cpu_cores_effective) ?? num(raw.cpu_cores),
    cpuRamGb: mbToGb(raw.cpu_ram),
    diskGb: num(raw.disk_space) ?? 0,
    pricePerHour,
    gpuPricePerHour: num(raw.dph_base),
    storageCostPerGbMonth: num(raw.storage_cost),
    // Search results carry reliability2; the filterable name is `reliability`.
    reliability: num(raw.reliability2) ?? num(raw.reliability),
    cudaMaxGood: num(raw.cuda_max_good),
    driverVersion: str(raw.driver_version),
    inetDownMbps: num(raw.inet_down),
    inetUpMbps: num(raw.inet_up),
    geolocation: str(raw.geolocation),
    verified: raw.verified === true || str(raw.verification) === "verified",
    rentable: raw.rentable !== false,
    rented: raw.rented === true,
    directPortCount: num(raw.direct_port_count),
    dlperf: num(raw.dlperf),
    dlperfPerDollar: num(raw.dlperf_per_dphtotal),
    score: num(raw.score),
    maxDurationSeconds: num(raw.duration),
    estimatedDailyCost: round(pricePerHour * 24, 2),
  };
}

// ---------------------------------------------------------------------------
// instances
// ---------------------------------------------------------------------------

/**
 * Container states that will never become "running" on their own. A poller
 * that does not fail fast on these burns money: the contract keeps billing
 * disk while the caller waits forever.
 */
export const DEAD_END_STATUSES: ReadonlySet<string> = new Set(["exited", "offline", "unknown", "destroyed"]);

/** Normalize the port map, absorbing the stale "array of ints" spec shape. */
export function normalizePorts(raw: RawVastInstance["ports"]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    // Stale spec shape ([8080, 8081]): no external mapping is knowable, but
    // record the internal ports so callers can at least see what was published.
    for (const port of raw) {
      const parsed = num(port);
      if (parsed !== null) out[`${parsed}/tcp`] = parsed;
    }
    return out;
  }
  for (const [key, bindings] of Object.entries(raw as RawPortBindings)) {
    if (!Array.isArray(bindings) || bindings.length === 0) continue;
    // HostPort is a STRING on the wire.
    const hostPort = num(bindings[0]?.HostPort);
    if (hostPort !== null) out[key] = hostPort;
  }
  return out;
}

/**
 * Where to SSH. Mirrors the official CLI exactly:
 *   - direct when a 22/tcp mapping exists -> public_ipaddr : mapped port
 *   - otherwise the proxy ssh_host:ssh_port, with the +1 quirk for jupyter
 *     runtypes (the proxy allocates the SSH port one above the listed one).
 * Returns null while the instance is still booting and has no endpoint yet.
 */
export function resolveSshEndpoint(raw: RawVastInstance): VastSshEndpoint | null {
  const ports = normalizePorts(raw.ports);
  const mapped22 = ports["22/tcp"];
  const publicIp = str(raw.public_ipaddr);
  if (mapped22 !== undefined && publicIp) {
    return { host: publicIp, port: mapped22, user: "root", direct: true };
  }
  const proxyHost = str(raw.ssh_host);
  const proxyPort = num(raw.ssh_port);
  if (proxyHost && proxyPort !== null) {
    const runtype = str(raw.image_runtype) ?? "";
    const port = runtype.includes("jupyter") ? proxyPort + 1 : proxyPort;
    return { host: proxyHost, port, user: "root", direct: false };
  }
  return null;
}

/**
 * Public base URL of the blab server running inside the container, derived
 * from the published mapping for `solverPort`. Null until the instance is
 * running and the mapping has appeared.
 */
export function resolveServerUrl(raw: RawVastInstance, solverPort: number): string | null {
  const ports = normalizePorts(raw.ports);
  const mapped = ports[`${solverPort}/tcp`];
  const publicIp = str(raw.public_ipaddr);
  if (mapped === undefined || !publicIp) return null;
  return `http://${publicIp}:${mapped}`;
}

/**
 * Estimated spend so far. Deliberately labelled an estimate:
 *   - billing is per second against the CURRENT rate, which can move on bid
 *     instances;
 *   - time spent stopped bills at the disk rate, not dph_total, so an
 *     instance that was ever stopped is over-estimated here;
 *   - bandwidth is billed separately and is not included.
 * For an authoritative figure the vast console (or /instances/balance/{id}/)
 * is the source of truth.
 */
export function estimateCost(
  startDateEpochSeconds: number | null,
  pricePerHour: number | null,
  nowMs: number = Date.now(),
): { uptimeSeconds: number | null; estimatedCostUsd: number | null } {
  if (startDateEpochSeconds === null || startDateEpochSeconds <= 0)
    return { uptimeSeconds: null, estimatedCostUsd: null };
  const uptimeSeconds = Math.max(0, Math.round(nowMs / 1000 - startDateEpochSeconds));
  if (pricePerHour === null) return { uptimeSeconds, estimatedCostUsd: null };
  return { uptimeSeconds, estimatedCostUsd: round((uptimeSeconds / 3600) * pricePerHour, 4) };
}

export function normalizeInstance(
  raw: RawVastInstance,
  options: { solverPort?: number; nowMs?: number } = {},
): VastInstance {
  const actualStatus = str(raw.actual_status);
  const intendedStatus = str(raw.intended_status);
  const pricePerHour = num(raw.dph_total) ?? 0;
  const startedAt = num(raw.start_date);
  const { uptimeSeconds, estimatedCostUsd } = estimateCost(startedAt, pricePerHour, options.nowMs);
  return {
    id: num(raw.id) ?? -1,
    machineId: num(raw.machine_id),
    label: str(raw.label),
    gpuName: str(raw.gpu_name) ?? "unknown GPU",
    numGpus: num(raw.num_gpus) ?? 1,
    gpuRamGb: mbToGb(raw.gpu_ram) ?? 0,
    diskGb: num(raw.disk_space),
    image: str(raw.image_uuid),
    runtype: str(raw.image_runtype),
    actualStatus,
    intendedStatus,
    curState: str(raw.cur_state),
    nextState: str(raw.next_state),
    statusMsg: str(raw.status_msg),
    // The CLI's own readiness test: the contract wants running AND the
    // container reports running.
    running: actualStatus === "running" && intendedStatus === "running",
    terminal: actualStatus !== null && DEAD_END_STATUSES.has(actualStatus),
    pricePerHour,
    // On an INSTANCE storage_cost is $/hour (on an offer it is $/GB/month).
    storageCostPerHour: num(raw.storage_cost),
    startedAt,
    uptimeSeconds,
    estimatedCostUsd,
    publicIp: str(raw.public_ipaddr),
    ports: normalizePorts(raw.ports),
    ssh: resolveSshEndpoint(raw),
    geolocation: str(raw.geolocation),
    cudaMaxGood: num(raw.cuda_max_good),
  };
}

/**
 * Why an instance can never reach `running`, or null if it still might.
 * `status_msg` containing "Error" is vast's own signal that the container
 * failed to start (bad image, host problem).
 */
export function fatalInstanceReason(raw: RawVastInstance): string | null {
  const statusMsg = str(raw.status_msg);
  if (statusMsg && /error/i.test(statusMsg)) return `vast reported an error: ${statusMsg}`;
  const actualStatus = str(raw.actual_status);
  if (actualStatus && DEAD_END_STATUSES.has(actualStatus))
    return `instance is "${actualStatus}"${statusMsg ? ` (${statusMsg})` : ""} and will not start`;
  return null;
}
