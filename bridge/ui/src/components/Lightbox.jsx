import { useEffect } from "react";
import "./jobs/jobs.css";

// Full-screen overlay; the image sits in a small white frame so the
// white-background matplotlib plots read cleanly on the dark theme too.
export function Lightbox({ url, onClose }) {
  useEffect(() => {
    if (!url) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [url, onClose]);

  if (!url) return null;
  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-frame">
        <img src={url} alt="" />
      </div>
    </div>
  );
}
