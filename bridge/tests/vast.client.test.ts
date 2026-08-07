/**
 * vast.ai client: search filter translation, request shapes, response
 * envelope handling, and the money-moving calls — all against fixtures.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-vast-client-"));
process.env.DATA_DIR = path.join(tempDir, "data");
process.env.VAST_API_KEY_FILE = path.join(tempDir, "no-such-key");

const { VastClient, VastNotConfiguredError, buildOfferQuery, buildRentBody } = await import("../src/vast/client.ts");
const { makeFakeFetch, readOnlyRoutes, fixture } = await import("./helpers/vast-fetch.ts");
import type { RecordedCall } from "./helpers/vast-fetch.ts";

const KEY = "test-key-not-a-real-credential";
const newClient = (fetchImpl: ReturnType<typeof makeFakeFetch>) =>
  new VastClient({ apiKey: KEY, fetchImpl, maxRetries: 0, sleep: async () => {} });

// ---------------------------------------------------------------------------
// query building
// ---------------------------------------------------------------------------

test("an empty filter set still excludes rented, external and unverified offers", () => {
  const query = buildOfferQuery();
  assert.deepEqual(query.rentable, { eq: true });
  assert.deepEqual(query.rented, { eq: false });
  assert.deepEqual(query.external, { eq: false });
  assert.deepEqual(query.verified, { eq: true });
  assert.equal(query.type, "on-demand");
  assert.deepEqual(query.order, [["dph_total", "asc"]]);
});

test("VRAM filters convert GB to vast's 1000-based MB", () => {
  const query = buildOfferQuery({ minGpuRamGb: 24, minGpuTotalRamGb: 48, minCpuRamGb: 32 });
  assert.deepEqual(query.gpu_ram, { gte: 24000 }, "24 GB must become 24000, not 24576");
  assert.deepEqual(query.gpu_total_ram, { gte: 48000 });
  assert.deepEqual(query.cpu_ram, { gte: 32000 });
});

test("a single GPU name uses eq and several use in", () => {
  assert.deepEqual(buildOfferQuery({ gpuName: "RTX 4090" }).gpu_name, { eq: "RTX 4090" });
  assert.deepEqual(buildOfferQuery({ gpuName: ["RTX 4090", "RTX 5090"] }).gpu_name, {
    in: ["RTX 4090", "RTX 5090"],
  });
});

test("price, reliability, disk, network and CUDA filters map to the documented fields", () => {
  const query = buildOfferQuery({
    maxPricePerHour: 0.5,
    minReliability: 0.98,
    minDiskGb: 100,
    minInetDownMbps: 500,
    minCudaVersion: 12.4,
  });
  assert.deepEqual(query.dph_total, { lte: 0.5 });
  // The filterable name is `reliability`; results echo back `reliability2`.
  assert.deepEqual(query.reliability, { gte: 0.98 });
  assert.deepEqual(query.disk_space, { gte: 100 });
  assert.deepEqual(query.inet_down, { gte: 500 });
  assert.deepEqual(query.cuda_max_good, { gte: 12.4 });
});

test("regions are upper-cased and switch between eq and in", () => {
  assert.deepEqual(buildOfferQuery({ region: "us" }).geolocation, { eq: "US" });
  assert.deepEqual(buildOfferQuery({ region: ["us", "de"] }).geolocation, { in: ["US", "DE"] });
});

test("exact numGpus wins over minNumGpus", () => {
  assert.deepEqual(buildOfferQuery({ numGpus: 2, minNumGpus: 4 }).num_gpus, { eq: 2 });
  assert.deepEqual(buildOfferQuery({ minNumGpus: 4 }).num_gpus, { gte: 4 });
});

test("direct ports default to 2 so unreachable hosts are filtered out", () => {
  assert.deepEqual(buildOfferQuery().direct_port_count, { gte: 2 });
  assert.deepEqual(buildOfferQuery({ minDirectPorts: 6 }).direct_port_count, { gte: 6 });
});

test("allocated_storage tracks the disk being rented so the quote is accurate", () => {
  assert.equal(buildOfferQuery({ diskGb: 120 }).allocated_storage, 120);
});

test("limit is clamped into a sane range", () => {
  assert.equal(buildOfferQuery({ limit: 5 }).limit, 5);
  assert.equal(buildOfferQuery({ limit: 100000 }).limit, 200);
  assert.equal(buildOfferQuery({ limit: 0 }).limit, 1);
});

// ---------------------------------------------------------------------------
// search over the wire
// ---------------------------------------------------------------------------

test("searchOffers posts the query to /api/v0/bundles/ and reads the offers key", async () => {
  const fetchImpl = makeFakeFetch(readOnlyRoutes());
  const { offers, query } = await newClient(fetchImpl).searchOffers({ gpuName: "RTX 4090", minGpuRamGb: 24 });

  const call = fetchImpl.callsTo("POST", "/api/v0/bundles/")[0];
  assert.ok(call, "expected a POST to /api/v0/bundles/");
  assert.deepEqual(call.body, query, "the request body is the query object itself, not wrapped in {q}");
  assert.deepEqual((call.body as Record<string, unknown>).gpu_name, { eq: "RTX 4090" });
  // The fixture's third offer is already rented; the client re-filters because
  // the server does not reliably honour that filter.
  assert.equal(offers.length, 2);
  assert.ok(!offers.some((offer) => offer.rented === true));
});

test("the API key travels in an Authorization header and never in the URL", async () => {
  const fetchImpl = makeFakeFetch(readOnlyRoutes());
  await newClient(fetchImpl).searchOffers();
  for (const call of fetchImpl.calls) {
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.ok(!call.url.includes(KEY), "the key must never appear in a URL");
    assert.ok(!call.url.includes("api_key"), "the legacy api_key query param must not be used");
  }
});

test("a client cannot be constructed without a key", () => {
  assert.throws(() => new VastClient({ apiKey: "" }), VastNotConfiguredError);
  assert.equal(VastClient.tryCreate({ apiKey: "" }), null);
});

// ---------------------------------------------------------------------------
// instances
// ---------------------------------------------------------------------------

test("listInstances reads the v1 array envelope and stops when next_token is null", async () => {
  const fetchImpl = makeFakeFetch(readOnlyRoutes());
  const instances = await newClient(fetchImpl).listInstances();
  assert.equal(instances.length, 2);
  assert.equal(instances[0].id, 20250806);
  assert.equal(fetchImpl.callsTo("GET", "/api/v1/instances/").length, 1, "one page, one request");
});

test("listInstances follows next_token across pages", async () => {
  const page1 = { ...fixture<Record<string, unknown>>("instances-list"), next_token: "token-2" };
  const page2 = { instances: [], next_token: null };
  const fetchImpl = makeFakeFetch([
    {
      method: "GET",
      path: "/api/v1/instances/",
      response: (call: RecordedCall) => (call.path.includes("after_token=token-2") ? page2 : page1),
    },
  ]);
  const instances = await newClient(fetchImpl).listInstances();
  assert.equal(instances.length, 2);
  assert.equal(fetchImpl.callsTo("GET", "/api/v1/instances/").length, 2);
});

test("getInstance reads the OBJECT envelope of the detail endpoint", async () => {
  const fetchImpl = makeFakeFetch(readOnlyRoutes());
  const instance = await newClient(fetchImpl).getInstance(20250806);
  assert.equal(instance?.id, 20250806);
  assert.equal(instance?.actual_status, "running");
});

test("getInstance returns null when the contract is gone", async () => {
  const fetchImpl = makeFakeFetch([
    { method: "GET", path: "/api/v0/instances/", response: { instances: null } },
  ]);
  assert.equal(await newClient(fetchImpl).getInstance(404404), null);
});

test("getInstance rejects an array payload rather than mistaking it for one instance", async () => {
  const fetchImpl = makeFakeFetch([
    { method: "GET", path: "/api/v0/instances/", response: { instances: [{ id: 1 }] } },
  ]);
  assert.equal(await newClient(fetchImpl).getInstance(1), null);
});

// ---------------------------------------------------------------------------
// findOffer — the pre-rent quote lookup
// ---------------------------------------------------------------------------

test("findOffer filters by id and does not re-apply the user's search filters", async () => {
  const fetchImpl = makeFakeFetch(readOnlyRoutes());
  const offer = await newClient(fetchImpl).findOffer(11223344, 60);
  assert.equal(offer?.id, 11223344);
  const query = fetchImpl.calls[0].body as Record<string, unknown>;
  assert.deepEqual(query.id, { eq: 11223344 });
  // Resolving one known id must not exclude offers the user found with
  // relaxed filters, so verification and port count are left wide open.
  assert.ok(!("verified" in query), "findOffer must not require verification");
  assert.deepEqual(query.direct_port_count, { gte: 0 });
  assert.equal(query.allocated_storage, 60, "the quote must be priced against the disk being rented");
});

test("findOffer falls back to a broad search when filtering by id is rejected", async () => {
  let call = 0;
  const fetchImpl = makeFakeFetch([
    {
      method: "POST",
      path: "/api/v0/bundles/",
      response: (): unknown => fixture("offers-search"),
    },
  ]);
  const flaky = (async (input: string, init?: RequestInit) => {
    call++;
    // `id` is not documented as filterable; a deployment rejecting it must
    // degrade to the broad search rather than breaking rent entirely.
    if (call === 1) return new Response(JSON.stringify({ error: "invalid field id" }), { status: 400 });
    return fetchImpl(input, init);
  }) as typeof fetchImpl;
  const client = new VastClient({ apiKey: KEY, fetchImpl: flaky, maxRetries: 0, sleep: async () => {} });
  const offer = await client.findOffer(11223344, 60);
  assert.equal(offer?.id, 11223344, "the fallback must still resolve the offer");
  assert.equal(call, 2);
});

test("findOffer returns null for an offer that is gone", async () => {
  const fetchImpl = makeFakeFetch(readOnlyRoutes());
  assert.equal(await newClient(fetchImpl).findOffer(424242, 60), null);
});

test("findOffer refuses an offer that is already rented", async () => {
  const fetchImpl = makeFakeFetch(readOnlyRoutes());
  // Offer 99887766 in the fixture carries rented: true.
  assert.equal(await newClient(fetchImpl).findOffer(99887766, 60), null);
});

// ---------------------------------------------------------------------------
// rent body
// ---------------------------------------------------------------------------

test("the rent body publishes SSH and the solver port as env keys", () => {
  const body = buildRentBody({ solverPort: 8765, diskGb: 60, image: "nvidia/cuda:12.6.3-runtime-ubuntu24.04" });
  const env = body.env as Record<string, string>;
  // vast takes docker -p flags as env KEYS with the string value "1".
  assert.equal(env["-p 22:22"], "1");
  assert.equal(env["-p 8765:8765"], "1");
  assert.equal(body.disk, 60);
  assert.equal(body.client_id, "me");
  assert.equal(body.runtype, "ssh_direc ssh_proxy");
  assert.equal(body.cancel_unavail, true, "never leave a half-created instance billing storage");
  assert.ok(!("price" in body), "on-demand rentals must not send a bid price");
});

test("a custom solver port is the one published", () => {
  const env = buildRentBody({ solverPort: 9111 }).env as Record<string, string>;
  assert.equal(env["-p 9111:9111"], "1");
  assert.ok(!("-p 8765:8765" in env));
});

test("a bid price is sent as `price` only when given", () => {
  assert.equal(buildRentBody({ bidPricePerHour: 0.25 }).price, 0.25);
});

test("rent reads the instance id from new_contract, not id", async () => {
  const fetchImpl = makeFakeFetch([
    { method: "PUT", path: "/api/v0/asks/11223344/", response: { success: true, new_contract: 20250806 } },
  ]);
  const { instanceId } = await newClient(fetchImpl).rent(11223344, { diskGb: 60 });
  assert.equal(instanceId, 20250806);
  assert.equal(fetchImpl.calls[0].method, "PUT");
});

test("rent fails loudly when vast returns no instance id", async () => {
  const fetchImpl = makeFakeFetch([
    { method: "PUT", path: "/api/v0/asks/", response: { success: true } },
  ]);
  await assert.rejects(newClient(fetchImpl).rent(11223344), /returned no instance id/);
});

// ---------------------------------------------------------------------------
// lifecycle calls
// ---------------------------------------------------------------------------

test("start and stop are PUTs carrying the target state", async () => {
  const fetchImpl = makeFakeFetch([
    { method: "PUT", path: "/api/v0/instances/", response: { success: true, msg: "ok" } },
  ]);
  const client = newClient(fetchImpl);
  await client.start(20250806);
  await client.stop(20250806);
  assert.deepEqual(fetchImpl.calls[0].body, { state: "running" });
  assert.deepEqual(fetchImpl.calls[1].body, { state: "stopped" });
  assert.ok(fetchImpl.calls[0].path.endsWith("/api/v0/instances/20250806/"), "trailing slash is required");
});

test("destroy is a DELETE on the instance path", async () => {
  const fetchImpl = makeFakeFetch([
    { method: "DELETE", path: "/api/v0/instances/", response: { success: true, msg: "destroyed" } },
  ]);
  await newClient(fetchImpl).destroy(20250806);
  assert.equal(fetchImpl.calls[0].method, "DELETE");
  assert.ok(fetchImpl.calls[0].path.endsWith("/api/v0/instances/20250806/"));
});

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

test("a 200 carrying success:false is treated as a refusal", async () => {
  const fetchImpl = makeFakeFetch([
    {
      method: "PUT",
      path: "/api/v0/asks/",
      response: { success: false, error: "invalid_args", msg: "error 400: bad disk" },
    },
  ]);
  await assert.rejects(newClient(fetchImpl).rent(1), /invalid_args — error 400: bad disk/);
});

test("an HTTP error surfaces vast's own message and status", async () => {
  const fetchImpl = makeFakeFetch([
    { method: "POST", path: "/api/v0/bundles/", status: 401, response: { error: "unauthorized" } },
  ]);
  await assert.rejects(newClient(fetchImpl).searchOffers(), (err: Error & { status?: number }) => {
    assert.equal(err.status, 401);
    assert.match(err.message, /unauthorized/);
    return true;
  });
});

test("a 429 is retried with backoff and then succeeds", async () => {
  let attempts = 0;
  const fetchImpl = makeFakeFetch([
    {
      method: "POST",
      path: "/api/v0/bundles/",
      response: (): unknown => fixture("offers-search"),
    },
  ]);
  // Wrap the fake so the first two calls rate-limit.
  const throttled = (async (input: string, init?: RequestInit) => {
    attempts++;
    if (attempts <= 2)
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    return fetchImpl(input, init);
  }) as typeof fetchImpl;
  const client = new VastClient({ apiKey: KEY, fetchImpl: throttled, maxRetries: 3, sleep: async () => {} });
  const { offers } = await client.searchOffers();
  assert.equal(attempts, 3);
  assert.equal(offers.length, 2);
});

test("error messages never echo the API key", async () => {
  const fetchImpl = makeFakeFetch([
    {
      method: "POST",
      path: "/api/v0/bundles/",
      status: 403,
      response: { error: `key ${KEY} is not authorized` },
    },
  ]);
  await assert.rejects(newClient(fetchImpl).searchOffers(), (err: Error) => {
    assert.ok(!err.message.includes(KEY), `error leaked the key: ${err.message}`);
    assert.match(err.message, /<redacted>/);
    return true;
  });
});
