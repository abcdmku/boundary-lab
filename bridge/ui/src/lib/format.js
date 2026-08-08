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
