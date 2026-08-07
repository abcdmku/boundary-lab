/**
 * HTTP API for the vast.ai compute provider, mounted at /api/vast.
 *
 * Kept in its own router and registered with a two-line edit to server.ts so
 * the parallel streams touching that file have nothing to merge.
 *
 * Conventions match the rest of the bridge: JSON in, JSON out, errors as
 * `{ "error": "..." }` with a meaningful status.
 *
 *   GET    /api/vast/status                     provider + key state
 *   POST   /api/vast/offers/search              search rentable GPUs
 *   GET    /api/vast/instances                  managed instances (+ live refresh)
 *   GET    /api/vast/instances/:id              one managed instance
 *   POST   /api/vast/instances                  RENT — requires {"confirm": true}
 *   POST   /api/vast/instances/:id/provision    install + start the solve server
 *   POST   /api/vast/instances/:id/health       probe /health now
 *   POST   /api/vast/instances/:id/start        resume — requires {"confirm": true}
 *   POST   /api/vast/instances/:id/stop         halt (no confirmation: saves money)
 *   POST   /api/vast/instances/:id/import       adopt an existing vast instance
 *   DELETE /api/vast/instances/:id              DESTROY — requires {"confirm": true}
 *   DELETE /api/vast/instances/:id/registry     forget locally, leave vast alone
 *   GET    /api/vast/targets                    compute targets for a solve
 *
 * COST SAFETY (see also cost-safety notes on each handler):
 *   - Nothing in this file rents, starts, or destroys anything without an
 *     explicit `confirm: true` in the request body. Without it the handler
 *     returns 402 with a full price quote and changes nothing.
 *   - A rent above config.vast.maxPricePerHour is refused with 403 before
 *     confirmation is even considered.
 *   - There is no automatic renting, no automatic destroying, and no
 *     background process that changes an instance's billing state. Every
 *     money-moving call is a direct response to a request.
 */
import express from "express";
import { ActionError } from "../actions.ts";
import { config } from "../config.ts";
import { VastClient, VastNotConfiguredError, type OfferSearchFilters } from "./client.ts";
import { describeKey } from "./key.ts";
import { normalizeInstance, normalizeOffer } from "./normalize.ts";
import { probeHealth, provisionInstance, extractSolverLabels, type ProvisionOptions } from "./provision.ts";
import * as registry from "./registry.ts";
import type { ManagedInstance, VastInstance } from "./types.ts";

export const vastRouter = express.Router();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class VastRouteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const fail = (res: express.Response, err: unknown) => {
  if (err instanceof VastRouteError)
    return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err instanceof VastNotConfiguredError) return res.status(501).json({ error: err.message });
  if (err instanceof ActionError) return res.status(err.status).json({ error: err.message });
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
};

/** Client for this request, or a 501 telling the operator how to configure one. */
function client(): VastClient {
  return new VastClient();
}

function instanceId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new VastRouteError(`invalid instance id "${raw}"`, 400);
  return id;
}

function requireEntry(id: number): ManagedInstance {
  const entry = registry.get(id);
  if (!entry) throw new VastRouteError(`instance ${id} is not in the bridge registry`, 404);
  return entry;
}

const body = (req: express.Request): Record<string, unknown> =>
  req.body !== null && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

const optionalNumber = (value: unknown, label: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new VastRouteError(`${label} must be a number`);
  return parsed;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * The single gate every money-moving action passes through. `confirm` must be
 * literally `true` — a truthy string does not count, so a form posting
 * "false" or a stray query param can never authorize spend.
 */
function requireConfirmation(req: express.Request, action: string, quote: Record<string, unknown>) {
  if (body(req).confirm === true) return;
  throw new VastRouteError(
    `${action} costs money and was not confirmed — resend this request with {"confirm": true} in the body`,
    402,
    { requiresConfirmation: true, action, quote },
  );
}

/** Refresh live vast state into the registry. Tolerates an unconfigured key. */
async function refreshRegistry(): Promise<ManagedInstance[]> {
  const vast = VastClient.tryCreate();
  if (!vast) return registry.list();
  const rows = await vast.listInstances();
  const live = new Map<number, VastInstance>();
  for (const row of rows) {
    const entry = registry.get(Number(row.id));
    const instance = normalizeInstance(row, { solverPort: entry?.solverPort ?? config.vast.solverPort });
    if (instance.id > 0) live.set(instance.id, instance);
  }
  return registry.reconcile(live);
}

// ---------------------------------------------------------------------------
// GET /api/vast/status
// ---------------------------------------------------------------------------
/**
 * Provider configuration and key state. Safe to call with no key — that is
 * exactly the case the UI needs to render an onboarding hint. Reports a key
 * FINGERPRINT, never the key.
 */
vastRouter.get("/status", (_req, res) => {
  const key = describeKey();
  res.json({
    configured: key.configured,
    keySource: key.source,
    keyFile: key.keyFile,
    keyFingerprint: key.fingerprint,
    baseUrl: config.vast.baseUrl,
    defaults: {
      image: config.vast.image,
      diskGb: config.vast.diskGb,
      solverPort: config.vast.solverPort,
      repoUrl: config.vast.repoUrl,
      repoRef: config.vast.repoRef,
      cacheRoot: config.vast.cacheRoot,
    },
    limits: { maxPricePerHour: config.vast.maxPricePerHour },
    cost: {
      managedInstances: registry.list().filter((e) => e.status !== "destroyed").length,
      activeBurnRatePerHour: Number(registry.activeBurnRatePerHour().toFixed(4)),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/vast/offers/search
// ---------------------------------------------------------------------------
/**
 * Read-only. Body is an OfferSearchFilters object; every field optional.
 * Upstream rate limit is 10 searches/minute per IP.
 */
vastRouter.post("/offers/search", async (req, res) => {
  try {
    const input = body(req);
    const filters: OfferSearchFilters = {
      gpuName: Array.isArray(input.gpuName)
        ? (input.gpuName as string[])
        : optionalString(input.gpuName),
      minGpuRamGb: optionalNumber(input.minGpuRamGb, "minGpuRamGb"),
      minGpuTotalRamGb: optionalNumber(input.minGpuTotalRamGb, "minGpuTotalRamGb"),
      numGpus: optionalNumber(input.numGpus, "numGpus"),
      minNumGpus: optionalNumber(input.minNumGpus, "minNumGpus"),
      maxPricePerHour: optionalNumber(input.maxPricePerHour, "maxPricePerHour"),
      minReliability: optionalNumber(input.minReliability, "minReliability"),
      minDiskGb: optionalNumber(input.minDiskGb, "minDiskGb"),
      diskGb: optionalNumber(input.diskGb, "diskGb"),
      minCpuRamGb: optionalNumber(input.minCpuRamGb, "minCpuRamGb"),
      minInetDownMbps: optionalNumber(input.minInetDownMbps, "minInetDownMbps"),
      minCudaVersion: optionalNumber(input.minCudaVersion, "minCudaVersion"),
      minDirectPorts: optionalNumber(input.minDirectPorts, "minDirectPorts"),
      region: Array.isArray(input.region) ? (input.region as string[]) : optionalString(input.region),
      ...(typeof input.verified === "boolean" ? { verified: input.verified } : {}),
      ...(input.type === "bid" || input.type === "reserved" || input.type === "on-demand"
        ? { type: input.type }
        : {}),
      ...(Array.isArray(input.order) ? { order: input.order as Array<[string, "asc" | "desc"]> } : {}),
      limit: optionalNumber(input.limit, "limit"),
    };
    const { offers, query } = await client().searchOffers(filters);
    res.json({
      offers: offers.map(normalizeOffer),
      count: offers.length,
      // Echoed so the UI can show exactly what was asked upstream, and so a
      // surprising result set is debuggable without server logs.
      query,
    });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/vast/instances
// ---------------------------------------------------------------------------
/**
 * Managed instances, with live vast state folded in. `?refresh=false` skips
 * the upstream call and answers straight from the registry (cheap, for polling).
 */
vastRouter.get("/instances", async (req, res) => {
  try {
    const instances = req.query.refresh === "false" ? registry.list() : await refreshRegistry();
    res.json({
      instances,
      activeBurnRatePerHour: Number(registry.activeBurnRatePerHour().toFixed(4)),
    });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/vast/instances/:id
// ---------------------------------------------------------------------------
vastRouter.get("/instances/:id", async (req, res) => {
  try {
    const id = instanceId(req.params.id);
    const entry = requireEntry(id);
    const vast = VastClient.tryCreate();
    let live: VastInstance | null = null;
    if (vast) {
      const raw = await vast.getInstance(id);
      if (raw) {
        live = normalizeInstance(raw, { solverPort: entry.solverPort });
        registry.reconcile(new Map([[id, live]]));
      }
    }
    res.json({ instance: registry.get(id) ?? entry, live });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/vast/instances   — RENT (costs money)
// ---------------------------------------------------------------------------
/**
 * Rent an offer.
 *
 * Body: { offerId: number, confirm: true, label?, diskGb?, image?, solverPort?,
 *         provision?: boolean }
 *
 * Three guards, in order:
 *   1. the offer must still exist and be rentable (re-fetched, never trusted
 *      from the client — a stale offer id is the classic way to rent the
 *      wrong box);
 *   2. its price must be at or below config.vast.maxPricePerHour  -> 403;
 *   3. the body must carry confirm: true                          -> 402 + quote.
 *
 * Only then is any money spent. The response always states the hourly price
 * that was committed to.
 */
vastRouter.post("/instances", async (req, res) => {
  try {
    const input = body(req);
    const offerId = optionalNumber(input.offerId, "offerId");
    if (offerId === undefined) throw new VastRouteError("offerId (number) is required");

    const diskGb = optionalNumber(input.diskGb, "diskGb") ?? config.vast.diskGb;
    const solverPort = optionalNumber(input.solverPort, "solverPort") ?? config.vast.solverPort;
    const image = optionalString(input.image) ?? config.vast.image;
    const label = optionalString(input.label) ?? "boundary-lab-solver";

    // Re-fetch the offer so the quote reflects reality, not whatever the
    // client believed when it rendered its list.
    const vast = client();
    const { offers } = await vast.searchOffers({ diskGb, limit: 200 });
    const match = offers.map(normalizeOffer).find((offer) => offer.id === offerId);
    if (!match)
      throw new VastRouteError(
        `offer ${offerId} is no longer available — search again and pick a current offer`,
        409,
      );

    if (match.pricePerHour > config.vast.maxPricePerHour)
      throw new VastRouteError(
        `offer ${offerId} costs $${match.pricePerHour.toFixed(4)}/hour, above this bridge's ceiling of ` +
          `$${config.vast.maxPricePerHour.toFixed(2)}/hour. Raise VAST_MAX_PRICE_PER_HOUR deliberately if ` +
          `you really want a machine this expensive.`,
        403,
        { quote: match, maxPricePerHour: config.vast.maxPricePerHour },
      );

    requireConfirmation(req, `renting offer ${offerId} (${match.gpuName})`, {
      offerId,
      gpuName: match.gpuName,
      numGpus: match.numGpus,
      pricePerHour: match.pricePerHour,
      estimatedDailyCost: match.estimatedDailyCost,
      storageCostPerGbMonth: match.storageCostPerGbMonth,
      diskGb,
      geolocation: match.geolocation,
      note:
        "Billing starts as soon as the instance boots and storage keeps billing while it is stopped — " +
        "only DESTROY ends all charges.",
    });

    const { instanceId: newId } = await vast.rent(offerId, { image, diskGb, label, solverPort });
    const entry = registry.add({
      id: newId,
      label,
      status: "renting",
      gpuName: match.gpuName,
      numGpus: match.numGpus,
      pricePerHour: match.pricePerHour,
      offerId,
      image,
      diskGb,
      solverPort,
      serverUrl: null,
      ssh: null,
      createdAt: new Date().toISOString(),
      provisionedAt: null,
      error: null,
      progress: null,
      lastHealth: null,
      live: null,
    });

    // Provisioning is opt-in and always detached — it runs for the better part
    // of an hour on a cold box, so the caller gets the instance record now and
    // watches progress over SSE.
    if (input.provision === true) startProvisioning(newId, {});

    res.status(201).json({
      instance: entry,
      pricePerHour: match.pricePerHour,
      estimatedDailyCost: match.estimatedDailyCost,
      provisioning: input.provision === true,
      warning:
        `Instance ${newId} is now billing at $${match.pricePerHour.toFixed(4)}/hour. ` +
        `Destroy it when you are done — stopping it does not end storage charges.`,
    });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/vast/instances/:id/provision
// ---------------------------------------------------------------------------
/**
 * Install the solver and start `blab server` on an instance already rented.
 * Costs nothing beyond the rental already running. Returns 202 immediately;
 * follow progress on the instance record (SSE pushes full state on change).
 *
 * Body: { force?: boolean, repoRef?: string, solver?: string,
 *         buildSysimage?: boolean }
 *
 * Idempotent: a re-run on a provisioned instance skips every cached stage and
 * just restarts the server, which is how you roll a new repo revision.
 */
vastRouter.post("/instances/:id/provision", (req, res) => {
  try {
    const id = instanceId(req.params.id);
    const entry = requireEntry(id);
    if (entry.status === "provisioning")
      throw new VastRouteError(`instance ${id} is already provisioning`, 409);
    if (entry.status === "destroyed") throw new VastRouteError(`instance ${id} has been destroyed`, 409);
    const input = body(req);
    const options: ProvisionOptions = {
      force: input.force === true,
      buildSysimage: input.buildSysimage === true,
      repoRef: optionalString(input.repoRef),
      repoUrl: optionalString(input.repoUrl),
      solver: optionalString(input.solver),
      juliaThreads: optionalString(input.juliaThreads),
      cacheRoot: optionalString(input.cacheRoot),
      solverPort: entry.solverPort,
    };
    startProvisioning(id, options);
    res.status(202).json({ instance: registry.get(id), provisioning: true });
  } catch (err) {
    fail(res, err);
  }
});

/** Detached provisioning run. Failures land on the registry entry, not here. */
function startProvisioning(id: number, options: ProvisionOptions) {
  const vast = VastClient.tryCreate();
  if (!vast) return;
  const entry = registry.get(id);
  if (!entry) return;
  void provisionInstance(vast, entry, options).catch((err) => {
    console.error(`[bridge] vast provisioning for instance ${id} failed: ${err}`);
  });
}

// ---------------------------------------------------------------------------
// POST /api/vast/instances/:id/health
// ---------------------------------------------------------------------------
/**
 * Probe the remote blab server's /health now and record the result. Free and
 * side-effect-free apart from the recorded health. The payload is whatever
 * `blab server` reports (solver, backend, capabilities, and — once the
 * parallel server stream lands — GPU/VRAM details), passed through verbatim.
 */
vastRouter.post("/instances/:id/health", async (req, res) => {
  try {
    const id = instanceId(req.params.id);
    const entry = requireEntry(id);
    const serverUrl = optionalString(body(req).serverUrl) ?? entry.serverUrl;
    if (!serverUrl)
      throw new VastRouteError(
        `instance ${id} has no known server URL — provision it first, or pass an explicit serverUrl`,
        409,
      );
    const health = await probeHealth(serverUrl, { timeoutMs: 15_000 });
    const updated = registry.setHealth(id, {
      checkedAt: new Date().toISOString(),
      ok: health.ok,
      latencyMs: health.latencyMs,
      ...(health.ok ? { payload: health.payload, ...extractSolverLabels(health.payload) } : {}),
      ...(health.error ? { error: health.error } : {}),
    });
    res.json({ instance: updated, health: { ...health, serverUrl } });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/vast/instances/:id/start   — resumes GPU billing
// ---------------------------------------------------------------------------
vastRouter.post("/instances/:id/start", async (req, res) => {
  try {
    const id = instanceId(req.params.id);
    const entry = requireEntry(id);
    requireConfirmation(req, `starting instance ${id}`, {
      instanceId: id,
      gpuName: entry.gpuName,
      pricePerHour: entry.live?.pricePerHour ?? entry.pricePerHour,
      note: "Starting a stopped instance resumes full GPU billing.",
    });
    await client().start(id);
    // The port mapping is reassigned across a stop/start, so the cached
    // endpoints are now lies. Clear them and let the next refresh repopulate.
    registry.patch(id, { status: "starting", serverUrl: null, ssh: null, error: null });
    res.json({ instance: registry.get(id), note: "port mappings change across a restart — re-provision to restart the solve server" });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/vast/instances/:id/stop   — saves money, so no confirmation
// ---------------------------------------------------------------------------
vastRouter.post("/instances/:id/stop", async (req, res) => {
  try {
    const id = instanceId(req.params.id);
    requireEntry(id);
    await client().stop(id);
    registry.patch(id, { status: "stopped", serverUrl: null, ssh: null });
    res.json({
      instance: registry.get(id),
      warning: "Storage charges continue while stopped. Destroy the instance to end all billing.",
    });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/vast/instances/:id   — DESTROY (irreversible)
// ---------------------------------------------------------------------------
/**
 * Destroy the contract. This is the only action that fully ends billing, and
 * it is irreversible — the instance's disk, including the cached Julia depot,
 * is gone. Requires {"confirm": true}.
 */
vastRouter.delete("/instances/:id", async (req, res) => {
  try {
    const id = instanceId(req.params.id);
    const entry = requireEntry(id);
    requireConfirmation(req, `destroying instance ${id}`, {
      instanceId: id,
      gpuName: entry.gpuName,
      pricePerHour: entry.live?.pricePerHour ?? entry.pricePerHour,
      uptimeSeconds: entry.live?.uptimeSeconds ?? null,
      estimatedCostUsd: entry.live?.estimatedCostUsd ?? null,
      note: "Irreversible. The cached Julia depot and venv on the instance disk are destroyed with it.",
    });
    await client().destroy(id);
    registry.patch(id, { status: "destroyed", serverUrl: null, ssh: null, error: null });
    res.json({
      instance: registry.get(id),
      destroyed: true,
      estimatedCostUsd: entry.live?.estimatedCostUsd ?? null,
    });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/vast/instances/:id/registry   — forget locally
// ---------------------------------------------------------------------------
/** Drop the local record. Never touches the vast.ai contract. */
vastRouter.delete("/instances/:id/registry", (req, res) => {
  try {
    const id = instanceId(req.params.id);
    const entry = requireEntry(id);
    if (entry.status !== "destroyed" && body(req).confirm !== true)
      throw new VastRouteError(
        `instance ${id} is not destroyed — forgetting it here does NOT stop its billing. ` +
          `Resend with {"confirm": true} if you really want to lose track of it.`,
        409,
        { requiresConfirmation: true },
      );
    registry.forget(id);
    res.json({ ok: true, forgotten: id });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/vast/instances/:id/import   — adopt an existing instance
// ---------------------------------------------------------------------------
/**
 * Bring an instance that already exists on the vast account (rented from the
 * console, or left over from a previous bridge install) under management, so
 * it can be provisioned and reused. Costs nothing — it is already billing.
 */
vastRouter.post("/instances/:id/import", async (req, res) => {
  try {
    const id = instanceId(req.params.id);
    if (registry.get(id)) throw new VastRouteError(`instance ${id} is already in the registry`, 409);
    const input = body(req);
    const solverPort = optionalNumber(input.solverPort, "solverPort") ?? config.vast.solverPort;
    const raw = await client().getInstance(id);
    if (!raw) throw new VastRouteError(`instance ${id} does not exist on this vast.ai account`, 404);
    const live = normalizeInstance(raw, { solverPort });
    const entry = registry.add({
      id,
      label: live.label ?? `vast-${id}`,
      // Imported instances are unverified by definition: we did not provision
      // them, so we do not know whether a solve server is running.
      status: live.running ? "unknown" : "stopped",
      gpuName: live.gpuName,
      numGpus: live.numGpus,
      pricePerHour: live.pricePerHour,
      offerId: null,
      image: live.image ?? config.vast.image,
      diskGb: live.diskGb ?? config.vast.diskGb,
      solverPort,
      serverUrl: null,
      ssh: live.ssh,
      createdAt: new Date().toISOString(),
      provisionedAt: null,
      error: null,
      progress: null,
      lastHealth: null,
      live: null,
    });
    registry.reconcile(new Map([[id, live]]));
    res.status(201).json({ instance: registry.get(id) ?? entry, live });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/vast/targets
// ---------------------------------------------------------------------------
/**
 * Everywhere a solve could run: the local GPU plus every healthy managed
 * remote. This is what a solve form's "run on" selector should be built from.
 *
 * `?refresh=true` re-checks each candidate's /health before answering, which
 * costs a round trip per instance but never reports a stale target as usable.
 */
vastRouter.get("/targets", async (req, res) => {
  try {
    if (req.query.refresh === "true") {
      await refreshRegistry();
      await Promise.all(
        registry
          .list()
          .filter((entry) => entry.serverUrl && entry.status !== "destroyed")
          .map(async (entry) => {
            const health = await probeHealth(entry.serverUrl!, { timeoutMs: 8000 });
            registry.setHealth(entry.id, {
              checkedAt: new Date().toISOString(),
              ok: health.ok,
              latencyMs: health.latencyMs,
              ...(health.ok ? { payload: health.payload, ...extractSolverLabels(health.payload) } : {}),
              ...(health.error ? { error: health.error } : {}),
            });
          }),
      );
    }
    const targets = [
      {
        id: "local",
        kind: "local" as const,
        label: "Local GPU",
        available: true,
        serverUrl: null,
        pricePerHour: 0,
        instanceId: null,
        gpuName: null,
        status: "ready",
        lastHealth: null,
      },
      ...registry.list().map((entry) => ({
        id: `vast:${entry.id}`,
        kind: "vast" as const,
        label: `${entry.gpuName}${entry.numGpus > 1 ? ` ×${entry.numGpus}` : ""} — ${entry.label}`,
        // Only a provisioned instance with a passing health check is safe to
        // dispatch to; everything else is listed but not selectable.
        available: entry.status === "ready" && entry.serverUrl !== null && entry.lastHealth?.ok === true,
        serverUrl: entry.serverUrl,
        pricePerHour: entry.live?.pricePerHour ?? entry.pricePerHour,
        instanceId: entry.id,
        gpuName: entry.gpuName,
        status: entry.status,
        lastHealth: entry.lastHealth,
      })),
    ];
    res.json({ targets, activeBurnRatePerHour: Number(registry.activeBurnRatePerHour().toFixed(4)) });
  } catch (err) {
    fail(res, err);
  }
});
