/**
 * vast.ai REST client.
 *
 * Endpoints used (base https://console.vast.ai, Bearer auth, trailing slashes
 * are significant):
 *
 *   POST   /api/v0/bundles/            search offers      -> { offers: [...] }
 *   GET    /api/v1/instances/          list instances     -> { instances: [...], next_token }
 *   GET    /api/v0/instances/{id}/     instance detail    -> { instances: {...} }   (OBJECT)
 *   PUT    /api/v0/asks/{offerId}/     rent               -> { success, new_contract }
 *   PUT    /api/v0/instances/{id}/     start/stop/label   -> { success, msg }
 *   DELETE /api/v0/instances/{id}/     destroy            -> { success, msg }
 *   POST   /api/v0/instances/{id}/ssh/ attach ssh key     -> { success, msg }
 *   GET    /api/v0/users/current/      key smoke test
 *
 * Deliberate quirks, each learned from vast's own CLI:
 *   - The search response key is `offers`, never `bundles`.
 *   - `instances` is an ARRAY on the v1 list endpoint and an OBJECT on the v0
 *     detail endpoint. Handled separately, never shared.
 *   - Rent returns the new instance id as `new_contract`, not `id`.
 *   - The v0 list endpoint is deprecated; v1 is paginated with `next_token`
 *     and caps `limit` at 25.
 *   - Search is rate-limited to 10 requests/minute per IP and create wants
 *     ~4.5 s between calls; 429s get bounded retry with backoff.
 *
 * The API key only ever travels in an Authorization header, so no URL, log
 * line or error message can carry it.
 */
import { config } from "../config.ts";
import { redact, resolveKey } from "./key.ts";
import type { RawVastInstance, RawVastOffer } from "./types.ts";

export class VastError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "VastError";
  }
}

/** Thrown when no API key is configured — distinct so routes can answer 501. */
export class VastNotConfiguredError extends Error {
  constructor() {
    super(
      "no vast.ai API key configured — set VAST_API_KEY, or write the key to " +
        "~/.vast_api_key (the location the official vast CLI uses)",
    );
    this.name = "VastNotConfiguredError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface VastClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Retries for 429/5xx. 0 disables. */
  maxRetries?: number;
  /** Injectable for tests so backoff does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// offer search query building  (pure — the main unit-tested surface)
// ---------------------------------------------------------------------------

export type QueryOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notin";
export type OfferQuery = Record<string, unknown>;

export interface OfferSearchFilters {
  /** Exact GPU model(s), e.g. "RTX 4090" or ["RTX 4090","RTX 5090"]. */
  gpuName?: string | string[];
  /** Minimum VRAM per GPU, in GB. Converted to vast's MB-as-1000s. */
  minGpuRamGb?: number;
  /** Minimum total VRAM across all GPUs, GB. */
  minGpuTotalRamGb?: number;
  numGpus?: number;
  minNumGpus?: number;
  /** Ceiling on $/hour (dph_total). */
  maxPricePerHour?: number;
  /** 0..1 host reliability floor, e.g. 0.98. */
  minReliability?: number;
  /** Minimum disk the host can allocate, GB. */
  minDiskGb?: number;
  /**
   * Disk actually being rented, GB. vast prices dph_total against this, so it
   * must match the disk passed to rent() or the quoted price is wrong.
   */
  diskGb?: number;
  minCpuRamGb?: number;
  minInetDownMbps?: number;
  /** CUDA driver capability floor, e.g. 12.4. */
  minCudaVersion?: number;
  /**
   * Free host router ports. Direct SSH plus one solver port needs >= 2;
   * defaults to 2 so search never returns boxes we cannot reach directly.
   */
  minDirectPorts?: number;
  /** ISO-3166 alpha-2 country code(s) to restrict to. */
  region?: string | string[];
  /** Restrict to vast-verified datacenters. Defaults true. */
  verified?: boolean;
  /** Defaults true — unrentable offers are noise. */
  rentable?: boolean;
  /** Defaults false — exclude third-party/external hosts. */
  external?: boolean;
  /** on-demand (default) | bid | reserved. */
  type?: "on-demand" | "bid" | "reserved";
  /** [[field, "asc"|"desc"], ...]. Defaults to cheapest first. */
  order?: Array<[string, "asc" | "desc"]>;
  limit?: number;
}

const GB_TO_VAST_MB = 1000; // vast counts 24 GB as 24000, not 24576.

const asArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

/**
 * Turn friendly filters into vast's operator-dict query. Exported and pure so
 * the unit tests can assert the exact wire body without any network.
 */
export function buildOfferQuery(filters: OfferSearchFilters = {}): OfferQuery {
  const q: OfferQuery = {};
  const put = (field: string, op: QueryOperator, value: unknown) => {
    q[field] = { [op]: value };
  };

  // Sanity floor first: these three keep obviously useless rows out.
  put("rentable", "eq", filters.rentable ?? true);
  put("rented", "eq", false);
  put("external", "eq", filters.external ?? false);
  if (filters.verified !== false) put("verified", "eq", true);

  if (filters.gpuName !== undefined) {
    const names = asArray(filters.gpuName).map((n) => String(n).trim()).filter(Boolean);
    if (names.length === 1) put("gpu_name", "eq", names[0]);
    else if (names.length > 1) put("gpu_name", "in", names);
  }
  if (filters.minGpuRamGb !== undefined)
    put("gpu_ram", "gte", Math.round(filters.minGpuRamGb * GB_TO_VAST_MB));
  if (filters.minGpuTotalRamGb !== undefined)
    put("gpu_total_ram", "gte", Math.round(filters.minGpuTotalRamGb * GB_TO_VAST_MB));
  if (filters.minCpuRamGb !== undefined)
    put("cpu_ram", "gte", Math.round(filters.minCpuRamGb * GB_TO_VAST_MB));

  // numGpus is exact; minNumGpus is a floor. Exact wins if both are given.
  if (filters.numGpus !== undefined) put("num_gpus", "eq", filters.numGpus);
  else if (filters.minNumGpus !== undefined) put("num_gpus", "gte", filters.minNumGpus);

  if (filters.maxPricePerHour !== undefined) put("dph_total", "lte", filters.maxPricePerHour);
  // Filter on `reliability`; results echo it back as `reliability2`.
  if (filters.minReliability !== undefined) put("reliability", "gte", filters.minReliability);
  if (filters.minDiskGb !== undefined) put("disk_space", "gte", filters.minDiskGb);
  if (filters.minInetDownMbps !== undefined) put("inet_down", "gte", filters.minInetDownMbps);
  if (filters.minCudaVersion !== undefined) put("cuda_max_good", "gte", filters.minCudaVersion);
  put("direct_port_count", "gte", filters.minDirectPorts ?? 2);

  if (filters.region !== undefined) {
    const regions = asArray(filters.region).map((r) => String(r).trim().toUpperCase()).filter(Boolean);
    if (regions.length === 1) q.geolocation = { eq: regions[0] };
    else if (regions.length > 1) q.geolocation = { in: regions };
  }

  // Non-operator keys — vast reads these off the top level of the query.
  q.type = filters.type ?? "on-demand";
  q.order = filters.order ?? [["dph_total", "asc"]];
  q.limit = Math.max(1, Math.min(filters.limit ?? 20, 200));
  // dph_total is quoted against this disk size; keep it aligned with the rent.
  q.allocated_storage = filters.diskGb ?? config.vast.diskGb;

  return q;
}

// ---------------------------------------------------------------------------
// rent options
// ---------------------------------------------------------------------------

export interface RentOptions {
  image?: string;
  diskGb?: number;
  label?: string;
  /** Container-internal port to publish for the blab server. */
  solverPort?: number;
  /** Shell run once at container start. */
  onstart?: string;
  /** Extra env vars for the container. */
  env?: Record<string, string>;
  /** Bid price $/hour — interruptible instances only. Omit for on-demand. */
  bidPricePerHour?: number;
}

/**
 * Build the create-instance body. Pure and exported for tests.
 *
 * Port publishing: vast takes docker `-p` flags as KEYS of the env object with
 * the string value "1" (the OpenAPI yaml claiming env is a string is stale —
 * the CLI and the narrative docs both send an object). The external port is
 * assigned at random and must be read back from the instance's `ports` map.
 *
 * runtype "ssh_direc ssh_proxy" is the CLI's own spelling (yes, "direc") and
 * provisions BOTH a direct port-22 mapping and the ssh####.vast.ai proxy, so
 * we get a fallback if the host's direct ports are exhausted.
 */
export function buildRentBody(options: RentOptions = {}): Record<string, unknown> {
  const solverPort = options.solverPort ?? config.vast.solverPort;
  const env: Record<string, string> = {
    ...(options.env ?? {}),
    // Publish SSH and the solver port. Values are always the string "1".
    "-p 22:22": "1",
    [`-p ${solverPort}:${solverPort}`]: "1",
  };
  const body: Record<string, unknown> = {
    client_id: "me",
    image: options.image ?? config.vast.image,
    disk: options.diskGb ?? config.vast.diskGb,
    label: options.label ?? "boundary-lab-solver",
    env,
    runtype: "ssh_direc ssh_proxy",
    // Disable vast's auto-tmux: provisioning drives a non-interactive shell
    // and tmux swallows the exit status.
    onstart: options.onstart ?? "touch ~/.no_auto_tmux",
    // Fail the request outright rather than leaving a half-created stopped
    // instance quietly accruing storage charges.
    cancel_unavail: true,
  };
  if (options.bidPricePerHour !== undefined) body.price = options.bidPricePerHour;
  return body;
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class VastClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: VastClientOptions = {}) {
    const key = options.apiKey ?? resolveKey().key;
    if (!key) throw new VastNotConfiguredError();
    this.apiKey = key;
    this.baseUrl = (options.baseUrl ?? config.vast.baseUrl).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Build a client only if a key is available; null otherwise. */
  static tryCreate(options: VastClientOptions = {}): VastClient | null {
    try {
      return new VastClient(options);
    } catch (err) {
      if (err instanceof VastNotConfiguredError) return null;
      throw err;
    }
  }

  /**
   * Scrub credentials from anything bound for an error message. Includes THIS
   * client's key explicitly — it may have been injected rather than read from
   * the environment, in which case redact() alone would not know about it.
   */
  private redactSecrets(text: string): string {
    return redact(text, process.env, [this.apiKey]);
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          // DELETE on vast wants a body ({}), and sending one is harmless.
          ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
          signal: controller.signal,
        });
        const text = await response.text();
        let parsed: unknown = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        if (!response.ok) {
          // 429 has no Retry-After on vast; back off ourselves. 5xx is
          // usually a transient host-router hiccup.
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < this.maxRetries) {
            await this.sleep(1000 * 2 ** attempt);
            continue;
          }
          throw new VastError(
            this.redactSecrets(`vast.ai ${method} ${path} failed (${response.status}): ${describeError(parsed, text)}`),
            response.status,
            parsed,
          );
        }
        // vast answers 200 with {"success": false} for some refusals.
        if (parsed !== null && typeof parsed === "object" && (parsed as { success?: unknown }).success === false) {
          throw new VastError(
            this.redactSecrets(`vast.ai ${method} ${path} refused: ${describeError(parsed, text)}`),
            400,
            parsed,
          );
        }
        return parsed as T;
      } catch (err) {
        if (err instanceof VastError) throw err;
        lastError = err;
        const aborted = err instanceof Error && err.name === "AbortError";
        if (attempt < this.maxRetries) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        const detail = aborted ? `timed out after ${this.timeoutMs} ms` : String(err);
        throw new VastError(this.redactSecrets(`vast.ai ${method} ${path} failed: ${detail}`), 502);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new VastError(this.redactSecrets(`vast.ai ${method} ${path} failed: ${String(lastError)}`), 502);
  }

  // ---------- read-only ----------

  /** Cheap key smoke test. */
  async currentUser(): Promise<{ id?: number; email?: string; credit?: number }> {
    return this.request("GET", "/api/v0/users/current/");
  }

  /** Search rentable offers. Rate-limited upstream to 10 req/min per IP. */
  async searchOffers(filters: OfferSearchFilters = {}): Promise<{ offers: RawVastOffer[]; query: OfferQuery }> {
    const query = buildOfferQuery(filters);
    const payload = await this.request<{ offers?: RawVastOffer[] }>("POST", "/api/v0/bundles/", query);
    const offers = Array.isArray(payload?.offers) ? payload.offers : [];
    // The server does not reliably honour the `rented` filter — the official
    // CLI re-filters client side, so we do too.
    return { offers: offers.filter((o) => o.rented !== true), query };
  }

  /**
   * All instances on the account. The v0 list endpoint is deprecated; v1 pages
   * with next_token and caps limit at 25.
   */
  async listInstances(): Promise<RawVastInstance[]> {
    const out: RawVastInstance[] = [];
    let afterToken: string | null = null;
    for (let page = 0; page < 40; page++) {
      const params = new URLSearchParams({
        limit: "25",
        order_by: JSON.stringify([{ col: "id", dir: "asc" }]),
        select_filters: "{}",
      });
      if (afterToken) params.set("after_token", afterToken);
      const payload: { instances?: RawVastInstance[]; next_token?: string | null } = await this.request(
        "GET",
        `/api/v1/instances/?${params.toString()}`,
      );
      const rows = Array.isArray(payload?.instances) ? payload.instances : [];
      out.push(...rows);
      afterToken = payload?.next_token ?? null;
      if (!afterToken || rows.length === 0) break;
    }
    return out;
  }

  /** One instance. Returns null when it no longer exists. */
  async getInstance(id: number): Promise<RawVastInstance | null> {
    const payload = await this.request<{ instances?: RawVastInstance | null }>(
      "GET",
      `/api/v0/instances/${id}/?owner=me`,
    );
    const row = payload?.instances;
    // Guard the endpoint-shape trap: detail returns an object, list an array.
    if (!row || Array.isArray(row) || typeof row !== "object") return null;
    return row;
  }

  // ---------- mutating (money) ----------

  /**
   * Rent an offer. COSTS MONEY. Callers must have enforced explicit user
   * confirmation before reaching this method — see routes.ts.
   */
  async rent(offerId: number, options: RentOptions = {}): Promise<{ instanceId: number; raw: unknown }> {
    const body = buildRentBody(options);
    const payload = await this.request<{ new_contract?: number; success?: boolean }>(
      "PUT",
      `/api/v0/asks/${offerId}/`,
      body,
    );
    const instanceId = payload?.new_contract;
    if (typeof instanceId !== "number")
      throw new VastError(
        `vast.ai accepted the rent for offer ${offerId} but returned no instance id ` +
          `(expected new_contract) — check the vast console before retrying, an ` +
          `instance may be running and billing`,
        502,
        payload,
      );
    return { instanceId, raw: payload };
  }

  /** Destroy an instance. Irreversible; also the only way to stop disk billing. */
  async destroy(id: number): Promise<void> {
    await this.request("DELETE", `/api/v0/instances/${id}/`);
  }

  /** Resume a stopped instance — RESTARTS GPU BILLING. */
  async start(id: number): Promise<void> {
    await this.request("PUT", `/api/v0/instances/${id}/`, { state: "running" });
  }

  /** Halt an instance. Storage keeps billing until it is destroyed. */
  async stop(id: number): Promise<void> {
    await this.request("PUT", `/api/v0/instances/${id}/`, { state: "stopped" });
  }

  async setLabel(id: number, label: string): Promise<void> {
    await this.request("PUT", `/api/v0/instances/${id}/`, { label });
  }

  /** Attach a public key to a live instance (account keys only apply at create). */
  async attachSshKey(id: number, publicKey: string): Promise<void> {
    await this.request("POST", `/api/v0/instances/${id}/ssh/`, { ssh_key: publicKey });
  }
}

/** Best-effort human message out of a vast error payload. */
function describeError(parsed: unknown, fallback: string): string {
  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const parts = [record.error, record.msg, record.message]
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (parts.length) return [...new Set(parts)].join(" — ");
  }
  if (typeof parsed === "string" && parsed) return parsed.slice(0, 500);
  return fallback.slice(0, 500) || "no response body";
}
