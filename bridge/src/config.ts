import { fileURLToPath } from "node:url";
import path from "node:path";

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
  publicUrl: (process.env.BRIDGE_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ""),
  repoRoot,
  bridgeRoot,
  /** Python interpreter used to run blabctl. */
  python: process.env.PYTHON ?? "python",
  /** The python CLI shim over blab (mesh generation + BEM solves). */
  blabctl: process.env.BLABCTL ?? path.join(repoRoot, "bridge", "py", "blabctl.py"),
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
};

export const t3Configured = () => config.t3BaseUrl !== null && config.t3Token !== null;
