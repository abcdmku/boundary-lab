/**
 * The managed-instance registry: persistence into state.json and the
 * instance-state transitions that decide whether a box is safe to solve on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-vast-registry-"));
const dataDir = path.join(tempDir, "data");
process.env.DATA_DIR = dataDir;

const store = await import("../src/store.ts");
const registry = await import("../src/vast/registry.ts");
const { normalizeInstance } = await import("../src/vast/normalize.ts");
const { fixture } = await import("./helpers/vast-fetch.ts");
import type { ManagedInstance, VastInstance } from "../src/vast/types.ts";

store.loadStore();

const reset = () => {
  for (const entry of registry.list()) registry.forget(entry.id);
};

const makeEntry = (overrides: Partial<ManagedInstance> = {}): ManagedInstance => ({
  id: 20250806,
  label: "boundary-lab-solver",
  status: "renting",
  gpuName: "RTX 4090",
  numGpus: 1,
  pricePerHour: 0.3421,
  offerId: 11223344,
  image: "nvidia/cuda:12.6.3-runtime-ubuntu24.04",
  diskGb: 60,
  solverPort: 8765,
  serverUrl: null,
  ssh: null,
  createdAt: new Date().toISOString(),
  provisionedAt: null,
  error: null,
  progress: null,
  lastHealth: null,
  live: null,
  ...overrides,
});

const liveMap = (...instances: VastInstance[]) =>
  new Map(instances.map((instance) => [instance.id, instance]));

const runningLive = () =>
  normalizeInstance(fixture<{ instances: Record<string, unknown> }>("instance-running").instances, {
    solverPort: 8765,
  });

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

test("an entry persists to the vast section of state.json", () => {
  reset();
  registry.add(makeEntry());
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  assert.equal(persisted.vast.instances.length, 1);
  assert.equal(persisted.vast.instances[0].id, 20250806);
  assert.ok(Array.isArray(persisted.jobs), "the job ledger must be untouched");
  assert.equal(persisted.version, 2);
});

test("adding the same id twice replaces rather than duplicates", () => {
  reset();
  registry.add(makeEntry());
  registry.add(makeEntry({ label: "renamed" }));
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get(20250806)?.label, "renamed");
});

test("patching an unknown id is a no-op, not a throw", () => {
  reset();
  assert.equal(registry.patch(999999, { label: "ghost" }), undefined);
});

test("forget removes the entry and reports whether it existed", () => {
  reset();
  registry.add(makeEntry());
  assert.equal(registry.forget(20250806), true);
  assert.equal(registry.forget(20250806), false);
  assert.equal(registry.list().length, 0);
});

test("a feature section cannot be written over the run ledger", () => {
  assert.throws(() => store.writeSection("runs", []), /not a feature section/);
});

// ---------------------------------------------------------------------------
// health transitions
// ---------------------------------------------------------------------------

test("a passing health check promotes an instance to ready and clears the error", () => {
  reset();
  registry.add(makeEntry({ status: "provisioning", error: "an earlier failure" }));
  const updated = registry.setHealth(20250806, {
    checkedAt: new Date().toISOString(),
    ok: true,
    solver: "beat_cuda",
  });
  assert.equal(updated?.status, "ready");
  assert.equal(updated?.error, null);
});

test("a failing health check downgrades ready to error", () => {
  reset();
  registry.add(makeEntry({ status: "ready" }));
  const updated = registry.setHealth(20250806, {
    checkedAt: new Date().toISOString(),
    ok: false,
    error: "connection refused",
  });
  assert.equal(updated?.status, "error");
});

test("a failing health check does NOT disturb an instance still provisioning", () => {
  reset();
  registry.add(makeEntry({ status: "provisioning" }));
  const updated = registry.setHealth(20250806, {
    checkedAt: new Date().toISOString(),
    ok: false,
    error: "connection refused",
  });
  // The server legitimately is not up yet — this must not be reported as a failure.
  assert.equal(updated?.status, "provisioning");
});

test("a failing health check does not resurrect a deliberately stopped instance", () => {
  reset();
  registry.add(makeEntry({ status: "stopped" }));
  const updated = registry.setHealth(20250806, {
    checkedAt: new Date().toISOString(),
    ok: false,
    error: "connection refused",
  });
  assert.equal(updated?.status, "stopped");
});

// ---------------------------------------------------------------------------
// reconcile against live vast state
// ---------------------------------------------------------------------------

test("reconcile refreshes the ssh endpoint, server URL and cost from live state", () => {
  reset();
  registry.add(makeEntry({ status: "provisioning" }));
  registry.reconcile(liveMap(runningLive()));
  const entry = registry.get(20250806)!;
  assert.equal(entry.serverUrl, "http://65.130.162.74:33526");
  assert.deepEqual(entry.ssh, { host: "65.130.162.74", port: 33525, user: "root", direct: true });
  assert.equal(entry.live?.actualStatus, "running");
  assert.ok((entry.live?.estimatedCostUsd ?? 0) > 0);
});

test("an instance missing upstream is marked destroyed and loses its endpoints", () => {
  reset();
  registry.add(makeEntry({ status: "ready", serverUrl: "http://1.2.3.4:5678" }));
  registry.reconcile(liveMap()); // nothing live
  const entry = registry.get(20250806)!;
  assert.equal(entry.status, "destroyed");
  assert.equal(entry.serverUrl, null);
  assert.equal(entry.ssh, null);
});

test("a NON-authoritative reconcile leaves unmentioned instances alone", () => {
  reset();
  registry.add(makeEntry({ id: 1, status: "ready", serverUrl: "http://a:1" }));
  registry.add(makeEntry({ id: 20250806, status: "provisioning" }));
  // A single-instance lookup must not be read as "everything else is gone" —
  // that would mark every other managed instance destroyed.
  registry.reconcile(liveMap(runningLive()), { authoritative: false });
  assert.equal(registry.get(1)?.status, "ready", "an unmentioned instance must be untouched");
  assert.equal(registry.get(1)?.serverUrl, "http://a:1");
  assert.equal(registry.get(20250806)?.live?.actualStatus, "running", "the named one still refreshes");
});

test("an authoritative reconcile does mark unmentioned instances destroyed", () => {
  reset();
  registry.add(makeEntry({ id: 1, status: "ready", serverUrl: "http://a:1" }));
  registry.reconcile(liveMap(runningLive())); // authoritative by default
  assert.equal(registry.get(1)?.status, "destroyed");
});

test("a destroyed entry is kept for the audit trail, not deleted", () => {
  reset();
  registry.add(makeEntry({ status: "ready" }));
  registry.reconcile(liveMap());
  assert.equal(registry.list().length, 1, "history must survive reconcile");
});

test("a stopped contract downgrades a ready instance to stopped", () => {
  reset();
  registry.add(makeEntry({ status: "ready", serverUrl: "http://1.2.3.4:5678" }));
  const stopped = { ...runningLive(), actualStatus: "stopped", intendedStatus: "stopped", running: false, ports: {} };
  registry.reconcile(liveMap(stopped));
  const entry = registry.get(20250806)!;
  assert.equal(entry.status, "stopped");
  assert.equal(entry.serverUrl, null, "a stopped box's cached URL is a lie");
});

test("a resumed instance is unknown until re-verified, never silently ready", () => {
  reset();
  registry.add(makeEntry({ status: "stopped", provisionedAt: new Date().toISOString() }));
  registry.reconcile(liveMap(runningLive()));
  assert.equal(registry.get(20250806)?.status, "unknown");
});

test("a resumed but never-provisioned instance goes to starting", () => {
  reset();
  registry.add(makeEntry({ status: "stopped", provisionedAt: null }));
  registry.reconcile(liveMap(runningLive()));
  assert.equal(registry.get(20250806)?.status, "starting");
});

test("an instance that reappears upstream is no longer destroyed", () => {
  reset();
  registry.add(makeEntry({ status: "destroyed" }));
  registry.reconcile(liveMap(runningLive()));
  assert.equal(registry.get(20250806)?.status, "unknown");
});

// ---------------------------------------------------------------------------
// selection + cost roll-up
// ---------------------------------------------------------------------------

test("only provisioned, healthy, reachable instances are selectable", () => {
  reset();
  const healthy = { checkedAt: new Date().toISOString(), ok: true };
  registry.add(makeEntry({ id: 1, status: "ready", serverUrl: "http://a:1", lastHealth: healthy }));
  registry.add(makeEntry({ id: 2, status: "ready", serverUrl: null, lastHealth: healthy }));
  registry.add(makeEntry({ id: 3, status: "provisioning", serverUrl: "http://c:3", lastHealth: healthy }));
  registry.add(
    makeEntry({
      id: 4,
      status: "ready",
      serverUrl: "http://d:4",
      lastHealth: { checkedAt: new Date().toISOString(), ok: false },
    }),
  );
  assert.deepEqual(
    registry.healthyInstances().map((entry) => entry.id),
    [1],
  );
});

test("the burn rate sums live prices and excludes destroyed and stopped boxes", () => {
  reset();
  const live = (pricePerHour: number, actualStatus: string) => ({
    actualStatus,
    intendedStatus: actualStatus,
    statusMsg: null,
    pricePerHour,
    startedAt: 1_754_400_000,
    uptimeSeconds: 3600,
    estimatedCostUsd: pricePerHour,
    refreshedAt: new Date().toISOString(),
  });
  registry.add(makeEntry({ id: 1, status: "ready", live: live(0.34, "running") }));
  registry.add(makeEntry({ id: 2, status: "stopped", live: live(0.18, "stopped") }));
  registry.add(makeEntry({ id: 3, status: "destroyed", live: live(1.2, "running") }));
  registry.add(makeEntry({ id: 4, status: "provisioning", live: live(0.5, "running") }));
  assert.equal(Number(registry.activeBurnRatePerHour().toFixed(4)), 0.84);
});

test("the registry survives a reload from disk", async () => {
  reset();
  registry.add(makeEntry({ status: "ready", serverUrl: "http://1.2.3.4:5678" }));
  store.loadStore(); // re-read state.json, as a bridge restart would
  const entry = registry.get(20250806);
  assert.equal(entry?.status, "ready");
  assert.equal(entry?.serverUrl, "http://1.2.3.4:5678");
});
