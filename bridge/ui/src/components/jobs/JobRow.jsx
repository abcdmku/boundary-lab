import { Badge } from "../ui/badge.jsx";
import { StatusDot } from "./StatusDot.jsx";
import { Essentials } from "./Essentials.jsx";
import { JobActions } from "./JobActions.jsx";
import { JobDetail } from "./JobDetail.jsx";
import { relTime } from "../../lib/format";
import { jobTargetId, jobTargetLabel } from "../../lib/targets";

export function JobRow({
  job,
  jobs,
  generators,
  targets,
  queueInfo,
  api,
  refetch,
  notify,
  onOpenLightbox,
  open,
  onToggle,
  onNavigate,
  onOpenSolve,
  selected,
  onSelect,
  showBatch,
}) {
  const showProgress =
    job.kind === "solve" && job.status === "running" && job.progress && job.progress.total;
  const targetId = jobTargetId(job);
  // Local is the default and the common case — only say where a job runs when
  // that is news: a remote box, or a draft whose target is still a choice.
  const showTarget = targetId !== "local" || (job.status === "draft" && job.kind === "solve");

  return (
    <div className="job-card" id={"job-" + job.id}>
      <div className="job-head" onClick={onToggle}>
        {onSelect && (
          <span className="job-select-slot" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={!!selected}
              onChange={(e) => onSelect(job.id, e.target.checked)}
              aria-label={`Select ${job.name || job.id}`}
            />
          </span>
        )}
        {/* fixed-height slot pins the dot to the first line */}
        <span className="job-dot-slot">
          <StatusDot status={job.status} />
        </span>
        <div className="job-main">
          <div className="job-title-row">
            <span className="job-name">{job.name || job.id}</span>
            <Badge>{job.kind}</Badge>
            {job.status === "draft" && <Badge>draft</Badge>}
            {showTarget && <Badge title={job.target?.serverUrl}>{jobTargetLabel(job, targets)}</Badge>}
            {showBatch && job.batchId && <Badge>{job.batchName || job.batchId}</Badge>}
            {job.kind === "mesh" && job.generator && <Badge>{job.generator}</Badge>}
            <span className="job-time">
              {queueInfo && job.status === "queued"
                ? `#${queueInfo.position} in ${queueInfo.label}`
                : relTime(job.createdAt)}
            </span>
          </div>
          <Essentials job={job} jobs={jobs} onNavigate={onNavigate} />
          {showProgress && (
            <div className="job-progress">
              <div
                className="job-progress-fill"
                style={{ width: `${(100 * (job.progress.done || 0)) / job.progress.total}%` }}
              />
            </div>
          )}
        </div>
        <JobActions
          job={job}
          api={api}
          refetch={refetch}
          notify={notify}
          onSolve={onOpenSolve}
          onConfigure={() => {
            if (!open) onToggle();
          }}
        />
      </div>
      {open && (
        <JobDetail
          job={job}
          jobs={jobs}
          generators={generators}
          targets={targets}
          api={api}
          refetch={refetch}
          onOpenLightbox={onOpenLightbox}
          onOpenSolve={onOpenSolve}
        />
      )}
    </div>
  );
}
