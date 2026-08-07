import { Field, Select } from "../ui/field.jsx";
import { targetOptionLabel, targetSummary } from "../../lib/targets";

/**
 * WHERE a job runs. Unavailable targets are listed but disabled, and the
 * reason the registry gave is shown verbatim — a user must never be able to
 * aim a launch at a dead box without seeing why it is dead, and must never be
 * left guessing why an instance they can see is not selectable.
 */
export function TargetPicker({
  targets,
  value,
  onChange,
  label = "Run on",
  inheritLabel,
  disabled,
  hint,
}) {
  const list = targets || [];
  const selected = list.find((t) => t.id === value);
  // A stored target whose instance the registry no longer lists (destroyed and
  // forgotten, or pinned by bare URL) must still be representable.
  const unknownPinned = value && value !== "" && !selected;

  return (
    <div>
      <Field label={label}>
        <Select value={value ?? ""} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          {inheritLabel && <option value="">{inheritLabel}</option>}
          {unknownPinned && <option value={value}>{value} — not in the registry</option>}
          {list.map((t) => (
            <option key={t.id} value={t.id} disabled={!t.available}>
              {targetOptionLabel(t)}
            </option>
          ))}
        </Select>
      </Field>
      {selected ? (
        <div className="field-hint">{targetSummary(selected)}</div>
      ) : hint ? (
        <div className="field-hint">{hint}</div>
      ) : null}
      {selected && !selected.available && (
        <div className="notice notice--warn" style={{ marginTop: 6 }}>
          {selected.unavailableReason ||
            `${selected.label} is "${selected.status || "unavailable"}" and cannot take work yet.`}
        </div>
      )}
      {unknownPinned && (
        <div className="notice notice--warn" style={{ marginTop: 6 }}>
          This target is not in the compute registry right now. It will be re-resolved at launch and
          the launch will be refused if it is no longer usable.
        </div>
      )}
    </div>
  );
}
