import { Modal } from "../ui/modal.jsx";
import { Badge } from "../ui/badge.jsx";
import { StatusDot } from "./StatusDot.jsx";
import { JobDetail } from "./JobDetail.jsx";
import { JobActions } from "./JobActions.jsx";
import { Essentials } from "./Essentials.jsx";
import { relTime } from "../../lib/format";
import { jobTargetId, jobTargetLabel } from "../../lib/targets";
import "./jobs.css";

/**
 * One job, in full: its configuration, its geometry, its plots, its log.
 *
 * This used to be an expanding row on a flat job board. The board is gone —
 * the designs view already lists every mesh and every solve, in the structure
 * they actually have, so a second flat list of the same records was two places
 * to look for one thing. What that board really provided was this panel, so
 * this panel is what survived: opened from a mesh tile, a solve chip, or a
 * card on the schedule board.
 */
export function JobDialog({
  job,
  jobs,
  projectName,
  generators,
  targets,
  api,
  refetch,
  notify,
  onOpenLightbox,
  onOpenSolve,
  onNavigate,
  onClose,
}) {
  if (!job) return null;
  const targetId = jobTargetId(job);
  const showTarget = targetId !== "local" || (job.status === "draft" && job.kind === "solve");

  return (
    <Modal
      /* A plain string, not a node: Modal uses it as the dialog's aria-label. */
      title={job.name || job.id}
      subtitle={
        <span className="job-dialog-sub">
          <StatusDot status={job.status} />
          <Badge>{job.kind}</Badge>
          {projectName && <Badge title="Design this job belongs to">{projectName}</Badge>}
          {job.variantOf && <Badge title={`Variant of mesh ${job.variantOf}`}>variant</Badge>}
          {job.status === "draft" && <Badge>draft</Badge>}
          {showTarget && <Badge title={job.target?.serverUrl}>{jobTargetLabel(job, targets)}</Badge>}
          {job.generator && <Badge>{job.generator}</Badge>}
          <span className="job-time">{relTime(job.createdAt)}</span>
        </span>
      }
      onClose={onClose}
      size="xwide"
      footer={
        <>
          {/* Row actions were hover-revealed on the old board; in a dialog the
              job is unambiguous, so they are simply present. */}
          <JobActions
            job={job}
            api={api}
            refetch={refetch}
            notify={notify}
            onSolve={onOpenSolve}
          />
          <span className="modal-foot-spacer" />
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="job-dialog">
        <Essentials job={job} jobs={jobs} onNavigate={onNavigate} />
        <JobDetail
          job={job}
          jobs={jobs}
          generators={generators}
          targets={targets}
          api={api}
          refetch={refetch}
          notify={notify}
          onOpenLightbox={onOpenLightbox}
          onOpenSolve={onOpenSolve}
        />
      </div>
    </Modal>
  );
}
