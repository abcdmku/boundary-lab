import { fmtRate } from "./format";

/**
 * The id a job's stored target corresponds to in GET /api/targets.
 * `normalizeTarget` on the server stamps `instanceId` with the ComputeTarget id
 * ("vast:123"), so a round trip is lossless; a target pinned by bare URL has no
 * registry id and is identified by that URL.
 */
export function jobTargetId(job) {
  const t = job?.target;
  if (!t || t.type === "local") return "local";
  return t.instanceId || t.serverUrl || "local";
}

/** Human label for a job's target, preferring the live registry entry. */
export function jobTargetLabel(job, targets) {
  const id = jobTargetId(job);
  const known = (targets || []).find((t) => t.id === id);
  if (known) return known.label;
  const t = job?.target;
  if (!t || t.type === "local") return "local";
  return t.label || t.instanceId || t.serverUrl;
}

/** "RTX 4090 — box-a · $0.412/hr · 1 slot" — the one-line spec of a target. */
export function targetSummary(target) {
  if (!target) return "";
  const info = target.info || {};
  const bits = [];
  if (target.type === "local") bits.push("this machine");
  if (info.gpuName) bits.push(`${info.gpuName}${info.numGpus > 1 ? ` ×${info.numGpus}` : ""}`);
  if (typeof info.pricePerHour === "number" && info.pricePerHour > 0)
    bits.push(fmtRate(info.pricePerHour));
  bits.push(`${target.concurrency} slot${target.concurrency === 1 ? "" : "s"}`);
  if (target.status) bits.push(target.status);
  return bits.join(" · ");
}

/** Option text for a <select>: never hide WHY a target cannot be picked. */
export function targetOptionLabel(target) {
  const info = target.info || {};
  const bits = [target.label];
  if (typeof info.pricePerHour === "number" && info.pricePerHour > 0)
    bits.push(fmtRate(info.pricePerHour));
  if (!target.available) bits.push("unavailable");
  return bits.join(" — ");
}
