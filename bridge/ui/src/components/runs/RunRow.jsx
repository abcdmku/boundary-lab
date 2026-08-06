import { Badge } from "../ui/badge.jsx";
import { StatusDot } from "./StatusDot.jsx";
import { Essentials } from "./Essentials.jsx";
import { RunActions } from "./RunActions.jsx";
import { RunDetail } from "./RunDetail.jsx";
import { relTime } from "../../lib/format";

export function RunRow({ run, runs, api, refetch, onOpenLightbox, open, onToggle, onNavigate }) {
  const showProgress =
    run.kind === "solve" && run.status === "running" && run.progress && run.progress.total;

  return (
    <div className="run-card" id={"run-" + run.id}>
      <div className="run-head" onClick={onToggle}>
        {/* fixed-height slot pins the dot to the first line */}
        <span className="run-dot-slot">
          <StatusDot status={run.status} />
        </span>
        <div className="run-main">
          <div className="run-title-row">
            <span className="run-name">{run.name || run.id}</span>
            <Badge>{run.kind}</Badge>
            {run.kind === "mesh" && run.generator && <Badge>{run.generator}</Badge>}
            <span className="run-time">{relTime(run.createdAt)}</span>
          </div>
          <Essentials run={run} runs={runs} onNavigate={onNavigate} />
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
