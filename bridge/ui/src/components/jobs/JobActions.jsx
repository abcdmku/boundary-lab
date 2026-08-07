import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

// Row actions stay invisible until the row is hovered (or focused, for
// keyboard users). Ghost styling throughout — red appears only once the
// delete is armed ("Confirm delete").
export function JobActions({ job, api, refetch }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const cancel = async (e) => {
    e.stopPropagation();
    await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    refetch();
  };

  // A draft is configured but not started — this is the only thing that
  // enqueues it. (Editing a draft is the job-editor stream's job.)
  const launch = async (e) => {
    e.stopPropagation();
    await api(`/api/jobs/${job.id}/launch`, { method: "POST" });
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
    await api(`/api/jobs/${job.id}`, { method: "DELETE" });
    refetch();
  };

  return (
    <div className={cn("job-actions", confirming && "job-actions--armed")}>
      {job.status === "draft" && (
        <button type="button" className="job-action-btn" onClick={launch}>
          Launch
        </button>
      )}
      {(job.status === "running" || job.status === "queued") && (
        <button type="button" className="job-action-btn" onClick={cancel}>
          Cancel
        </button>
      )}
      {(job.status === "failed" || job.status === "done" || job.status === "draft" ||
        job.status === "cancelled") && (
        <button
          type="button"
          className={cn("job-action-btn", confirming && "job-action-btn--danger")}
          onClick={del}
        >
          {confirming ? "Confirm delete" : "Delete"}
        </button>
      )}
    </div>
  );
}
