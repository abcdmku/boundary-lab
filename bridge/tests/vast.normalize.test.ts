/**
 * Normalization: the layer that absorbs vast.ai's unit and shape traps.
 * Every case here corresponds to a documented discrepancy between vast's
 * OpenAPI specs and its reference CLI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-vast-norm-"));
process.env.DATA_DIR = path.join(tempDir, "data");

const {
  normalizeOffer,
  normalizeInstance,
  normalizePorts,
  resolveSshEndpoint,
  resolveServerUrl,
  estimateCost,
  fatalInstanceReason,
} = await import("../src/vast/normalize.ts");
const { fixture } = await import("./helpers/vast-fetch.ts");
type Raw = Record<string, unknown>;

const offers = fixture<{ offers: Raw[] }>("offers-search").offers;
const runningInstance = fixture<{ instances: Raw }>("instance-running").instances;
const loadingInstance = fixture<{ instances: Raw }>("instance-loading").instances;

// ---------------------------------------------------------------------------
// offers
// ---------------------------------------------------------------------------

test("offer VRAM is converted from vast's 1000-based MB to GB", () => {
  const offer = normalizeOffer(offers[0]);
  assert.equal(offer.gpuRamGb, 24.6, "24564 MB is 24.6 GB in vast's units");
  assert.equal(offer.cpuRamGb, 128);
});

test("offer reliability comes from reliability2 and price fields keep their meaning", () => {
  const offer = normalizeOffer(offers[0]);
  assert.equal(offer.reliability, 0.9973);
  assert.equal(offer.pricePerHour, 0.3421);
  assert.equal(offer.gpuPricePerHour, 0.31);
  // On an OFFER, storage_cost is $/GB/month — named so it cannot be confused
  // with the instance field of the same name, which is $/hour.
  assert.equal(offer.storageCostPerGbMonth, 0.12);
});

test("a daily cost is derived so the UI never has to do price maths", () => {
  assert.equal(normalizeOffer(offers[0]).estimatedDailyCost, 8.21);
});

test("verification is read from either the boolean or the string form", () => {
  assert.equal(normalizeOffer({ verified: true }).verified, true);
  assert.equal(normalizeOffer({ verification: "verified" }).verified, true);
  assert.equal(normalizeOffer({ verification: "unverified" }).verified, false);
});

test("a sparse offer row normalizes without throwing", () => {
  const offer = normalizeOffer({ id: 5 });
  assert.equal(offer.id, 5);
  assert.equal(offer.gpuName, "unknown GPU");
  assert.equal(offer.pricePerHour, 0);
  assert.equal(offer.reliability, null);
});

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

test("port bindings parse HostPort from its string form", () => {
  const ports = normalizePorts({
    "22/tcp": [{ HostIp: "0.0.0.0", HostPort: "33525" }],
    "8765/tcp": [{ HostIp: "0.0.0.0", HostPort: "33526" }],
  });
  assert.deepEqual(ports, { "22/tcp": 33525, "8765/tcp": 33526 });
});

test("absent, null and empty port maps yield an empty object", () => {
  assert.deepEqual(normalizePorts(null), {});
  assert.deepEqual(normalizePorts(undefined), {});
  assert.deepEqual(normalizePorts({ "22/tcp": [] }), {});
});

test("the stale array-of-integers port shape does not crash", () => {
  // One of vast's own specs types `ports` this way; it is wrong, but a host
  // returning it must not take the bridge down.
  assert.deepEqual(normalizePorts([8080, 8081]), { "8080/tcp": 8080, "8081/tcp": 8081 });
});

// ---------------------------------------------------------------------------
// ssh + server url
// ---------------------------------------------------------------------------

test("a direct SSH endpoint is preferred: public IP + the mapped port 22", () => {
  const ssh = resolveSshEndpoint(runningInstance);
  assert.deepEqual(ssh, { host: "65.130.162.74", port: 33525, user: "root", direct: true });
});

test("without a mapped port 22 the ssh proxy is used", () => {
  const ssh = resolveSshEndpoint({ ssh_host: "ssh2281.vast.ai", ssh_port: 10882, ports: null });
  assert.deepEqual(ssh, { host: "ssh2281.vast.ai", port: 10882, user: "root", direct: false });
});

test("the proxy port is one higher for a jupyter runtype", () => {
  // A quirk of vast's proxy allocation, mirrored from the reference CLI.
  const ssh = resolveSshEndpoint({
    ssh_host: "ssh2281.vast.ai",
    ssh_port: 10882,
    image_runtype: "jupyter_proxy ssh_proxy",
    ports: null,
  });
  assert.equal(ssh?.port, 10883);
});

test("a still-booting instance has no ssh endpoint yet", () => {
  assert.equal(resolveSshEndpoint(loadingInstance), null);
});

test("the server URL is built from the mapped solver port", () => {
  assert.equal(resolveServerUrl(runningInstance, 8765), "http://65.130.162.74:33526");
  assert.equal(resolveServerUrl(runningInstance, 9999), null, "an unmapped port has no URL");
  assert.equal(resolveServerUrl(loadingInstance, 8765), null);
});

// ---------------------------------------------------------------------------
// cost + uptime
// ---------------------------------------------------------------------------

test("uptime and cost are computed from start_date, not the API's duration", () => {
  const startedAt = 1_754_400_000;
  const nowMs = (startedAt + 7200) * 1000; // exactly two hours later
  const { uptimeSeconds, estimatedCostUsd } = estimateCost(startedAt, 0.5, nowMs);
  assert.equal(uptimeSeconds, 7200);
  assert.equal(estimatedCostUsd, 1.0);
});

test("an instance that never started has no cost estimate", () => {
  assert.deepEqual(estimateCost(null, 0.5), { uptimeSeconds: null, estimatedCostUsd: null });
  assert.deepEqual(estimateCost(0, 0.5), { uptimeSeconds: null, estimatedCostUsd: null });
});

test("the fixture's contract duration is ignored in favour of real uptime", () => {
  const nowMs = (1_754_400_000 + 3600) * 1000;
  const instance = normalizeInstance(runningInstance, { nowMs });
  // The raw row carries duration: 273608757 (8.7 years of contract length).
  assert.equal(instance.uptimeSeconds, 3600);
  assert.equal(instance.estimatedCostUsd, 0.3421);
});

// ---------------------------------------------------------------------------
// instance status
// ---------------------------------------------------------------------------

test("running requires both the contract and the container to agree", () => {
  assert.equal(normalizeInstance(runningInstance).running, true);
  assert.equal(normalizeInstance(loadingInstance).running, false);
  assert.equal(
    normalizeInstance({ actual_status: "running", intended_status: "stopped" }).running,
    false,
    "a container running while the contract wants it stopped is not ready",
  );
});

test("instance storage_cost is read as $/hour, unlike the offer field", () => {
  assert.equal(normalizeInstance(runningInstance).storageCostPerHour, 0.0082);
});

test("dead-end container states are flagged terminal", () => {
  for (const status of ["exited", "offline", "unknown"]) {
    assert.equal(normalizeInstance({ actual_status: status }).terminal, true, status);
  }
  assert.equal(normalizeInstance({ actual_status: "loading" }).terminal, false);
});

test("fatalInstanceReason fails fast on an error status message", () => {
  assert.match(
    fatalInstanceReason({ actual_status: "loading", status_msg: "Error: image pull failed" }) ?? "",
    /image pull failed/,
  );
  assert.match(fatalInstanceReason({ actual_status: "exited" }) ?? "", /will not start/);
  assert.equal(fatalInstanceReason(loadingInstance), null, "a normal loading state is not fatal");
  assert.equal(fatalInstanceReason(runningInstance), null);
});
