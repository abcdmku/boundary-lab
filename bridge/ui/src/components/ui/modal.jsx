import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import "./controls.css";

/**
 * The one dialog shell. Escape and a click on the backdrop close it; focus
 * moves into the panel on mount and returns to whatever opened it on unmount,
 * so every configuration flow is reachable from the keyboard alone.
 *
 * Deliberately not a <dialog>: the board behind it keeps updating over SSE and
 * the top-layer's inertness would hide those live status changes.
 */
export function Modal({ title, subtitle, onClose, children, footer, size = "md", labelledBy }) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    restoreRef.current = document.activeElement;
    // Prefer the first real control so a form opens ready to type. Buttons are
    // a fallback only — matching them in the same query would land focus on
    // the close button, which precedes the form in DOM order.
    const panel = panelRef.current;
    const focusable =
      panel?.querySelector(
        ".modal-body input:not([type=hidden]):not(:disabled), .modal-body select:not(:disabled), .modal-body textarea:not(:disabled)",
      ) ?? panel?.querySelector(".modal-body button:not(:disabled)");
    (focusable ?? panel)?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      const el = restoreRef.current;
      if (el && typeof el.focus === "function") el.focus();
    };
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          "modal-panel",
          size === "wide" && "modal-panel--wide",
          size === "xwide" && "modal-panel--xwide",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="min-w-0">
            <div className="modal-title">{title}</div>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
