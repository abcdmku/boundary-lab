import { useMemo, useState } from "react";
import { Field, NumberInput, Select, TextInput } from "../ui/field.jsx";
import { fmtVal } from "../../lib/format";

/**
 * Generator params, driven entirely by the generator's own JSON Schema
 * (`generator.params.properties`) — no per-generator UI code, so a new
 * generator in the python layer shows up here complete.
 *
 * Values are SPARSE on purpose: a blank box means "not set", and blabctl
 * applies the schema default for every key the params file omits. That keeps a
 * draft honest about what the user actually chose, and keeps a job's stored
 * params from freezing today's defaults.
 */

export const schemaProps = (schema) => (schema && schema.properties) || {};

/** Field-level validation against the schema's own bounds. */
export function validateParams(schema, values) {
  const props = schemaProps(schema);
  const errors = {};
  for (const [name, prop] of Object.entries(props)) {
    const v = values[name];
    if (v === undefined || v === "") continue;
    if (prop.type === "number" || prop.type === "integer") {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errors[name] = "must be a number";
        continue;
      }
      if (prop.type === "integer" && !Number.isInteger(v)) errors[name] = "must be a whole number";
      else if (prop.minimum !== undefined && v < prop.minimum) errors[name] = `min ${prop.minimum}`;
      else if (prop.maximum !== undefined && v > prop.maximum) errors[name] = `max ${prop.maximum}`;
    }
  }
  const required = (schema && schema.required) || [];
  for (const name of required)
    if (values[name] === undefined || values[name] === "") errors[name] = "required";
  return errors;
}

function propLabel(prop, name) {
  const unit = prop.unit || prop["x-unit"];
  return unit ? `${name} (${unit})` : name;
}

function defaultHint(prop) {
  return prop.default === undefined || prop.default === null
    ? undefined
    : `default ${fmtVal(prop.default)}`;
}

function SchemaField({ name, prop, value, onValue, error, disabled }) {
  const hint = error ? undefined : defaultHint(prop);
  const common = { disabled, invalid: !!error };

  if (Array.isArray(prop.enum)) {
    return (
      <Field label={propLabel(prop, name)} hint={hint} error={error}>
        <Select
          value={value ?? ""}
          onChange={(e) => onValue(e.target.value === "" ? undefined : e.target.value)}
          disabled={disabled}
          title={prop.description}
        >
          <option value="">{defaultHint(prop) ?? "unset"}</option>
          {prop.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (prop.type === "boolean") {
    return (
      <Field label={propLabel(prop, name)} hint={hint} error={error}>
        <Select
          value={value === undefined ? "" : value ? "true" : "false"}
          onChange={(e) => onValue(e.target.value === "" ? undefined : e.target.value === "true")}
          disabled={disabled}
          title={prop.description}
        >
          <option value="">{defaultHint(prop) ?? "unset"}</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      </Field>
    );
  }

  if (prop.type === "number" || prop.type === "integer") {
    return (
      <Field label={propLabel(prop, name)} hint={hint} error={error}>
        <NumberInput
          value={value}
          onValue={onValue}
          placeholder={prop.default === undefined ? "" : String(prop.default)}
          min={prop.minimum}
          max={prop.maximum}
          step={prop.type === "integer" ? 1 : "any"}
          title={prop.description}
          {...common}
        />
      </Field>
    );
  }

  return (
    <Field label={propLabel(prop, name)} hint={hint} error={error}>
      <TextInput
        value={value ?? ""}
        onChange={(e) => onValue(e.target.value === "" ? undefined : e.target.value)}
        placeholder={prop.default === undefined || prop.default === null ? "" : String(prop.default)}
        title={prop.description}
        {...common}
      />
    </Field>
  );
}

export function SchemaForm({ schema, values, onChange, errors = {}, disabled }) {
  const props = schemaProps(schema);
  const names = useMemo(() => Object.keys(props), [props]);
  const [query, setQuery] = useState("");

  if (!names.length)
    return <div className="panel-note">This generator declares no parameters.</div>;

  const q = query.trim().toLowerCase();
  const shown = q
    ? names.filter(
        (n) =>
          n.toLowerCase().includes(q) ||
          String(props[n].description || "")
            .toLowerCase()
            .includes(q),
      )
    : names;
  const setCount = names.filter((n) => values[n] !== undefined).length;

  return (
    <div>
      {names.length > 10 && (
        <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter ${names.length} parameters…`}
            aria-label="Filter parameters"
          />
          <span className="panel-note" style={{ whiteSpace: "nowrap" }}>
            {setCount} set
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onChange({})}
            disabled={disabled || setCount === 0}
            title="Clear every override and fall back to the generator's defaults"
          >
            Reset
          </button>
        </div>
      )}
      {shown.length === 0 ? (
        <div className="panel-note">No parameter matches “{query}”.</div>
      ) : (
        <div className="field-row field-row--3">
          {shown.map((name) => (
            <SchemaField
              key={name}
              name={name}
              prop={props[name]}
              value={values[name]}
              error={errors[name]}
              disabled={disabled}
              onValue={(v) => {
                const next = { ...values };
                if (v === undefined) delete next[name];
                else next[name] = v;
                onChange(next);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Read-only params list for a launched job — only the keys actually stored. */
export function ParamsReadout({ params }) {
  const entries = Object.entries(params || {});
  if (!entries.length) return <div className="panel-note">No parameters set (generator defaults).</div>;
  return (
    <dl className="kv">
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{fmtVal(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
