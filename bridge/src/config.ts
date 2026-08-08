import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Parse a numeric env var that must be finite and positive, falling back to a
 * safe default with a loud warning. Used for the knobs where a silently-NaN
 * value would disable a safety check rather than merely misconfigure it.
 */
export function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[bridge] ${name}="${raw}" is not a positive number — falling back to ${fallback}. ` +
        `Fix the value; leaving it invalid would disable the limit it configures.`,
    );
    return fallback;
  }
  return parsed;
}

const bridgeRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const port = Number(process.env.PORT ?? 4821);
const repoRoot = process.env.REPO_ROOT ?? path.resolve(bridgeRoot, "..");

/**
 * All deployment-specific knobs live here. The bridge runs fully standalone
 * with no env set; T3_BASE_URL + T3_TOKEN light up the orchestration handoffs.
 *
 * BRIDGE_PUBLIC_URL matters for remote use: URLs handed to t3's preview pane
 * resolve from the *viewing* machine, so on a tailnet set this to the tailnet
 * hostname, never localhost.
 */
export const config = {
  port,
  /**
   * Listen address. Default loopback: the API/MCP surface is unauthenticated,
   * so it must not be reachable from a LAN/tailnet unless explicitly opted in
   * (BRIDGE_HOST=0.0.0.0 — only do this behind a trusted network boundary
   * such as a tailnet ACL, and set BRIDGE_PUBLIC_URL to match).
   */
  host: process.env.BRIDGE_HOST ?? "127.0.0.1",
  publicUrl: (process.env.BRIDGE_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ""),
  repoRoot,
  bridgeRoot,
  /** Python interpreter used to run blabctl. */
  python: process.env.PYTHON ?? "python",
  /** The python CLI shim over blab (mesh generation + BEM solves). */
  blabctl: process.env.BLABCTL ?? path.join(repoRoot, "bridge", "py", "blabctl.py"),
  /**
   * Warm NDJSON worker behind the live mesh editor's preview loop. Kept
   * separate from blabctl on purpose: blabctl is one-shot per job, and the
   * editor needs the gmsh/meshio imports to survive between keystrokes.
   */
  previewWorker:
    process.env.BLAB_PREVIEW_WORKER ?? path.join(repoRoot, "bridge", "py", "mesh_preview_worker.py"),
  /** Idle seconds before the warm preview worker is shut down again. */
  previewIdleSeconds: positiveNumber(process.env.BLAB_PREVIEW_IDLE_SECONDS, 300, "BLAB_PREVIEW_IDLE_SECONDS"),
  dataDir: process.env.DATA_DIR ?? path.join(bridgeRoot, "data"),
  t3BaseUrl: process.env.T3_BASE_URL?.replace(/\/$/, "") ?? null,
  t3Token: process.env.T3_TOKEN ?? null,
  /**
   * Optional explicit Julia override for python children. When null (no env
   * set), nothing is passed down and blabctl.resolve_julia_exe picks Julia
   * itself: BLAB_JULIA_EXE env, then its known install path, then `julia` on
   * PATH — hardcoding a machine-specific default here would defeat that.
   */
  juliaExecutable: process.env.BLAB_JULIA_EXECUTABLE ?? null,

  /**
   * vast.ai compute provider (bridge/src/vast/). Renting costs real money, so
   * everything here defaults to the safe end: no key, a conservative price
   * ceiling, and no automatic anything. See bridge/src/vast/key.ts for how the
   * API key is resolved — it is deliberately NOT read from this object first.
   */
  vast: {
    /**
     * Last-resort API key slot (precedence 3, after VAST_API_KEY and
     * ~/.vast_api_key). Exists for embedders and tests; nothing writes a key
     * here from disk, and it is never serialized.
     */
    apiKey: null as string | null,
    baseUrl: (process.env.VAST_BASE_URL ?? "https://console.vast.ai").replace(/\/$/, ""),
    /**
     * Hard ceiling on $/hour for a rent request. A rent above this is refused
     * outright, before any confirmation is even considered — a second line of
     * defence behind the mandatory `confirm` flag against a fat-fingered
     * offer id landing on an 8×H100 box.
     *
     * Parsed defensively: a typo'd VAST_MAX_PRICE_PER_HOUR must never become
     * NaN, because every `price > NaN` comparison is false and the ceiling
     * would silently disappear — the exact opposite of what setting it means.
     */
    maxPricePerHour: positiveNumber(process.env.VAST_MAX_PRICE_PER_HOUR, 2.0, "VAST_MAX_PRICE_PER_HOUR"),
    /** Default docker image for rented solve boxes (CUDA runtime + Ubuntu). */
    image: process.env.VAST_IMAGE ?? "nvidia/cuda:12.6.3-runtime-ubuntu24.04",
    /** Default disk to request, GB. Julia depot + CUDA artifacts need ~30 GB. */
    diskGb: Number(process.env.VAST_DISK_GB ?? 60),
    /** Container-internal port the remote `blab server` binds. */
    solverPort: Number(process.env.VAST_SOLVER_PORT ?? 8765),
    /** Private key for SSH into rented instances. null = ssh-agent / defaults. */
    sshKeyFile: process.env.VAST_SSH_KEY_FILE ?? null,
    /** Public key registered on the instance at create time, if set. */
    sshPublicKeyFile: process.env.VAST_SSH_PUBLIC_KEY_FILE ?? null,
    /** Git remote the instance clones the solver from. */
    repoUrl: process.env.VAST_REPO_URL ?? "https://github.com/abcdmku/boundary-lab.git",
    repoRef: process.env.VAST_REPO_REF ?? "main",
    /** Persistent path on the instance that caches venv + Julia depot + repo. */
    cacheRoot: process.env.VAST_CACHE_ROOT ?? "/workspace/blab",
  },
};

export const t3Configured = () => config.t3BaseUrl !== null && config.t3Token !== null;
