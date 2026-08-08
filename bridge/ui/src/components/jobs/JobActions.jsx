import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

// Row actions stay invisible until the row is hovered (or focused, for
// keyboard users). Ghost styling throughout — red appears only once the
// delete is armed ("Confirm delete").
export function JobActions({ job, api, refetch, notify, onSolve }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const run = (fn) => async (e) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await fn();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  const cancel = run(async () => {
    await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    refetch();
  });

  // Queued work can be put back on the shelf without destroying its config.
  // This is the non-destructive correction when it was launched too early or
  // aimed at the wrong machine.
  const hold = run(async () => {
    const res = await api("/api/jobs/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds: [job.id] }),
    });
    refetch();
    const skipped = res?.skipped?.[0];
    if (skipped) notify?.(skipped.reason);
  });

  const rescan = run(async () => {
    await api(`/api/jobs/${job.id}/rescan`, { method: "POST" });
    refetch();
  });

  const del = async (e) => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
      return;
    }
    clearTimeout(timerRef.current);
    setConfirming(false);
    setBusy(true);
    try {
      await api(`/api/jobs/${job.id}`, { method: "DELETE" });
      refetch();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  const terminal =
    job.status === "done" || job.status === "failed" || job.status === "cancelled";

  return (
    <div className={cn("job-actions", confirming && "job-actions--armed")}>
      {job.kind === "mesh" && job.status === "done" && (
        <button
          type="button"
          className="job-action-btn"
          onClick={(e) => {
            e.stopPropagation();
            onSolve?.(job);
          }}
          title="Configure a solve on this mesh"
        >
          Solve…
        </button>
      )}
      {job.status === "queued" && (
        <button
          type="button"
          className="job-action-btn"
          onClick={hold}
          disabled={busy}
          title="Return this queued job to Planned without losing its configuration"
        >
          Hold
        </button>
      )}
      {(job.status === "running" || job.status === "queued") && (
        <button type="button" className="job-action-btn" onClick={cancel} disabled={busy}>
          Cancel
        </button>
      )}
      {terminal && (
        <button
          type="button"
          className="job-action-btn"
          onClick={rescan}
          disabled={busy}
          title="Re-ingest this job's directory: new plots, metrics and scores written after it finished"
        >
          Rescan
        </button>
      )}
      {(terminal || job.status === "draft") && (
        <button
          type="button"
          className={cn("job-action-btn", confirming && "job-action-btn--danger")}
          onClick={del}
          disabled={busy}
        >
          {confirming ? "Confirm delete" : "Delete"}
        </button>
      )}
    </div>
  );
}
