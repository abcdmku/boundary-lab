/**
 * Wire and domain types for the vast.ai compute provider.
 *
 * Two layers live here on purpose:
 *
 *   Raw*      — what vast.ai's REST API actually returns. Deliberately loose
 *               (everything optional, `unknown` escape hatches) because the
 *               published OpenAPI specs and the reference CLI disagree in
 *               several places, and hosts return sparse rows.
 *   normalized — the shape this bridge and its UI speak: camelCase, sane
 *               units (GB not MB), and no field whose meaning changes
 *               depending on which endpoint produced it.
 *
 * Unit traps this module exists to absorb:
 *   - offer.gpu_ram / gpu_total_ram / cpu_ram are MB (24000 == 24 GB).
 *   - offer.storage_cost is $/GB/month; instance.storage_cost is $/hour.
 *     Same key, different meaning — they get different normalized names.
 *   - instance.duration from the server is the *contract* length, not uptime.
 *     Uptime is computed from start_date.
 *   - ports[].HostPort is a string.
 */

// ---------------------------------------------------------------------------
// raw wire shapes
// ---------------------------------------------------------------------------

/** A rentable offer as returned by POST /api/v0/bundles/ (`offers[]`). */
export interface RawVastOffer {
  id?: number;
  ask_contract_id?: number;
  machine_id?: number;
  host_id?: number;
  gpu_name?: string;
  num_gpus?: number;
  /** MB, per GPU. */
  gpu_ram?: number;
  /** MB, all GPUs. */
  gpu_total_ram?: number;
  gpu_arch?: string;
  cpu_name?: string;
  cpu_cores?: number;
  cpu_cores_effective?: number;
  /** MB. */
  cpu_ram?: number;
  /** GB. */
  disk_space?: number;
  disk_name?: string;
  disk_bw?: number;
  /** $/hour, everything included. */
  dph_total?: number;
  /** $/hour, GPU compute only. */
  dph_base?: number;
  /** On an OFFER this is $/GB/month. */
  storage_cost?: number;
  min_bid?: number;
  /** 0..1 */
  reliability?: number;
  /** 0..1 — the field name search results come back with. */
  reliability2?: number;
  cuda_max_good?: number;
  driver_version?: string;
  compute_cap?: number;
  inet_down?: number;
  inet_up?: number;
  inet_down_cost?: number;
  inet_up_cost?: number;
  /** Display string in responses ("Washington, US"); a country code in filters. */
  geolocation?: string;
  geolocode?: number;
  verification?: string;
  verified?: boolean;
  rentable?: boolean;
  rented?: boolean;
  external?: boolean;
  is_bid?: boolean;
  /** Ports the host router has free. Direct SSH + one app port needs >= 2. */
  direct_port_count?: number;
  public_ipaddr?: string;
  static_ip?: boolean;
  dlperf?: number;
  dlperf_per_dphtotal?: number;
  total_flops?: number;
  score?: number;
  /** Seconds of rental the host will still honour. */
  duration?: number;
  hosting_type?: number | string | null;
  datacenter?: unknown;
  [key: string]: unknown;
}

/** Docker-style port bindings: `{"8765/tcp": [{HostIp, HostPort}]}`. */
export type RawPortBindings = Record<string, Array<{ HostIp?: string; HostPort?: string }>>;

/** A rented instance (contract), from GET /api/v1/instances/ or /api/v0/instances/{id}/. */
export interface RawVastInstance {
  id?: number;
  machine_id?: number;
  label?: string | null;
  gpu_name?: string;
  num_gpus?: number;
  /** MB, per GPU. */
  gpu_ram?: number;
  gpu_total_ram?: number;
  cpu_name?: string;
  cpu_ram?: number;
  disk_space?: number;
  image_uuid?: string;
  /** Space-joined runtype string, e.g. "ssh ssh_direc ssh_proxy". */
  image_runtype?: string;
  /** null | loading | running | stopped | frozen | exited | rebooting | unknown | offline | created */
  actual_status?: string | null;
  /** running | stopped | frozen */
  intended_status?: string | null;
  cur_state?: string | null;
  next_state?: string | null;
  status_msg?: string | null;
  /** $/hour, total. */
  dph_total?: number;
  dph_base?: number;
  /** On an INSTANCE this is $/hour. */
  storage_cost?: number;
  storage_total_cost?: number;
  /** Epoch seconds (float). */
  start_date?: number;
  end_date?: number;
  /** Contract duration in seconds — NOT uptime. */
  duration?: number;
  uptime_mins?: number | null;
  is_bid?: boolean;
  min_bid?: number;
  /** SSH proxy endpoint (ssh####.vast.ai). */
  ssh_host?: string | null;
  ssh_port?: number | null;
  ssh_idx?: string | null;
  public_ipaddr?: string | null;
  /** Absent/null until the instance is running. */
  ports?: RawPortBindings | number[] | null;
  direct_port_start?: number;
  direct_port_end?: number;
  geolocation?: string | null;
  cuda_max_good?: number;
  reliability2?: number;
  /** Pricing breakdown of what is actually being charged right now. */
  instance?: {
    gpuCostPerHour?: number;
    diskHour?: number;
    totalHour?: number;
    discountedTotalPerHour?: number;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// normalized shapes (what the bridge API returns)
// ---------------------------------------------------------------------------

export interface VastOffer {
  /** Offer id — this is what you rent (`PUT /api/v0/asks/{id}/`). */
  id: number;
  machineId: number | null;
  hostId: number | null;
  gpuName: string;
  numGpus: number;
  /** GB per GPU (raw MB / 1000, matching vast's own 1000-based convention). */
  gpuRamGb: number;
  gpuTotalRamGb: number;
  gpuArch: string | null;
  cpuName: string | null;
  cpuCores: number | null;
  cpuRamGb: number | null;
  /** GB of disk the host can allocate. */
  diskGb: number;
  /** $/hour, all in. */
  pricePerHour: number;
  /** $/hour for GPU compute only. */
  gpuPricePerHour: number | null;
  /** $/GB/month. */
  storageCostPerGbMonth: number | null;
  /** 0..1 */
  reliability: number | null;
  cudaMaxGood: number | null;
  driverVersion: string | null;
  inetDownMbps: number | null;
  inetUpMbps: number | null;
  geolocation: string | null;
  verified: boolean;
  rentable: boolean;
  rented: boolean;
  /** Free ports on the host router. Direct SSH + a solver port needs >= 2. */
  directPortCount: number | null;
  dlperf: number | null;
  dlperfPerDollar: number | null;
  score: number | null;
  /** Seconds the host commits to. */
  maxDurationSeconds: number | null;
  /** Convenience for the UI: price for a 24 h rental at this rate. */
  estimatedDailyCost: number;
}

export interface VastSshEndpoint {
  host: string;
  port: number;
  user: string;
  /** true = straight to public_ipaddr:mapped-22; false = ssh####.vast.ai proxy. */
  direct: boolean;
}

export interface VastInstance {
  id: number;
  machineId: number | null;
  label: string | null;
  gpuName: string;
  numGpus: number;
  gpuRamGb: number;
  diskGb: number | null;
  image: string | null;
  runtype: string | null;
  /** Raw container state — see RawVastInstance.actual_status for the domain. */
  actualStatus: string | null;
  intendedStatus: string | null;
  curState: string | null;
  nextState: string | null;
  statusMsg: string | null;
  /** true once the contract is up and the container is running. */
  running: boolean;
  /** true when this state can never become `running` without intervention. */
  terminal: boolean;
  pricePerHour: number;
  /** $/hour of storage — keeps accruing while stopped, stops only on destroy. */
  storageCostPerHour: number | null;
  /** Epoch seconds. */
  startedAt: number | null;
  /** now - startedAt, seconds. Computed here; the API's `duration` is contract length. */
  uptimeSeconds: number | null;
  /** Estimated spend so far: uptimeHours * pricePerHour. See note in cost.ts. */
  estimatedCostUsd: number | null;
  publicIp: string | null;
  /** Normalized `{ "8765/tcp": 33526 }` — HostPort parsed to a number. */
  ports: Record<string, number>;
  ssh: VastSshEndpoint | null;
  geolocation: string | null;
  cudaMaxGood: number | null;
}

// ---------------------------------------------------------------------------
// managed-instance registry
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an instance *this bridge* manages. Distinct from vast's own
 * container status: an instance can be `running` on vast while still
 * `provisioning` (or `error`) from the solver's point of view.
 */
export type ManagedStatus =
  | "renting" // create accepted, contract not yet live
  | "starting" // waiting for first boot / ports
  | "provisioning" // bootstrap script running over SSH
  | "ready" // blab server answered /health
  | "error" // provisioning or health failed
  | "stopped" // deliberately stopped (disk still billing)
  | "destroyed" // destroyed on vast; kept briefly for the audit trail
  | "unknown";

export interface ManagedHealth {
  checkedAt: string;
  ok: boolean;
  /** Raw /health payload from blab server when ok. */
  payload?: unknown;
  solver?: string;
  backend?: string;
  error?: string;
  latencyMs?: number;
}

export interface ManagedProgress {
  stage: string;
  message: string;
  at: string;
}

export interface ManagedInstance {
  /** vast.ai contract id (the `new_contract` from create). */
  id: number;
  label: string;
  status: ManagedStatus;
  gpuName: string;
  numGpus: number;
  /** $/hour quoted at rent time — what the user explicitly confirmed. */
  pricePerHour: number;
  /** Offer this was rented from, when known. */
  offerId: number | null;
  image: string;
  diskGb: number;
  /** Container-internal port the blab server listens on. */
  solverPort: number;
  /** Public base URL of the blab server, once the port mapping is known. */
  serverUrl: string | null;
  ssh: VastSshEndpoint | null;
  createdAt: string;
  provisionedAt: string | null;
  /** Set when status === "error". */
  error: string | null;
  progress: ManagedProgress | null;
  lastHealth: ManagedHealth | null;
  /** Last observed live vast state, refreshed by list/get/health calls. */
  live: {
    actualStatus: string | null;
    intendedStatus: string | null;
    statusMsg: string | null;
    pricePerHour: number | null;
    startedAt: number | null;
    uptimeSeconds: number | null;
    estimatedCostUsd: number | null;
    refreshedAt: string;
  } | null;
}

/** The `vast` section persisted in state.json. */
export interface VastSection {
  instances: ManagedInstance[];
}
