import { useId } from "react";
import { cn } from "../../lib/cn";
import "./controls.css";

/** Label + control + hint/error. Every control in the app goes through here. */
export function Field({ label, hint, error, children, className }) {
  return (
    <label className={cn("field", className)}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? (
        <span className="field-error">{error}</span>
      ) : (
        hint && <span className="field-hint">{hint}</span>
      )}
    </label>
  );
}

export function TextInput({ className, invalid, ...props }) {
  return <input className={cn("input", invalid && "input--invalid", className)} {...props} />;
}

/**
 * A number input that keeps the raw string while typing (so "1." and "" are
 * editable states) and reports `undefined` for empty — "unset" is meaningful
 * here: an omitted fmin means "let the solver default it", not zero.
 */
export function NumberInput({ value, onValue, className, invalid, ...props }) {
  return (
    <input
      type="number"
      className={cn("input", invalid && "input--invalid", className)}
      value={value === undefined || value === null ? "" : value}
      onChange={(e) => {
        const raw = e.target.value;
        onValue(raw === "" ? undefined : Number.isNaN(Number(raw)) ? raw : Number(raw));
      }}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }) {
  return (
    <select className={cn("select", className)} {...props}>
      {children}
    </select>
  );
}

export function Checkbox({ label, ...props }) {
  const id = useId();
  return (
    <span className="checkbox-row">
      <input id={id} type="checkbox" {...props} />
      <label htmlFor={id} style={{ cursor: "pointer" }}>
        {label}
      </label>
    </span>
  );
}
