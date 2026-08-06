import { fmtInt } from "../../lib/format";

// One glanceable line: tri count (mesh) or Hz range / live progress (solve).
// Failures surface their error here instead — still one line, nothing else.
export function Essentials({ run }) {
  if (run.status === "failed" && run.error) {
    return <div className="run-meta run-meta--error">{run.error}</div>;
  }
  if (run.kind === "mesh") {
    const s = run.summary;
    if (!s || s.triangles === undefined) return null;
    return <div className="run-meta">{fmtInt(s.triangles)} tris</div>;
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
  if (p.fmin !== undefined && p.fmax !== undefined) {
    return (
      <div className="run-meta">
        {fmtInt(p.fmin)}–{fmtInt(p.fmax)} Hz
      </div>
    );
  }
  return null;
}
