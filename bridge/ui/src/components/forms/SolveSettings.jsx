import { Field, NumberInput, Select } from "../ui/field.jsx";

// Mirrors bridge/py/blabctl.py's `solve` argparse: the defaults shown as
// placeholders are the ones the CLI applies when a field is left blank, so an
// empty box is honest about what will happen rather than pretending to be 0.
export const SOLVE_DEFAULTS = { fmin: 200, fmax: 20000, count: 24, backend: "beat_cuda", symmetry: "off" };

export const BACKENDS = [
  ["beat_cuda", "beat_cuda — NVIDIA GPU"],
  ["beat_cpu", "beat_cpu — CPU"],
  ["beat_rocm", "beat_rocm — AMD GPU"],
  ["local", "local — in-process"],
];

export const SYMMETRIES = [
  ["off", "off — full mesh"],
  ["x", "x — one mirror plane"],
  ["xy", "xy — two mirror planes"],
];

/** Validate the frequency sweep. Returns a map of field -> message. */
export function validateSolveSettings(v) {
  const errors = {};
  const fmin = v.fmin ?? SOLVE_DEFAULTS.fmin;
  const fmax = v.fmax ?? SOLVE_DEFAULTS.fmax;
  const count = v.count ?? SOLVE_DEFAULTS.count;
  if (typeof fmin !== "number" || !(fmin > 0)) errors.fmin = "must be > 0";
  if (typeof fmax !== "number" || !(fmax > 0)) errors.fmax = "must be > 0";
  if (!errors.fmin && !errors.fmax && fmax <= fmin) errors.fmax = "must be above fmin";
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1)
    errors.count = "whole number ≥ 1";
  return errors;
}

/**
 * The five solve knobs. `value` is a sparse object — an absent key means "use
 * the solver default", which is exactly what the API stores, so this form
 * round-trips a job's params without inventing values.
 */
export function SolveSettings({ value, onChange, errors = {}, disabled, remote }) {
  const set = (key) => (v) => onChange({ ...value, [key]: v });

  return (
    <div className="field-stack">
      <div className="field-row field-row--3">
        <Field label="fmin (Hz)" error={errors.fmin}>
          <NumberInput
            value={value.fmin}
            onValue={set("fmin")}
            placeholder={String(SOLVE_DEFAULTS.fmin)}
            min={1}
            step={10}
            disabled={disabled}
            invalid={!!errors.fmin}
          />
        </Field>
        <Field label="fmax (Hz)" error={errors.fmax}>
          <NumberInput
            value={value.fmax}
            onValue={set("fmax")}
            placeholder={String(SOLVE_DEFAULTS.fmax)}
            min={1}
            step={100}
            disabled={disabled}
            invalid={!!errors.fmax}
          />
        </Field>
        <Field label="points" error={errors.count}>
          <NumberInput
            value={value.count}
            onValue={set("count")}
            placeholder={String(SOLVE_DEFAULTS.count)}
            min={1}
            step={1}
            disabled={disabled}
            invalid={!!errors.count}
          />
        </Field>
      </div>
      <div className="field-row field-row--2">
        <Field
          label="backend"
          hint={remote ? "ignored on a remote target — the box's own solver runs it" : undefined}
        >
          <Select
            value={value.backend ?? ""}
            onChange={(e) => set("backend")(e.target.value || undefined)}
            disabled={disabled || remote}
          >
            <option value="">default — {SOLVE_DEFAULTS.backend}</option>
            {BACKENDS.map(([id, text]) => (
              <option key={id} value={id}>
                {text}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="symmetry" hint="needs a mesh generated with matching mirror axes">
          <Select
            value={value.symmetry ?? ""}
            onChange={(e) => set("symmetry")(e.target.value || undefined)}
            disabled={disabled}
          >
            <option value="">default — off</option>
            {SYMMETRIES.map(([id, text]) => (
              <option key={id} value={id}>
                {text}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  );
}

/** Compact read-only rendering of the same settings, for a launched job. */
export function SolveSettingsReadout({ params }) {
  const p = params || {};
  const rows = [
    ["fmin", p.fmin ?? `${SOLVE_DEFAULTS.fmin} (default)`],
    ["fmax", p.fmax ?? `${SOLVE_DEFAULTS.fmax} (default)`],
    ["points", p.count ?? `${SOLVE_DEFAULTS.count} (default)`],
    ["backend", p.backend ?? `${SOLVE_DEFAULTS.backend} (default)`],
    ["symmetry", p.symmetry ?? "off (default)"],
  ];
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
