import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { relTime } from "../../lib/format";

const ORDER = ["running", "queued", "draft", "done", "failed", "cancelled"];
const CHIP_MOD = { running: "count-chip--running", done: "count-chip--done", failed: "count-chip--failed" };

/**
 * One batch, as a collapsible group with whole-batch controls.
 *
 * A sweep is the unit a user thinks in ("launch the 12 I just built"), so the
 * batch endpoints are wired straight to this header — one request instead of
 * twelve, and the counts make the state of the whole sweep readable at a
 * glance without expanding it.
 */
export function BatchGroup({ batch, children, open, onToggle, api, refetch, notify, onSelectAll }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(null);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const counts = batch.counts || {};
  const drafts = counts.draft || 0;
  const active = (counts.queued || 0) + (counts.running || 0);
  const total = batch.total || 0;

  const call = (label, path, opts) => async (e) => {
    e.stopPropagation();
    setBusy(label);
    try {
      const res = await api(path, opts);
      refetch();
      const skipped = res?.skipped || [];
      if (skipped.length) notify?.(`${skipped.length} job(s) skipped: ${skipped[0].reason}`);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
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
    await call("delete", `/api/batches/${batch.batchId}`, { method: "DELETE" })(e);
  };

  const seg = (status) => (total ? (100 * (counts[status] || 0)) / total : 0);

  return (
    <div className="batch-group">
      <div
        className="batch-head"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <ChevronRight
          size={14}
          aria-hidden
          className={cn("batch-chevron", open && "batch-chevron--open")}
        />
        <span className="batch-name">{batch.batchName || "Batch"}</span>
        <span className="batch-id">{batch.batchId}</span>
        <span className="batch-id">{relTime(batch.createdAt)}</span>
        <span className="batch-counts">
          {ORDER.filter((s) => counts[s]).map((s) => (
            <span key={s} className={cn("count-chip", CHIP_MOD[s])} title={`${counts[s]} ${s}`}>
              {counts[s]} {s}
            </span>
          ))}
          <span className={cn("batch-actions", confirming && "batch-actions--armed")}>
            {onSelectAll && (
              <button
                type="button"
                className="job-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectAll(batch.jobIds);
                }}
              >
                Select
              </button>
            )}
            {drafts > 0 && (
              <button
                type="button"
                className="job-action-btn"
                disabled={busy !== null}
                onClick={call("launch", `/api/batches/${batch.batchId}/launch`, { method: "POST" })}
              >
                {busy === "launch" ? "Launching…" : `Launch ${drafts}`}
              </button>
            )}
            {active > 0 && (
              <button
                type="button"
                className="job-action-btn"
                disabled={busy !== null}
                onClick={call("cancel", `/api/batches/${batch.batchId}/cancel`, { method: "POST" })}
              >
                Cancel {active}
              </button>
            )}
            <button
              type="button"
              className={cn("job-action-btn", confirming && "job-action-btn--danger")}
              onClick={del}
              disabled={busy !== null || active > 0}
              title={active > 0 ? "Cancel the active jobs first" : "Delete every job in this batch"}
            >
              {confirming ? "Confirm delete batch" : "Delete"}
            </button>
          </span>
        </span>
      </div>
      <div className="batch-bar" aria-hidden>
        <span className="batch-bar-seg batch-bar-seg--done" style={{ width: `${seg("done")}%` }} />
        <span className="batch-bar-seg batch-bar-seg--running" style={{ width: `${seg("running")}%` }} />
        <span className="batch-bar-seg batch-bar-seg--failed" style={{ width: `${seg("failed")}%` }} />
        <span className="batch-bar-seg batch-bar-seg--draft" style={{ width: `${seg("draft")}%` }} />
      </div>
      {open && <div className="batch-jobs">{children}</div>}
    </div>
  );
}
