/**
 * Adapter: the vast.ai instance registry, seen as execution targets.
 *
 * This is the ONLY place the generic target/lane machinery meets a specific
 * cloud provider. `src/targets.ts` knows nothing about vast.ai; it just asks
 * its registered providers what exists. Registering here keeps every other
 * consumer — the queue's lane keys, `GET /api/targets`, the `list_targets`
 * MCP tool, a job's stored `target` — provider-agnostic.
 *
 * Target ids are `vast:<instanceId>`, matching `GET /api/vast/targets` and the
 * ids the vast routes and dashboard already use.
 */
import { registerTargetProvider, type ComputeTarget } from "../targets.ts";
import * as registry from "./registry.ts";
import type { ManagedInstance } from "./types.ts";

export const vastTargetId = (instanceId: number) => `vast:${instanceId}`;

/** Extract the numeric instance id from a `vast:<id>` target id. */
export function vastInstanceId(targetId: string): number | null {
  const match = /^vast:(\d+)$/.exec(targetId.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Why this instance cannot take a solve right now — null when it can.
 * The wording matches what the vast routes tell you to do next, because this
 * string is what a refused launch shows the caller.
 */
export function unavailableReason(entry: ManagedInstance): string | null {
  if (entry.status === "destroyed") return `vast instance ${entry.id} has been destroyed`;
  if (entry.status !== "ready" || !entry.serverUrl)
    return (
      `vast instance ${entry.id} is "${entry.status}", not ready — provision it first ` +
      `(POST /api/vast/instances/${entry.id}/provision)`
    );
  if (entry.lastHealth?.ok !== true)
    return (
      `vast instance ${entry.id} has not passed a health check` +
      `${entry.lastHealth?.error ? ` (last error: ${entry.lastHealth.error})` : ""} — ` +
      `re-check it with POST /api/vast/instances/${entry.id}/health`
    );
  return null;
}

export function toComputeTarget(entry: ManagedInstance): ComputeTarget {
  const reason = unavailableReason(entry);
  return {
    id: vastTargetId(entry.id),
    type: "remote",
    label: `${entry.gpuName}${entry.numGpus > 1 ? ` ×${entry.numGpus}` : ""} — ${entry.label}`,
    ...(entry.serverUrl ? { serverUrl: entry.serverUrl } : {}),
    // One solve per rented box, even on a multi-GPU instance: the managed
    // server is provisioned with --max-running-jobs 1 (see
    // provision/vast_bootstrap.sh), so extra slots would only make the bridge
    // start blabctl children — and their 4 h timeout clocks — for jobs that sit
    // waiting in the server's private queue. Raising this needs the bootstrap
    // to advertise and assign matching parallelism first.
    concurrency: 1,
    available: reason === null,
    ...(reason ? { unavailableReason: reason } : {}),
    status: entry.status,
    info: {
      instanceId: entry.id,
      gpuName: entry.gpuName,
      numGpus: entry.numGpus,
      pricePerHour: entry.live?.pricePerHour ?? entry.pricePerHour,
      ...(entry.error ? { error: entry.error } : {}),
    },
  };
}

/** Called once at startup from server.ts. */
export function registerVastTargets() {
  // Destroyed instances stay in the list, marked unavailable with a reason.
  // Dropping them would make a `vast:<id>` target that this bridge DID manage
  // indistinguishable from one it never knew about — and an id it never knew
  // about is taken on trust at launch, which is exactly wrong for a box that
  // has since been destroyed. A picker can filter on `available`.
  registerTargetProvider(() => registry.list().map(toComputeTarget));
}
