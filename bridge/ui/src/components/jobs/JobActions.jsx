import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

// Row actions stay invisible until the row is hovered (or focused, for
// keyboard users). Ghost styling throughout — red appears only once the
// delete is armed ("Confirm delete").
export function JobActions({ job, api, refetch, notify, onConfigure, onSolve }) {
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

  // A draft is configured but not started — this is the only thing that
  // enqueues it. `launchJobs` reports refusals in `skipped` rather than
  // throwing, so an unlaunchable draft must be surfaced explicitly.
  const launch = run(async () => {
    const res = await api(`/api/jobs/${job.id}/launch`, { method: "POST" });
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
      {job.status === "draft" && (
        <>
          <button
            type="button"
            className="job-action-btn"
            onClick={(e) => {
              e.stopPropagation();
              onConfigure?.(job);
            }}
          >
            Configure
          </button>
          <button type="button" className="job-action-btn" onClick={launch} disabled={busy}>
            Launch
          </button>
        </>
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
