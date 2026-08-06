import { fmtInt, fmtScore } from "../../lib/format";
import { resolveMeshRun } from "../../lib/viewerAssets";
import { StatusDot } from "./StatusDot.jsx";

// A clickable pill linking to a related run (mesh ↔ solve). Stops propagation
// so it never toggles the row it lives on.
function RunChip({ label, status, onNavigate, targetId }) {
  return (
    <button
      type="button"
      className="run-chip"
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
export function Essentials({ run, runs, onNavigate }) {
  if (run.status === "failed" && run.error) {
    return <div className="run-meta run-meta--error">{run.error}</div>;
  }

  if (run.kind === "mesh") {
    const s = run.summary;
    const solves = (runs || []).filter((r) => r.parentRunId === run.id);
    const hasTris = s && s.triangles !== undefined;
    if (!hasTris && !solves.length) return null;
    return (
      <div className="run-meta">
        {hasTris && <span>{fmtInt(s.triangles)} tris</span>}
        {solves.length > 0 && (
          <>
            <span>
              used by {solves.length} solve{solves.length === 1 ? "" : "s"}
            </span>
            {solves.map((solve) => (
              <RunChip
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
  if (run.status === "running" && run.progress && run.progress.total !== undefined) {
    return (
      <div className="run-meta">
        {run.progress.done || 0}/{run.progress.total}
      </div>
    );
  }
  const p = run.params || {};
  const mesh = resolveMeshRun(run, runs);
  const tris = mesh && mesh.summary && mesh.summary.triangles;
  const score = run.summary && run.summary.score;
  const hasRange = p.fmin !== undefined && p.fmax !== undefined;
  const hasScore = typeof score === "number" && Number.isFinite(score);
  if (!hasRange && !mesh && !hasScore) return null;
  return (
    <div className="run-meta">
      {hasRange && (
        <span>
          {fmtInt(p.fmin)}–{fmtInt(p.fmax)} Hz
        </span>
      )}
      {hasScore && <span>score {fmtScore(score)}</span>}
      {mesh && (
        <RunChip
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
