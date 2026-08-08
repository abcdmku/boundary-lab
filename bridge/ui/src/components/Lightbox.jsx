import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import "./jobs/jobs.css";

// Full-screen overlay; the image sits in a small white frame so the
// white-background matplotlib plots read cleanly on the dark theme too.
export function Lightbox({ url, label, onClose }) {
  const closeRef = useRef(null);
  const restoreRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!url) return;
    restoreRef.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
  }, [url]);

  if (!url) return null;
  return (
    <div
      className="lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={label ? `Preview: ${label}` : "Artifact preview"}
      onClick={onClose}
    >
      <div className="lightbox-frame" onClick={(event) => event.stopPropagation()}>
        <button
          ref={closeRef}
          type="button"
          className="lightbox-close"
          onClick={onClose}
          aria-label="Close preview"
        >
          <X size={16} aria-hidden />
        </button>
        <img src={url} alt={label || "Artifact preview"} />
      </div>
    </div>
  );
}
