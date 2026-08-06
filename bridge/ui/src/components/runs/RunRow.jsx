import { useState } from "react";
import { Badge } from "../ui/badge.jsx";
import { StatusDot } from "./StatusDot.jsx";
import { Essentials } from "./Essentials.jsx";
import { RunActions } from "./RunActions.jsx";
import { RunDetail } from "./RunDetail.jsx";
import { relTime } from "../../lib/format";

export function RunRow({ run, runs, api, refetch, onOpenLightbox }) {
  const [open, setOpen] = useState(false);
  const showProgress =
    run.kind === "solve" && run.status === "running" && run.progress && run.progress.total;

  return (
    <div className="run-card">
      <div className="run-head" onClick={() => setOpen((v) => !v)}>
        {/* fixed-height slot pins the dot to the first line */}
        <span className="run-dot-slot">
          <StatusDot status={run.status} />
        </span>
        <div className="run-main">
          <div className="run-title-row">
            <span className="run-name">{run.name || run.id}</span>
            <Badge>{run.kind}</Badge>
            <span className="run-time">{relTime(run.createdAt)}</span>
          </div>
          <Essentials run={run} />
          {showProgress && (
            <div className="run-progress">
              <div
                className="run-progress-fill"
                style={{ width: `${(100 * (run.progress.done || 0)) / run.progress.total}%` }}
              />
            </div>
          )}
        </div>
        <RunActions run={run} api={api} refetch={refetch} />
      </div>
      {open && <RunDetail run={run} runs={runs} onOpenLightbox={onOpenLightbox} />}
    </div>
  );
}
