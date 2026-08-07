/**
 * The managed-instance registry: which rented boxes this bridge knows about,
 * how they were provisioned, and whether they are healthy enough to solve on.
 *
 * Persisted as the "vast" section of DATA_DIR/state.json (see
 * store.readSection/writeSection) so it survives a bridge restart and rides
 * the same atomic write and the same SSE change channel as the run ledger.
 *
 * The registry is a CACHE of intent, never the source of truth about billing:
 * vast.ai is authoritative for whether a contract exists and what it costs.
 * An entry lingering here after someone destroys an instance in the vast
 * console is expected — `reconcile` marks it destroyed on the next refresh.
 */
import * as store from "../store.ts";
import type { ManagedHealth, ManagedInstance, ManagedProgress, ManagedStatus, VastInstance, VastSection } from "./types.ts";

const SECTION = "vast";

const emptySection = (): VastSection => ({ instances: [] });

function read(): VastSection {
  const section = store.readSection<VastSection>(SECTION, emptySection());
  return { instances: Array.isArray(section.instances) ? section.instances : [] };
}

function write(section: VastSection) {
  store.writeSection(SECTION, section);
}

/** Newest first. */
export function list(): ManagedInstance[] {
  return [...read().instances].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function get(id: number): ManagedInstance | undefined {
  return read().instances.find((entry) => entry.id === id);
}

export function add(entry: ManagedInstance): ManagedInstance {
  const section = read();
  const existing = section.instances.findIndex((candidate) => candidate.id === entry.id);
  if (existing >= 0) section.instances[existing] = entry;
  else section.instances.push(entry);
  write(section);
  return entry;
}

/**
 * Shallow-merge a patch into an entry. Returns undefined for an unknown id
 * rather than throwing — callers are usually async provisioning steps racing
 * a `forget`, and losing the race is not an error.
 */
export function patch(id: number, changes: Partial<ManagedInstance>): ManagedInstance | undefined {
  const section = read();
  const index = section.instances.findIndex((entry) => entry.id === id);
  if (index < 0) return undefined;
  const updated = { ...section.instances[index], ...changes };
  section.instances[index] = updated;
  write(section);
  return updated;
}

export function setStatus(id: number, status: ManagedStatus, error?: string | null): ManagedInstance | undefined {
  return patch(id, { status, error: error ?? null });
}

export function setProgress(id: number, stage: string, message: string): ManagedInstance | undefined {
  const progress: ManagedProgress = { stage, message, at: new Date().toISOString() };
  return patch(id, { progress });
}

export function setHealth(id: number, health: ManagedHealth): ManagedInstance | undefined {
  const entry = get(id);
  if (!entry) return undefined;
  // A successful probe is the definition of "ready". A failed one only
  // downgrades an instance we previously believed was ready — it must not
  // stomp on "provisioning" (the server is legitimately not up yet) or on a
  // deliberate "stopped".
  let status = entry.status;
  if (health.ok) status = "ready";
  else if (entry.status === "ready") status = "error";
  return patch(id, {
    lastHealth: health,
    status,
    ...(health.ok ? { error: null } : {}),
  });
}

/** Drop an entry from the ledger. Does NOT touch the vast.ai contract. */
export function forget(id: number): boolean {
  const section = read();
  const index = section.instances.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  section.instances.splice(index, 1);
  write(section);
  return true;
}

/**
 * Fold freshly fetched live state from vast.ai into the registry.
 *
 * Rules:
 *   - An entry whose contract is gone upstream becomes "destroyed" (someone
 *     used the vast console, or the host reclaimed it). It is kept, not
 *     deleted, so the cost history stays visible until explicitly forgotten.
 *   - `ssh` and `serverUrl` are refreshed on every pass: the port mapping is
 *     assigned at boot and can change across a stop/start cycle, so a cached
 *     endpoint from a previous run is actively dangerous.
 *   - A stopped contract downgrades "ready" to "stopped" — the blab server
 *     inside it is definitionally not answering.
 */
export function reconcile(live: Map<number, VastInstance>): ManagedInstance[] {
  const section = read();
  const now = new Date().toISOString();
  for (const entry of section.instances) {
    const observed = live.get(entry.id);
    if (!observed) {
      if (entry.status !== "destroyed") {
        entry.status = "destroyed";
        entry.serverUrl = null;
        entry.ssh = null;
        entry.live = null;
      }
      continue;
    }
    entry.live = {
      actualStatus: observed.actualStatus,
      intendedStatus: observed.intendedStatus,
      statusMsg: observed.statusMsg,
      pricePerHour: observed.pricePerHour,
      startedAt: observed.startedAt,
      uptimeSeconds: observed.uptimeSeconds,
      estimatedCostUsd: observed.estimatedCostUsd,
      refreshedAt: now,
    };
    entry.ssh = observed.ssh;
    const mapped = observed.ports[`${entry.solverPort}/tcp`];
    entry.serverUrl =
      mapped !== undefined && observed.publicIp ? `http://${observed.publicIp}:${mapped}` : null;
    if (observed.gpuName && observed.gpuName !== "unknown GPU") entry.gpuName = observed.gpuName;

    if (observed.actualStatus === "stopped") {
      if (entry.status === "ready" || entry.status === "starting" || entry.status === "provisioning")
        entry.status = "stopped";
    } else if (entry.status === "stopped" && observed.running) {
      // Resumed elsewhere: it is provisioned but unverified until /health.
      entry.status = entry.provisionedAt ? "unknown" : "starting";
    } else if (entry.status === "destroyed") {
      entry.status = "unknown"; // reappeared
    }
  }
  write(section);
  return list();
}

/**
 * Instances that a solve could be dispatched to right now: provisioned,
 * running, with a reachable server URL and a passing last health check.
 */
export function healthyInstances(): ManagedInstance[] {
  return list().filter(
    (entry) => entry.status === "ready" && entry.serverUrl !== null && entry.lastHealth?.ok === true,
  );
}

/** Total $/hour currently burning across every non-destroyed managed instance. */
export function activeBurnRatePerHour(): number {
  return list()
    .filter((entry) => entry.status !== "destroyed" && entry.live?.actualStatus !== "stopped")
    .reduce((sum, entry) => sum + (entry.live?.pricePerHour ?? entry.pricePerHour ?? 0), 0);
}
