import { Badge } from "../ui/badge.jsx";
import { StatusDot } from "./StatusDot.jsx";
import { Essentials } from "./Essentials.jsx";
import { JobActions } from "./JobActions.jsx";
import { JobDetail } from "./JobDetail.jsx";
import { relTime } from "../../lib/format";

export function JobRow({ job, jobs, api, refetch, onOpenLightbox, open, onToggle, onNavigate }) {
  const showProgress =
    job.kind === "solve" && job.status === "running" && job.progress && job.progress.total;

  return (
    <div className="job-card" id={"job-" + job.id}>
      <div className="job-head" onClick={onToggle}>
        {/* fixed-height slot pins the dot to the first line */}
        <span className="job-dot-slot">
          <StatusDot status={job.status} />
        </span>
        <div className="job-main">
          <div className="job-title-row">
            <span className="job-name">{job.name || job.id}</span>
            <Badge>{job.kind}</Badge>
            {job.status === "draft" && <Badge>draft</Badge>}
            {job.target && job.target.type === "remote" && (
              <Badge>{job.target.label || job.target.instanceId || "remote"}</Badge>
            )}
            {job.kind === "mesh" && job.generator && <Badge>{job.generator}</Badge>}
            <span className="job-time">{relTime(job.createdAt)}</span>
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
        <JobActions job={job} api={api} refetch={refetch} />
      </div>
      {open && <JobDetail job={job} jobs={jobs} onOpenLightbox={onOpenLightbox} />}
    </div>
  );
}
