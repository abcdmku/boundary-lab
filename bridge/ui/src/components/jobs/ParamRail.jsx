import { useMemo, useState } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import { NumberInput, Select, TextInput } from "../ui/field.jsx";
import { schemaProps } from "../forms/SchemaForm.jsx";
import { cn } from "../../lib/cn";

/**
 * Dense parameter rail for the live mesh editor.
 *
 * SchemaForm is the right shape for a configuration dialog — generous fields,
 * three across, hints under everything — and the wrong shape here. This surface
 * exists to show a mesh; thirty parameters rendered as thirty cards push the
 * geometry off the screen, which is exactly backwards. So: one line each, label
 * and live slider and value on the same row, and the whole thing narrow enough
 * that the viewport keeps the rest of the window.
 *
 * It is a separate component rather than another flag on SchemaForm because the
 * two disagree about nearly everything — density, grouping, whether a slider is
 * even meaningful (it is not, on a form whose result you will not see until a
 * job finishes).
 */

/** Params that control mesh density rather than shape — grouped apart and collapsed. */
const RESOLUTION_RE = /segments|resolution|coarsen|element_size|mesh_size/i;

/** Prefix before the first underscore: plug_gap, plug_angle_deg → "plug". */
const prefixOf = (name) => (name.includes("_") ? name.slice(0, name.indexOf("_")) : name);

/**
 * Group parameters by the naming convention the generators already follow.
 *
 * A prefix shared by two or more parameters becomes a section (plug_*, mouth_*,
 * enclosure_*); one-offs collect into "shape" so a section is never a single
 * row with a heading over it. Schema order is preserved throughout, since that
 * is the order the generator author chose to explain the thing in.
 */
export function groupParams(props) {
  const names = Object.keys(props);
  const resolution = names.filter((n) => RESOLUTION_RE.test(n));
  const shaped = names.filter((n) => !RESOLUTION_RE.test(n));

  const counts = new Map();
  for (const name of shaped) counts.set(prefixOf(name), (counts.get(prefixOf(name)) ?? 0) + 1);

  const groups = [];
  const byKey = new Map();
  const push = (key, title, name, collapsed = false) => {
    let group = byKey.get(key);
    if (!group) {
      group = { key, title, names: [], collapsed };
      byKey.set(key, group);
      groups.push(group);
    }
    group.names.push(name);
  };

  for (const name of shaped) {
    const prefix = prefixOf(name);
    if (counts.get(prefix) > 1) push(prefix, prefix, name);
    else push("shape", "shape", name);
  }
  // Density lives at the bottom, shut: it is the section you touch last and
  // least, and it is a third of the parameter list on some generators.
  for (const name of resolution) push("resolution", "resolution", name, true);

  return groups;
}

/**
 * Step for a slider over [min, max]: a 1/2/5-ladder value near 1/200th of the
 * range, so dragging produces round numbers (0.5, 5, 25) rather than the
 * 137.428571 a raw range/200 would hand back.
 */
function niceStep(min, max, isInteger) {
  if (isInteger) return 1;
  const raw = Math.abs(max - min) / 200;
  if (!(raw > 0)) return "any";
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / magnitude;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * magnitude;
}

/** Strip a shared section prefix off the label: plug_tip_length → tip_length. */
function shortLabel(name, groupKey) {
  if (groupKey === "shape" || groupKey === "resolution") return name;
  return name === groupKey ? name : name.slice(groupKey.length + 1);
}

function ParamRow({ name, label, prop, value, onValue, error }) {
  const set = value !== undefined;
  const title = `${name}${prop.description ? ` — ${prop.description}` : ""}${
    prop.default === undefined ? "" : `\ndefault ${prop.default}`
  }`;

  let control;
  if (Array.isArray(prop.enum)) {
    control = (
      <Select
        className="prow-wide"
        value={value ?? ""}
        onChange={(e) => onValue(e.target.value === "" ? undefined : e.target.value)}
      >
        <option value="">{prop.default === undefined ? "unset" : String(prop.default)}</option>
        {prop.enum.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </Select>
    );
  } else if (prop.type === "boolean") {
    control = (
      <Select
        className="prow-wide"
        value={value === undefined ? "" : value ? "true" : "false"}
        onChange={(e) => onValue(e.target.value === "" ? undefined : e.target.value === "true")}
      >
        <option value="">{prop.default === undefined ? "unset" : String(prop.default)}</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    );
  } else if (prop.type === "number" || prop.type === "integer") {
    const bounded = prop.minimum !== undefined && prop.maximum !== undefined;
    const isInteger = prop.type === "integer";
    // The slider always has a position; an unset parameter sits at its default,
    // which is the value the generator would use anyway — drawn muted, so
    // "this is where the default lands" never reads as "you chose this".
    const position = bounded
      ? Math.min(
          prop.maximum,
          Math.max(prop.minimum, typeof value === "number" ? value : (prop.default ?? prop.minimum)),
        )
      : 0;
    control = (
      <>
        {bounded && (
          <input
            type="range"
            className={cn("prow-slider", !set && "prow-slider--unset")}
            // The filled part of the track is painted from this, since the
            // native progress fill is only stylable in one engine.
            style={{
              "--fill": `${((position - prop.minimum) / (prop.maximum - prop.minimum || 1)) * 100}%`,
            }}
            min={prop.minimum}
            max={prop.maximum}
            step={niceStep(prop.minimum, prop.maximum, isInteger)}
            value={position}
            aria-label={name}
            onChange={(e) => onValue(Number(e.target.value))}
          />
        )}
        <NumberInput
          className={cn("prow-num", !bounded && "prow-wide")}
          value={value}
          onValue={onValue}
          placeholder={prop.default === undefined ? "" : String(prop.default)}
          min={prop.minimum}
          max={prop.maximum}
          step={isInteger ? 1 : "any"}
          invalid={!!error}
          aria-label={name}
        />
      </>
    );
  } else {
    control = (
      <TextInput
        className="prow-wide"
        value={value ?? ""}
        onChange={(e) => onValue(e.target.value === "" ? undefined : e.target.value)}
        placeholder={prop.default === undefined || prop.default === null ? "" : String(prop.default)}
        invalid={!!error}
        aria-label={name}
      />
    );
  }

  return (
    <div className={cn("prow", error && "prow--invalid")} title={error ? `${title}\n${error}` : title}>
      <span className={cn("prow-label", set && "prow-label--set")}>{label}</span>
      {control}
    </div>
  );
}

export function ParamRail({ schema, values, onChange, errors = {} }) {
  const props = schemaProps(schema);
  const groups = useMemo(() => groupParams(props), [props]);
  const [collapsed, setCollapsed] = useState(() => new Set(groups.filter((g) => g.collapsed).map((g) => g.key)));
  const [query, setQuery] = useState("");

  const names = Object.keys(props);
  if (!names.length) return <div className="panel-note">This generator declares no parameters.</div>;

  const q = query.trim().toLowerCase();
  const matches = (name) =>
    !q ||
    name.toLowerCase().includes(q) ||
    String(props[name].description || "").toLowerCase().includes(q);

  const setValue = (name, v) => {
    const next = { ...values };
    if (v === undefined) delete next[name];
    else next[name] = v;
    onChange(next);
  };

  const setCount = names.filter((n) => values[n] !== undefined).length;
  const toggle = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const visible = groups
    .map((g) => ({ ...g, names: g.names.filter(matches) }))
    .filter((g) => g.names.length);

  return (
    <div className="prail">
      <div className="prail-tools">
        <TextInput
          className="prail-filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Filter ${names.length}…`}
          aria-label="Filter parameters"
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => onChange({})}
          disabled={setCount === 0}
          title="Clear every override and fall back to the generator's defaults"
        >
          <RotateCcw size={11} aria-hidden /> {setCount}
        </button>
      </div>

      {!visible.length && <div className="panel-note">No parameter matches “{query}”.</div>}

      {visible.map((group) => {
        // A search is a request to see the matches, not to go on opening
        // sections by hand.
        const shut = collapsed.has(group.key) && !q;
        return (
          <section key={group.key} className="pgroup">
            <button
              type="button"
              className="pgroup-head"
              onClick={() => toggle(group.key)}
              aria-expanded={!shut}
            >
              <ChevronRight size={11} className={cn("pgroup-chev", !shut && "pgroup-chev--open")} aria-hidden />
              {group.title}
              <span className="pgroup-count">{group.names.length}</span>
            </button>
            {!shut && (
              <div className="pgroup-body">
                {group.names.map((name) => (
                  <ParamRow
                    key={name}
                    name={name}
                    label={shortLabel(name, group.key)}
                    prop={props[name]}
                    value={values[name]}
                    error={errors[name]}
                    onValue={(v) => setValue(name, v)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
