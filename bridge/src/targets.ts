/**
 * Execution targets: WHERE a job runs.
 *
 * The bridge always knows about the local machine (one GPU, strictly one job
 * at a time). Remote compute — a solver server on a LAN box, a vast.ai
 * instance — is contributed by a provider registered at startup, so this
 * module stays independent of any particular cloud integration.
 *
 * The vast.ai instance registry (bridge/src/vast/*) is expected to call
 * `registerTargetProvider()` with a function returning its live instances.
 * Until it does, `listTargets()` returns just the local target and any target
 * the caller pins by explicit serverUrl still works — a job's target is
 * self-contained (it carries its own serverUrl), the registry only supplies
 * discovery and default concurrency.
 */
import type { JobTarget } from "./store.ts";

export interface ComputeTarget {
  /** Stable id: "local" for the local machine, the instance id for remotes. */
  id: string;
  type: "local" | "remote";
  label: string;
  /** Remote only: base URL blabctl talks to (--server-url). */
  serverUrl?: string;
  /** Max concurrent solve jobs on this target. Local is always 1 (GPU rule). */
  concurrency: number;
  /** Free-form liveness hint from the provider ("running", "stopped", …). */
  status?: string;
  /** Provider-specific extras (gpu name, cost, region) for display only. */
  info?: Record<string, unknown>;
}

export const LOCAL_TARGET_ID = "local";

/**
 * Default concurrency for a remote target whose provider does not specify one.
 * 1 mirrors the local GPU rule per instance; set BRIDGE_REMOTE_CONCURRENCY to
 * allow several jobs per remote box.
 */
export const DEFAULT_REMOTE_CONCURRENCY = Math.max(
  1,
  Number(process.env.BRIDGE_REMOTE_CONCURRENCY ?? 1) || 1,
);

const localTarget = (): ComputeTarget => ({
  id: LOCAL_TARGET_ID,
  type: "local",
  label: "Local machine",
  // HARD RULE: one solve at a time on this machine's GPU. Not configurable.
  concurrency: 1,
  status: "online",
});

type Provider = () => ComputeTarget[];
const providers: Provider[] = [];

/** Contribute remote targets (called by the vast.ai registry at startup). */
export function registerTargetProvider(provider: Provider) {
  providers.push(provider);
}

/** Test helper: drop all registered providers. */
export function clearTargetProviders() {
  providers.length = 0;
}

export function listTargets(): ComputeTarget[] {
  const out: ComputeTarget[] = [localTarget()];
  const seen = new Set([LOCAL_TARGET_ID]);
  for (const provider of providers) {
    let contributed: ComputeTarget[];
    try {
      contributed = provider() ?? [];
    } catch (err) {
      console.error(`[bridge] target provider failed: ${err}`);
      continue;
    }
    for (const target of contributed) {
      if (!target?.id || seen.has(target.id)) continue;
      seen.add(target.id);
      out.push({
        ...target,
        type: "remote",
        concurrency: Math.max(1, target.concurrency || DEFAULT_REMOTE_CONCURRENCY),
      });
    }
  }
  return out;
}

export const getTarget = (id: string): ComputeTarget | undefined =>
  listTargets().find((t) => t.id === id);

/**
 * Concurrency for the lane a job's target maps to. Unknown remote instances
 * (pinned by raw serverUrl, or registered after the job was created) get the
 * default — never more, so an unrecognised target can't stampede.
 */
export function targetConcurrency(target: JobTarget | undefined): number {
  if (!target || target.type === "local") return 1;
  if (target.instanceId) {
    const known = getTarget(target.instanceId);
    if (known) return Math.max(1, known.concurrency);
  }
  return DEFAULT_REMOTE_CONCURRENCY;
}

export class TargetError extends Error {}

/**
 * Normalise whatever the API/MCP caller sent into a JobTarget.
 *
 * Accepted forms:
 *   undefined | null                  -> { type: "local" }
 *   "local" | "<instanceId>"          -> resolved through the registry
 *   { type: "local" }
 *   { type: "remote", instanceId }    -> serverUrl filled from the registry
 *   { type: "remote", serverUrl }     -> pinned URL, no registry needed
 */
export function normalizeTarget(input: unknown): JobTarget {
  if (input === undefined || input === null) return { type: "local" };

  if (typeof input === "string") {
    const id = input.trim();
    if (!id || id === LOCAL_TARGET_ID) return { type: "local" };
    if (/^https?:\/\//i.test(id)) return { type: "remote", serverUrl: id.replace(/\/$/, "") };
    const known = getTarget(id);
    if (!known)
      throw new TargetError(
        `unknown target "${id}" — call GET /api/targets (or the list_targets tool) for available ids`,
      );
    if (known.type === "local") return { type: "local" };
    if (!known.serverUrl) throw new TargetError(`target "${id}" has no serverUrl yet`);
    return {
      type: "remote",
      instanceId: known.id,
      serverUrl: known.serverUrl.replace(/\/$/, ""),
      ...(known.label ? { label: known.label } : {}),
    };
  }

  if (typeof input !== "object" || Array.isArray(input))
    throw new TargetError("target must be a string id or an object {type:'local'|'remote', …}");

  const obj = input as Record<string, unknown>;
  const type = obj.type ?? (obj.serverUrl || obj.instanceId ? "remote" : "local");
  if (type === "local") return { type: "local" };
  if (type !== "remote") throw new TargetError(`target.type must be "local" or "remote"`);

  const instanceId = typeof obj.instanceId === "string" ? obj.instanceId.trim() : undefined;
  let serverUrl = typeof obj.serverUrl === "string" ? obj.serverUrl.trim() : "";
  let label = typeof obj.label === "string" ? obj.label : undefined;

  if (!serverUrl && instanceId) {
    const known = getTarget(instanceId);
    if (!known)
      throw new TargetError(
        `unknown remote target instanceId "${instanceId}" and no serverUrl given — ` +
          `call GET /api/targets for available ids`,
      );
    if (!known.serverUrl)
      throw new TargetError(`remote target "${instanceId}" has no serverUrl yet (still starting?)`);
    serverUrl = known.serverUrl;
    label ??= known.label;
  }
  if (!serverUrl)
    throw new TargetError("a remote target needs serverUrl (or an instanceId known to the registry)");
  if (!/^https?:\/\//i.test(serverUrl))
    throw new TargetError(`remote target serverUrl must be http(s), got "${serverUrl}"`);

  return {
    type: "remote",
    ...(instanceId ? { instanceId } : {}),
    serverUrl: serverUrl.replace(/\/$/, ""),
    ...(label ? { label } : {}),
  };
}

/** Stable display string for a target, used in labels and log lines. */
export const targetLabel = (target: JobTarget | undefined): string =>
  !target || target.type === "local"
    ? "local"
    : (target.label ?? target.instanceId ?? target.serverUrl);
