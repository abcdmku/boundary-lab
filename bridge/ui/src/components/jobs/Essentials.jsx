import { fmtInt, fmtScore } from "../../lib/format";
import { resolveMeshJob } from "../../lib/viewerAssets";
import { StatusDot } from "./StatusDot.jsx";

// A clickable pill linking to a related job (mesh ↔ solve). Stops propagation
// so it never toggles the row it lives on.
function JobChip({ label, status, onNavigate, targetId }) {
  return (
    <button
      type="button"
      className="job-chip"
      onClick={(e) => {
        e.stopPropagation();
        if (onNavigate) onNavigate(targetId);
      }}
    >
      {status && <StatusDot status={status} />}
      {label}
    </button>
  );
}

// One glanceable line: tri count (mesh) or Hz range / live progress (solve),
// plus small link chips tying meshes and solves together and the solve score.
// Failures surface their error here instead — still one line, nothing else.
export function Essentials({ job, jobs, onNavigate }) {
  if (job.status === "failed" && job.error) {
    return <div className="job-meta job-meta--error">{job.error}</div>;
  }

  if (job.kind === "mesh") {
    const s = job.summary;
    const solves = (jobs || []).filter((r) => r.parentJobId === job.id);
    const hasTris = s && s.triangles !== undefined;
    if (!hasTris && !solves.length) return null;
    return (
      <div className="job-meta">
        {hasTris && <span>{fmtInt(s.triangles)} tris</span>}
        {solves.length > 0 && (
          <>
            <span>
              used by {solves.length} solve{solves.length === 1 ? "" : "s"}
            </span>
            {solves.map((solve) => (
              <JobChip
                key={solve.id}
                label={solve.name || solve.id}
                status={solve.status}
                targetId={solve.id}
                onNavigate={onNavigate}
              />
            ))}
          </>
        )}
      </div>
    );
  }

  // solve
  if (job.status === "running" && job.progress && job.progress.total !== undefined) {
    return (
      <div className="job-meta">
        {job.progress.done || 0}/{job.progress.total}
      </div>
    );
  }
  const p = job.params || {};
  const mesh = resolveMeshJob(job, jobs);
  const tris = mesh && mesh.summary && mesh.summary.triangles;
  const score = job.summary && job.summary.score;
  const hasRange = p.fmin !== undefined && p.fmax !== undefined;
  const hasScore = typeof score === "number" && Number.isFinite(score);
  if (!hasRange && !mesh && !hasScore) return null;
  return (
    <div className="job-meta">
      {hasRange && (
        <span>
          {fmtInt(p.fmin)}–{fmtInt(p.fmax)} Hz
        </span>
      )}
      {hasScore && <span>score {fmtScore(score)}</span>}
      {mesh && (
        <JobChip
          label={
            tris !== undefined
              ? `${mesh.name || mesh.id} · ${fmtInt(tris)} tris`
              : mesh.name || mesh.id
          }
          targetId={mesh.id}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}
