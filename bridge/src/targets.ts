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
import { spawnSync } from "node:child_process";
import { config } from "./config.ts";
import * as store from "./store.ts";
import type { JobTarget } from "./store.ts";

export interface ComputeTarget {
  /** Stable id: "local" for the local machine, the instance id for remotes. */
  id: string;
  type: "local" | "remote";
  label: string;
  /** Remote only: base URL blabctl talks to (--server-url). */
  serverUrl?: string;
  /**
   * How many solves may run on this target at once — the slot count the
   * schedule board draws. Defaults to 1 everywhere (one GPU, one job) and is
   * user-configurable per target: see setTargetConfig.
   */
  concurrency: number;
  /**
   * Optional device id per slot, in slot order (e.g. ["0","1"] on a two-GPU
   * box). When present, slot i's job runs with CUDA_VISIBLE_DEVICES=devices[i],
   * so "one solve per GPU" is a real pin rather than a hope.
   */
  devices?: string[];
  /** True when concurrency came from the user, not the provider's default. */
  slotsOverridden?: boolean;
  /** The provider cannot honor a different slot count (for example, a managed
   * server provisioned with a fixed worker limit). */
  slotsLocked?: boolean;
  /** User-facing explanation for a locked slot count. */
  slotLockReason?: string;
  /**
   * Can this target take work RIGHT NOW? A rented box that is still
   * provisioning, or has not passed a health check, is listed (so the UI can
   * show it and say why) but cannot be selected.
   */
  available: boolean;
  /** Why `available` is false — shown to the user, and used as the refusal. */
  unavailableReason?: string;
  /** Free-form liveness hint from the provider ("ready", "provisioning", …). */
  status?: string;
  /** Provider-specific extras (gpu name, $/hour, region) for display only. */
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

/**
 * Per-target scheduling configuration the user set on the schedule board.
 *
 * Historically the local lane was pinned to concurrency 1 in code, on the
 * "one GPU, one job" rule. That rule is right as a DEFAULT and wrong as a law:
 * a two-GPU box wants one solve per card, and a small mesh on a large card can
 * genuinely share. So the number is now the user's, defaulting to 1 — the safe
 * behaviour is what you get by doing nothing, and raising it is a deliberate,
 * visible act with a warning attached (see the UI's slot stepper).
 *
 * Lives in state.json's "targetSlots" feature section so it survives restarts
 * and instance re-provisioning.
 */
export interface TargetConfig {
  /** Concurrent solves allowed. Omitted = the provider's default. */
  slots?: number;
  /** Device id per slot, e.g. ["0","1"]. Length wins over `slots` when longer. */
  devices?: string[];
}

const SLOTS_SECTION = "targetSlots";
/** A lane wide enough to thrash any GPU is a typo, not a plan. */
const MAX_SLOTS = 16;

const readSlotConfig = (): Record<string, TargetConfig> =>
  store.readSection<Record<string, TargetConfig>>(SLOTS_SECTION, {});

export const getTargetConfig = (id: string): TargetConfig => readSlotConfig()[id] ?? {};

/**
 * Set (or clear) a target's slot count and device pinning. Passing `slots:
 * null` / `devices: null` drops the override and returns the target to its
 * provider default. Returns the stored config.
 */
export function setTargetConfig(
  id: string,
  patch: { slots?: number | null; devices?: string[] | null },
): TargetConfig {
  const all = { ...readSlotConfig() };
  const next: TargetConfig = { ...(all[id] ?? {}) };
  if (patch.slots !== undefined) {
    if (patch.slots === null) delete next.slots;
    else {
      if (!Number.isFinite(patch.slots) || patch.slots < 1)
        throw new TargetError("slots must be a positive integer");
      if (patch.slots > MAX_SLOTS)
        throw new TargetError(`slots is capped at ${MAX_SLOTS} — that is a typo, not a plan`);
      next.slots = Math.floor(patch.slots);
    }
  }
  if (patch.devices !== undefined) {
    if (patch.devices === null || patch.devices.length === 0) delete next.devices;
    else {
      if (patch.devices.length > MAX_SLOTS)
        throw new TargetError(`at most ${MAX_SLOTS} devices`);
      next.devices = patch.devices.map((d) => String(d).trim()).filter(Boolean);
    }
  }
  if (Object.keys(next).length === 0) delete all[id];
  else all[id] = next;
  store.writeSection(SLOTS_SECTION, all);
  return next;
}

/** Refuse a slot override that a fixed-capacity provider cannot honor. */
export function assertTargetSlotsConfigurable(
  target: ComputeTarget,
  patch: { slots?: number | null; devices?: string[] | null },
) {
  if (!target.slotsLocked) return;
  // `null` clears an obsolete persisted override and is safe even for a
  // provider-managed target.
  const changesSlots =
    patch.slots !== undefined && patch.slots !== null && patch.slots !== target.concurrency;
  const changesDevices = patch.devices !== undefined && patch.devices !== null;
  if (changesSlots || changesDevices) {
    throw new TargetError(
      target.slotLockReason || `${target.label} has a provider-managed slot count`,
      409,
    );
  }
}

/**
 * Apply the user's slot config over whatever the provider declared. An explicit
 * `slots` always wins — including downwards, so a provider that advertises four
 * can be held to one. Listing devices without a count means "one slot per
 * device", the multi-GPU case.
 */
function withSlotConfig(target: ComputeTarget): ComputeTarget {
  // A managed server's advertised capacity is authoritative. In particular,
  // ignore an override left behind by an older UI that offered false controls.
  if (target.slotsLocked) return { ...target };
  const cfg = getTargetConfig(target.id);
  const requested = cfg.slots ?? cfg.devices?.length ?? target.concurrency ?? 1;
  const concurrency = Math.min(MAX_SLOTS, Math.max(1, Math.floor(requested) || 1));
  // More slots than pinned devices is legal (the extra slots just do not pin);
  // more devices than slots means the tail is unused, so trim it for display.
  const devices = cfg.devices?.slice(0, concurrency);
  return {
    ...target,
    concurrency,
    ...(devices?.length ? { devices } : {}),
    ...(cfg.slots !== undefined || cfg.devices?.length ? { slotsOverridden: true } : {}),
  };
}

const localTarget = (): ComputeTarget =>
  withSlotConfig({
    id: LOCAL_TARGET_ID,
    type: "local",
    label: "Local GPU",
    // One GPU, one job — the default, and the only value you get without
    // deliberately raising it on the schedule board.
    concurrency: 1,
    available: true,
    status: "ready",
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
      out.push(
        withSlotConfig({
          ...target,
          type: "remote",
          concurrency: Math.max(1, target.concurrency || DEFAULT_REMOTE_CONCURRENCY),
          available: target.available !== false,
        }),
      );
    }
  }
  return out;
}

export const getTarget = (id: string): ComputeTarget | undefined =>
  listTargets().find((t) => t.id === id);

/** The registry id a stored JobTarget corresponds to. */
export const targetIdOf = (target: JobTarget | undefined): string =>
  !target || target.type === "local" ? LOCAL_TARGET_ID : (target.instanceId ?? target.serverUrl);

/**
 * Concurrency for the lane a job's target maps to. Unknown remote instances
 * (pinned by raw serverUrl, or registered after the job was created) get the
 * default — never more, so an unrecognised target can't stampede.
 */
export function targetConcurrency(target: JobTarget | undefined): number {
  const known = getTarget(targetIdOf(target));
  if (known) return Math.max(1, known.concurrency);
  if (!target || target.type === "local") return 1;
  return DEFAULT_REMOTE_CONCURRENCY;
}

/**
 * Device ids pinned to this target's slots, in slot order. Empty when the user
 * has not pinned any — the solve then sees whatever the machine's default
 * device selection is, which is the right behaviour on a single-GPU box.
 */
export function targetDevices(target: JobTarget | undefined): string[] {
  return getTarget(targetIdOf(target))?.devices ?? [];
}

export class TargetError extends Error {
  /**
   * HTTP status the API layer should use. 404 = no such target, 409 = it
   * exists but cannot take work yet, 400 = the request itself is malformed.
   */
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * A remote target must be provably usable before a job is queued — a solve
 * that fails an hour later because the box was never provisioned is far worse
 * than an immediate, explanatory refusal.
 */
function requireAvailable(target: ComputeTarget) {
  if (target.available) return;
  throw new TargetError(
    target.unavailableReason ??
      `target "${target.id}" is "${target.status ?? "unavailable"}" and cannot take work yet`,
    409,
  );
}

/**
 * Does this checkout's blabctl accept `--server-url`?
 *
 * Remote execution is a two-part contract: the bridge picks the target, the
 * python CLI forwards the solve. If blabctl predates the flag, argparse would
 * exit 2 and the job would fail with a cryptic log — so probe once (cached)
 * and refuse the launch with a legible message instead.
 *
 * Deliberately fail-open: `null` (cannot tell — no python, a stubbed CLI, a
 * timeout) allows the launch, because guessing "unsupported" would block
 * perfectly good setups. Only a real argparse help banner that omits the flag
 * is treated as a definite "no".
 */
let serverUrlSupport: boolean | null | undefined;

export function blabctlSupportsServerUrl(): boolean | null {
  if (serverUrlSupport !== undefined) return serverUrlSupport;
  serverUrlSupport = null;
  try {
    const out = spawnSync(config.python, [config.blabctl, "solve", "--help"], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      cwd: config.repoRoot,
    });
    const text = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    // Only trust output that actually looks like argparse help.
    if (/usage:/i.test(text)) serverUrlSupport = text.includes("--server-url");
  } catch {
    /* leave null — cannot tell */
  }
  return serverUrlSupport;
}

/** Test helper: forget the probe result. */
export function resetServerUrlSupport() {
  serverUrlSupport = undefined;
}

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
        404,
      );
    if (known.type === "local") return { type: "local" };
    requireAvailable(known);
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

  if (instanceId) {
    const known = getTarget(instanceId);
    if (!known && !serverUrl)
      throw new TargetError(
        `unknown remote target instanceId "${instanceId}" and no serverUrl given — ` +
          `call GET /api/targets for available ids`,
        404,
      );
    if (known) {
      // A known instance is checked even when the caller pinned a URL: the
      // registry is the authority on whether that box is ready.
      requireAvailable(known);
      if (!serverUrl && !known.serverUrl)
        throw new TargetError(`remote target "${instanceId}" has no serverUrl yet (still starting?)`);
      serverUrl ||= known.serverUrl!;
      label ??= known.label;
    }
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
