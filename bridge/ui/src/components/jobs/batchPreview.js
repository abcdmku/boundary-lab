import { fmtVal } from "../../lib/format";

/** Server-side cap (actions.MAX_BATCH_JOBS). Mirrored so the count is honest. */
export const MAX_BATCH_JOBS = 200;

export const SOLVE_OPTION_KEYS = ["fmin", "fmax", "count", "backend", "symmetry"];

/**
 * Mirror of actions.variantLabel so the preview shows the names the bridge
 * will actually create. Drift here is only cosmetic (the server always wins),
 * but a preview that renames everything on submit is worse than no preview.
 */
export function variantLabel(variant, index, kind) {
  if (variant.name && variant.name.trim()) return variant.name.trim();
  const bits = [];
  if (kind === "solve") {
    for (const key of SOLVE_OPTION_KEYS)
      if (variant.settings?.[key] !== undefined) bits.push(`${key}=${variant.settings[key]}`);
  } else {
    for (const [key, value] of Object.entries(variant.params || {}).slice(0, 3))
      bits.push(`${key}=${fmtVal(value)}`);
  }
  if (variant.targetId) bits.push(variant.targetId === "local" ? "local" : `@${variant.targetId}`);
  return bits.length ? bits.join(" ") : `#${index + 1}`;
}

/** Mirror of actions.createBatch's naming, for the preview table. */
export function previewJobs({ kind, batchName, meshes, generatorId, variants, defaultTargetId }) {
  const sources = kind === "solve" ? meshes : [null];
  const rows = [];
  sources.forEach((mesh) => {
    variants.forEach((variant, i) => {
      const label = variantLabel(variant, i, kind);
      const stem = batchName?.trim() || (mesh ? `solve ${mesh.name}` : `${generatorId} mesh`);
      const name =
        variants.length === 1 && sources.length === 1
          ? stem
          : mesh && sources.length > 1
            ? `${stem} · ${mesh.name} · ${label}`
            : `${stem} · ${label}`;
      rows.push({
        key: `${mesh ? mesh.id : "mesh"}::${i}`,
        name,
        mesh,
        variantLabel: label,
        targetId: variant.targetId || defaultTargetId,
        settings: variant.settings || {},
        params: variant.params || {},
      });
    });
  });
  return rows;
}

/** "fmin=300 count=48" — the delta a variant applies, for the preview column. */
export function settingsSummary(settings) {
  const bits = SOLVE_OPTION_KEYS.filter((k) => settings?.[k] !== undefined).map(
    (k) => `${k}=${settings[k]}`,
  );
  return bits.length ? bits.join(" ") : "—";
}

export function paramsSummary(params) {
  const bits = Object.entries(params || {}).map(([k, v]) => `${k}=${fmtVal(v)}`);
  return bits.length ? bits.join(" ") : "—";
}

/** Parse "throat_diameter=25.4, length=120" into a typed params object. */
export function parseParamPairs(text, schema) {
  const props = (schema && schema.properties) || {};
  const out = {};
  const trimmed = String(text || "").trim();
  if (!trimmed) return { params: out, error: null };
  for (const piece of trimmed.split(/[,\n]/)) {
    const part = piece.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 1) return { params: out, error: `“${part}” is not key=value` };
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    const prop = props[key];
    if (!prop) return { params: out, error: `unknown parameter “${key}”` };
    if (prop.type === "number" || prop.type === "integer") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { params: out, error: `${key}: “${raw}” is not a number` };
      out[key] = n;
    } else if (prop.type === "boolean") {
      if (!/^(true|false)$/i.test(raw))
        return { params: out, error: `${key}: expected true or false` };
      out[key] = /^true$/i.test(raw);
    } else {
      out[key] = raw;
    }
  }
  return { params: out, error: null };
}

export const formatParamPairs = (params) =>
  Object.entries(params || {})
    .map(([k, v]) => `${k}=${fmtVal(v)}`)
    .join(", ");

/** Coerce one sweep value to the type its field expects. */
export function coerceSweepValue(field, raw, schema) {
  const text = raw.trim();
  if (field === "count") {
    const n = Number(text);
    return Number.isInteger(n) ? n : null;
  }
  if (field === "fmin" || field === "fmax") {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (field === "backend" || field === "symmetry" || field === "target") return text || null;
  const prop = ((schema && schema.properties) || {})[field];
  if (!prop) return null;
  if (prop.type === "number" || prop.type === "integer") {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (prop.type === "boolean") return /^true$/i.test(text) ? true : /^false$/i.test(text) ? false : null;
  return text || null;
}
