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
  // Callers pass `onClose` as an inline closure, and the dashboard re-renders
  // on every SSE tick. Depending on its identity would tear down and re-run
  // this effect mid-typing — moving focus back to the first field several
  // times a minute — so hold it in a ref and set up exactly once per modal.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
        // A plot/mesh preview is a child surface above this dialog. Let the
        // lightbox own the first Escape instead of closing its parent out from
        // under it.
        if (document.querySelector(".lightbox-overlay")) return;
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && panel) {
        const focusables = [
          ...panel.querySelectorAll(
            "a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), " +
              "select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
          ),
        ].filter((element) => element.getClientRects().length > 0);
        if (!focusables.length) {
          e.preventDefault();
          panel.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first || !panel.contains(document.activeElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
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
    // Deliberately empty: this is modal-lifetime setup, not per-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
