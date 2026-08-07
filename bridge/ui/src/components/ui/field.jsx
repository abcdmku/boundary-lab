import { useEffect, useId, useState } from "react";
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

const numberText = (v) => (v === undefined || v === null ? "" : String(v));

/**
 * A number input that really does keep the raw string while it is being
 * edited. The parent stores a NUMBER, so echoing that number straight back
 * into the field destroys transitional states: typing "25." round-trips
 * through Number() as 25 and the decimal point disappears before the user can
 * type "4". Local text is therefore authoritative while focused, and the
 * parent's value re-seeds it on blur (or when it changes from elsewhere).
 *
 * Empty reports `undefined`, not 0 — "unset" is meaningful here: an omitted
 * fmin means "let the solver default it".
 */
export function NumberInput({ value, onValue, className, invalid, onFocus, onBlur, ...props }) {
  const [text, setText] = useState(() => numberText(value));
  const [editing, setEditing] = useState(false);

  // Adopt the parent's value whenever we are not the one driving it (a Reset
  // button, a re-seeded draft form, a variant rewritten by the sweep helper).
  useEffect(() => {
    if (!editing) setText(numberText(value));
  }, [value, editing]);

  return (
    <input
      type="number"
      className={cn("input", invalid && "input--invalid", className)}
      value={text}
      onFocus={(e) => {
        setEditing(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setEditing(false);
        setText(numberText(value));
        onBlur?.(e);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        // A raw string that is not a finite number is passed through so the
        // form's own validation can report it, rather than silently becoming
        // NaN or being swallowed.
        onValue(raw === "" ? undefined : Number.isFinite(Number(raw)) ? Number(raw) : raw);
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
