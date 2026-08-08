export function fmtInt(n) {
  return Number(n).toLocaleString("en-US");
}

export function fmtScore(v) {
  return Number(v).toFixed(2);
}

export function fmtVal(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return v.map(fmtVal).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function relTime(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}

// ---- money / time, for the cost-bearing cloud surfaces ----

/** "$0.412" — cloud prices are sub-cent-significant, so 3 places by default. */
export function fmtMoney(v, places = 3) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return "$" + v.toFixed(places);
}

/** "$0.412/hr", the unit every rent decision is actually made in. */
export function fmtRate(v) {
  return typeof v === "number" && Number.isFinite(v) ? `${fmtMoney(v)}/hr` : "—";
}

/** "3h 12m" / "12m 40s" — uptime, never a precise clock. */
export function fmtDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function fmtNum(v, places = 2) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(places) : "—";
}

/** "1.1 GiB" — binary units, matching the python layer's VRAM estimates. */
export function fmtBytes(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * "42m", "1h20", "18s" — a duration at a glance, for cards that have room for
 * three or four characters and nothing more. Null/unknown is an em dash on
 * purpose: a schedule that guesses is worse than one that admits it cannot say.
 */
export function fmtShort(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${String(rem).padStart(2, "0")}`;
}

/** Clock time `seconds` from now: "14:20". Used for "everything clear by". */
export function fmtClock(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const at = new Date(Date.now() + seconds * 1000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** "8k" / "12.5k" / "840" — frequencies and triangle counts, three chars wide. */
export function fmtCompact(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1000) return `${(v / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}
