/**
 * The /api/vast HTTP surface, exercised end to end against a fake vast.ai.
 *
 * The headline guarantee under test: NOTHING that costs money happens without
 * an explicit {"confirm": true}. Several tests assert that the upstream API
 * was never called at all on the unconfirmed path — refusing after renting
 * would be worthless.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-vast-routes-"));
process.env.DATA_DIR = path.join(tempDir, "data");
process.env.VAST_API_KEY = "routes-test-key-not-real";
process.env.VAST_MAX_PRICE_PER_HOUR = "2.0";

const express = (await import("express")).default;
const store = await import("../src/store.ts");
const registry = await import("../src/vast/registry.ts");
const { vastRouter } = await import("../src/vast/routes.ts");
const { makeFakeFetch, readOnlyRoutes } = await import("./helpers/vast-fetch.ts");
import type { FakeFetch, FakeRoute } from "./helpers/vast-fetch.ts";
import type { ManagedInstance } from "../src/vast/types.ts";

store.loadStore();

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use("/api/vast", vastRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => server.close());

const realFetch = globalThis.fetch;
let fake: FakeFetch;

/** Install a fake upstream. The bridge's own HTTP calls pass through. */
function useUpstream(routes: FakeRoute[]) {
  fake = makeFakeFetch(routes);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    // Requests to our own test server are the test client talking to the
    // router; only vast.ai traffic goes to the fake.
    if (url.startsWith(base)) return realFetch(input, init);
    return fake(url, init);
  }) as typeof fetch;
}

const api = async (method: string, routePath: string, body?: unknown) => {
  const response = await realFetch(`${base}${routePath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const reset = () => {
  for (const entry of registry.list()) registry.forget(entry.id);
};

const seed = (overrides: Partial<ManagedInstance> = {}): ManagedInstance =>
  registry.add({
    id: 20250806,
    label: "boundary-lab-solver",
    status: "ready",
    gpuName: "RTX 4090",
    numGpus: 1,
    pricePerHour: 0.3421,
    offerId: 11223344,
    image: "nvidia/cuda:12.6.3-runtime-ubuntu24.04",
    diskGb: 60,
    solverPort: 8765,
    serverUrl: "http://65.130.162.74:33526",
    ssh: { host: "65.130.162.74", port: 33525, user: "root", direct: true },
    createdAt: new Date().toISOString(),
    provisionedAt: new Date().toISOString(),
    error: null,
    progress: null,
    lastHealth: { checkedAt: new Date().toISOString(), ok: true },
    live: null,
    ...overrides,
  });

const rentRoutes = (): FakeRoute[] => [
  ...readOnlyRoutes(),
  { method: "PUT", path: "/api/v0/asks/", response: { success: true, new_contract: 20250806 } },
  { method: "PUT", path: "/api/v0/instances/", response: { success: true, msg: "ok" } },
  { method: "DELETE", path: "/api/v0/instances/", response: { success: true, msg: "destroyed" } },
];

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("GET /status reports configuration without exposing the key", async () => {
  useUpstream(readOnlyRoutes());
  const { status, body } = await api("GET", "/api/vast/status");
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.keySource, "env");
  assert.equal((body.keyFingerprint as string).length, 8);
  assert.ok(!JSON.stringify(body).includes("routes-test-key-not-real"), "the key leaked into /status");
  assert.equal((body.limits as Record<string, number>).maxPricePerHour, 2.0);
});

// ---------------------------------------------------------------------------
// offer search
// ---------------------------------------------------------------------------

test("POST /offers/search returns normalized offers and echoes the query", async () => {
  useUpstream(readOnlyRoutes());
  const { status, body } = await api("POST", "/api/vast/offers/search", {
    gpuName: "RTX 4090",
    minGpuRamGb: 24,
    maxPricePerHour: 1.5,
  });
  assert.equal(status, 200);
  const offers = body.offers as Array<Record<string, unknown>>;
  assert.equal(offers.length, 2);
  assert.equal(offers[0].gpuRamGb, 24.6, "offers arrive in GB, not vast's MB");
  assert.deepEqual((body.query as Record<string, unknown>).gpu_ram, { gte: 24000 });
});

test("a non-numeric filter is rejected with 400", async () => {
  useUpstream(readOnlyRoutes());
  const { status, body } = await api("POST", "/api/vast/offers/search", { maxPricePerHour: "cheap" });
  assert.equal(status, 400);
  assert.match(String(body.error), /maxPricePerHour must be a number/);
});

// ---------------------------------------------------------------------------
// RENT — the cost-safety gate
// ---------------------------------------------------------------------------

test("renting without confirm returns 402 with a quote and spends nothing", async () => {
  reset();
  useUpstream(rentRoutes());
  const { status, body } = await api("POST", "/api/vast/instances", { offerId: 11223344 });
  assert.equal(status, 402);
  assert.equal(body.requiresConfirmation, true);
  const quote = body.quote as Record<string, unknown>;
  assert.equal(quote.pricePerHour, 0.3421);
  assert.equal(quote.estimatedDailyCost, 8.21);
  // The critical assertion: no rent call was made upstream.
  assert.equal(fake.callsTo("PUT", "/api/v0/asks/").length, 0, "an unconfirmed request must not rent");
  assert.equal(registry.list().length, 0, "nothing should have been recorded");
});

test("confirm must be boolean true — truthy strings do not authorize spend", async () => {
  reset();
  useUpstream(rentRoutes());
  for (const confirm of ["true", 1, "yes", {}, [1]]) {
    const { status } = await api("POST", "/api/vast/instances", { offerId: 11223344, confirm });
    assert.equal(status, 402, `confirm: ${JSON.stringify(confirm)} must not authorize a rent`);
  }
  assert.equal(fake.callsTo("PUT", "/api/v0/asks/").length, 0);
});

test("renting with confirm:true rents once and records the instance", async () => {
  reset();
  useUpstream(rentRoutes());
  const { status, body } = await api("POST", "/api/vast/instances", {
    offerId: 11223344,
    confirm: true,
    label: "solver-a",
  });
  assert.equal(status, 201);
  assert.equal(fake.callsTo("PUT", "/api/v0/asks/11223344/").length, 1);
  const instance = body.instance as Record<string, unknown>;
  assert.equal(instance.id, 20250806);
  assert.equal(instance.status, "renting");
  assert.equal(instance.label, "solver-a");
  assert.equal(body.pricePerHour, 0.3421, "the response must state the committed price");
  assert.match(String(body.warning), /billing/i);
  assert.equal(registry.get(20250806)?.pricePerHour, 0.3421);
});

test("an offer above the price ceiling is refused with 403 even if confirmed", async () => {
  reset();
  process.env.VAST_MAX_PRICE_PER_HOUR = "0.5";
  const { config } = await import("../src/config.ts");
  const previous = config.vast.maxPricePerHour;
  config.vast.maxPricePerHour = 0.5;
  try {
    useUpstream(rentRoutes());
    // The RTX 5090 offer in the fixture is $1.1875/hour.
    const { status, body } = await api("POST", "/api/vast/instances", { offerId: 55667788, confirm: true });
    assert.equal(status, 403);
    assert.match(String(body.error), /above this bridge's ceiling/);
    assert.equal(fake.callsTo("PUT", "/api/v0/asks/").length, 0, "the ceiling must be checked before renting");
  } finally {
    config.vast.maxPricePerHour = previous;
  }
});

test("a stale offer id is refused rather than renting something else", async () => {
  reset();
  useUpstream(rentRoutes());
  const { status, body } = await api("POST", "/api/vast/instances", { offerId: 424242, confirm: true });
  assert.equal(status, 409);
  assert.match(String(body.error), /no longer available/);
  assert.equal(fake.callsTo("PUT", "/api/v0/asks/").length, 0);
});

test("a rented-out offer is not rentable even though it is in the search response", async () => {
  reset();
  useUpstream(rentRoutes());
  // Offer 99887766 in the fixture has rented: true.
  const { status } = await api("POST", "/api/vast/instances", { offerId: 99887766, confirm: true });
  assert.equal(status, 409);
});

test("offerId is required", async () => {
  useUpstream(rentRoutes());
  const { status, body } = await api("POST", "/api/vast/instances", { confirm: true });
  assert.equal(status, 400);
  assert.match(String(body.error), /offerId/);
});

// ---------------------------------------------------------------------------
// start / stop / destroy
// ---------------------------------------------------------------------------

test("starting an instance needs confirmation because it resumes GPU billing", async () => {
  reset();
  seed({ status: "stopped" });
  useUpstream(rentRoutes());
  const unconfirmed = await api("POST", "/api/vast/instances/20250806/start");
  assert.equal(unconfirmed.status, 402);
  assert.equal(fake.callsTo("PUT", "/api/v0/instances/").length, 0);

  const confirmed = await api("POST", "/api/vast/instances/20250806/start", { confirm: true });
  assert.equal(confirmed.status, 200);
  assert.equal(fake.callsTo("PUT", "/api/v0/instances/20250806/").length, 1);
  // A restart reassigns the port mapping, so cached endpoints must be dropped.
  assert.equal(registry.get(20250806)?.serverUrl, null);
  assert.equal(registry.get(20250806)?.status, "starting");
});

test("stopping needs no confirmation because it saves money, but warns about storage", async () => {
  reset();
  seed();
  useUpstream(rentRoutes());
  const { status, body } = await api("POST", "/api/vast/instances/20250806/stop");
  assert.equal(status, 200);
  assert.match(String(body.warning), /Storage charges continue/);
  assert.equal(registry.get(20250806)?.status, "stopped");
});

test("destroying needs confirmation and reports the estimated spend", async () => {
  reset();
  seed({
    live: {
      actualStatus: "running",
      intendedStatus: "running",
      statusMsg: null,
      pricePerHour: 0.3421,
      startedAt: 1_754_400_000,
      uptimeSeconds: 7200,
      estimatedCostUsd: 0.6842,
      refreshedAt: new Date().toISOString(),
    },
  });
  useUpstream(rentRoutes());

  const unconfirmed = await api("DELETE", "/api/vast/instances/20250806");
  assert.equal(unconfirmed.status, 402);
  assert.equal((unconfirmed.body.quote as Record<string, unknown>).estimatedCostUsd, 0.6842);
  assert.equal(fake.callsTo("DELETE", "/api/v0/instances/").length, 0, "an unconfirmed delete must not destroy");

  const confirmed = await api("DELETE", "/api/vast/instances/20250806", { confirm: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.destroyed, true);
  assert.equal(fake.callsTo("DELETE", "/api/v0/instances/20250806/").length, 1);
  assert.equal(registry.get(20250806)?.status, "destroyed");
});

test("acting on an unknown instance is a 404", async () => {
  reset();
  useUpstream(rentRoutes());
  for (const [method, route] of [
    ["POST", "/api/vast/instances/999999/stop"],
    ["POST", "/api/vast/instances/999999/provision"],
    ["DELETE", "/api/vast/instances/999999"],
  ] as const) {
    const { status } = await api(method, route, { confirm: true });
    assert.equal(status, 404, `${method} ${route}`);
  }
});

test("a malformed instance id is a 400, not a crash", async () => {
  useUpstream(rentRoutes());
  const { status } = await api("POST", "/api/vast/instances/not-a-number/stop");
  assert.equal(status, 400);
});

// ---------------------------------------------------------------------------
// registry bookkeeping
// ---------------------------------------------------------------------------

test("forgetting a live instance requires confirmation; a destroyed one does not", async () => {
  reset();
  seed({ status: "ready" });
  useUpstream(rentRoutes());
  const refused = await api("DELETE", "/api/vast/instances/20250806/registry");
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /does NOT stop its billing/);
  assert.ok(registry.get(20250806), "the entry must survive a refused forget");

  registry.patch(20250806, { status: "destroyed" });
  const allowed = await api("DELETE", "/api/vast/instances/20250806/registry");
  assert.equal(allowed.status, 200);
  assert.equal(registry.get(20250806), undefined);
});

test("an existing vast instance can be imported and is unverified until health-checked", async () => {
  reset();
  useUpstream(readOnlyRoutes());
  const { status, body } = await api("POST", "/api/vast/instances/20250806/import", {});
  assert.equal(status, 201);
  const instance = body.instance as Record<string, unknown>;
  // Imported means "we did not provision this" — never assume it is ready.
  assert.equal(instance.status, "unknown");
  assert.equal(instance.gpuName, "RTX 4090");

  const again = await api("POST", "/api/vast/instances/20250806/import", {});
  assert.equal(again.status, 409, "importing twice is a conflict");
});

test("GET /instances folds live vast state into the registry", async () => {
  reset();
  seed({ status: "provisioning", serverUrl: null, ssh: null });
  useUpstream(readOnlyRoutes());
  const { status, body } = await api("GET", "/api/vast/instances");
  assert.equal(status, 200);
  const instances = body.instances as Array<Record<string, unknown>>;
  const entry = instances.find((candidate) => candidate.id === 20250806)!;
  assert.equal(entry.serverUrl, "http://65.130.162.74:33526");
  assert.equal((entry.live as Record<string, unknown>).actualStatus, "running");
});

test("GET /instances?refresh=false answers from the registry without calling vast", async () => {
  reset();
  seed();
  useUpstream(readOnlyRoutes());
  const { status } = await api("GET", "/api/vast/instances?refresh=false");
  assert.equal(status, 200);
  assert.equal(fake.calls.length, 0, "refresh=false must not hit the upstream API");
});

// ---------------------------------------------------------------------------
// health + targets
// ---------------------------------------------------------------------------

test("a health probe records the result and can promote an instance to ready", async () => {
  reset();
  seed({ status: "provisioning", lastHealth: null });
  useUpstream([
    ...readOnlyRoutes(),
    { method: "GET", path: "/health", response: { status: "ok", solver: "beat_cuda", backend: "beat_cuda" } },
  ]);
  const { status, body } = await api("POST", "/api/vast/instances/20250806/health");
  assert.equal(status, 200);
  assert.equal((body.health as Record<string, unknown>).ok, true);
  const instance = body.instance as Record<string, unknown>;
  assert.equal(instance.status, "ready");
  assert.equal((instance.lastHealth as Record<string, unknown>).solver, "beat_cuda");
});

test("a health probe on an instance with no server URL is a 409", async () => {
  reset();
  seed({ serverUrl: null });
  useUpstream(readOnlyRoutes());
  const { status, body } = await api("POST", "/api/vast/instances/20250806/health");
  assert.equal(status, 409);
  assert.match(String(body.error), /provision it first/);
});

test("GET /targets always offers local and marks only healthy remotes available", async () => {
  reset();
  seed({ id: 1, status: "ready", serverUrl: "http://a:1", lastHealth: { checkedAt: "x", ok: true } });
  seed({ id: 2, status: "provisioning", serverUrl: null, lastHealth: null });
  useUpstream(readOnlyRoutes());
  const { status, body } = await api("GET", "/api/vast/targets");
  assert.equal(status, 200);
  const targets = body.targets as Array<Record<string, unknown>>;
  assert.equal(targets[0].id, "local");
  assert.equal(targets[0].available, true);
  const ready = targets.find((target) => target.id === "vast:1")!;
  const pending = targets.find((target) => target.id === "vast:2")!;
  assert.equal(ready.available, true);
  assert.equal(ready.serverUrl, "http://a:1");
  assert.equal(pending.available, false, "an unprovisioned instance must not be selectable");
});

// ---------------------------------------------------------------------------
// no key configured
// ---------------------------------------------------------------------------

test("without a key the read-only status endpoint still works and actions answer 501", async () => {
  reset();
  const savedKey = process.env.VAST_API_KEY;
  process.env.VAST_API_KEY = "";
  process.env.VAST_API_KEY_FILE = path.join(tempDir, "no-such-key-file");
  try {
    useUpstream(readOnlyRoutes());
    const status = await api("GET", "/api/vast/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, false);

    const search = await api("POST", "/api/vast/offers/search", {});
    assert.equal(search.status, 501);
    assert.match(String(search.body.error), /VAST_API_KEY/);
  } finally {
    process.env.VAST_API_KEY = savedKey;
  }
});

test.after(() => {
  globalThis.fetch = realFetch;
});
