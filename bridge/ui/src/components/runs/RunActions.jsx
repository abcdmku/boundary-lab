import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

// Row actions stay invisible until the row is hovered (or focused, for
// keyboard users). Ghost styling throughout — red appears only once the
// delete is armed ("Confirm delete").
export function RunActions({ run, api, refetch }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const cancel = async (e) => {
    e.stopPropagation();
    await api(`/api/runs/${run.id}/cancel`, { method: "POST" });
    refetch();
  };

  const del = async (e) => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
      return;
    }
    clearTimeout(timerRef.current);
    setConfirming(false);
    await api(`/api/runs/${run.id}`, { method: "DELETE" });
    refetch();
  };

  return (
    <div className={cn("run-actions", confirming && "run-actions--armed")}>
      {(run.status === "running" || run.status === "queued") && (
        <button type="button" className="run-action-btn" onClick={cancel}>
          Cancel
        </button>
      )}
      {(run.status === "failed" || run.status === "done") && (
        <button
          type="button"
          className={cn("run-action-btn", confirming && "run-action-btn--danger")}
          onClick={del}
        >
          {confirming ? "Confirm delete" : "Delete"}
        </button>
      )}
    </div>
  );
}
