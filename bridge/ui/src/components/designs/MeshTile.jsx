import { CornerDownRight, GitBranch, Play } from "lucide-react";
import { StatusDot } from "../jobs/StatusDot.jsx";
import { cn } from "../../lib/cn";
import { fmtCompact, fmtScore } from "../../lib/format";
import { scoreOf, solveSpec } from "../../lib/board";

/**
 * One geometry, and every answer computed from it.
 *
 * The old board listed a mesh and its solves as sibling rows, which said they
 * were the same kind of thing. They are not: a mesh is a shape, and its solves
 * are questions asked of that shape — a coarse look and a fine verification of
 * one geometry are two solves of one mesh, and that is the normal case, not an
 * edge case. So the solves live INSIDE the mesh tile, as a row of chips.
 *
 * A variant is drawn as an indent off its parent with only its parameter DELTA
 * named. Twenty trials of one design differ in one or two numbers; showing the
 * other eighteen on every tile would bury the only thing that varies.
 */
export function MeshTile({ node, onOpen, onSolve, onVariant, busy, actionsDisabled = false }) {
  const { mesh, depth, solves, delta, triangles, preview, bestScore } = node;
  const active = solves.filter((s) => s.status === "running" || s.status === "queued").length;

  return (
    <div
      className={cn("mt", depth > 0 && "mt--variant")}
      style={depth > 0 ? { marginLeft: Math.min(depth, 4) * 14 } : undefined}
    >
      {depth > 0 && (
        <span className="mt-branch" aria-hidden>
          <CornerDownRight size={11} />
        </span>
      )}

      <button
        type="button"
        className="mt-shot"
        onClick={() => onOpen?.(mesh.id)}
        aria-label={`Open ${mesh.name || mesh.id}`}
        style={preview ? { backgroundImage: `url(${preview})` } : undefined}
      >
        {!preview && <span className="mt-shot-blank">{mesh.status === "done" ? "△" : mesh.status}</span>}
      </button>

      <div className="mt-body">
        <div className="mt-title">
          <StatusDot status={mesh.status} />
          <button type="button" className="mt-name" onClick={() => onOpen?.(mesh.id)}>
            {mesh.name || mesh.id}
          </button>
          {triangles !== null && <span className="mt-tris num">{fmtCompact(triangles)}△</span>}
          {bestScore !== null && (
            <span className="mt-score num" title="Best score across this mesh's solves">
              ★{fmtScore(bestScore)}
            </span>
          )}
        </div>

        {delta.length > 0 && (
          <div className="mt-delta num" title="What differs from this lineage's root">
            {delta.slice(0, 4).map(([key, value]) => (
              <span key={key} className="mt-chip">
                {key} <b>{String(value)}</b>
              </span>
            ))}
            {delta.length > 4 && <span className="mt-chip mt-chip--more">+{delta.length - 4}</span>}
          </div>
        )}

        <div className="mt-solves">
          {solves.map((solve) => {
            const spec = solveSpec(solve);
            const score = scoreOf(solve);
            return (
              <button
                key={solve.id}
                type="button"
                className={cn("sv", `sv--${solve.status}`)}
                onClick={() => onOpen?.(solve.id)}
                title={`${solve.name || solve.id} — ${solve.status}${solve.error ? `: ${solve.error}` : ""}`}
              >
                <StatusDot status={solve.status} />
                <span className="num">
                  {spec.count !== null ? `${spec.count}pt` : "solve"}
                  {spec.symmetry ? ` ${spec.symmetry}` : ""}
                </span>
                {score !== null && <b className="num">{fmtScore(score)}</b>}
              </button>
            );
          })}
          <button
            type="button"
            className="sv sv--add"
            disabled={mesh.status !== "done" || busy || actionsDisabled}
            onClick={() => onSolve?.(mesh)}
            title={
              actionsDisabled
                ? "Restore this design before adding work"
                : mesh.status === "done"
                ? "Solve this mesh again — a different band, resolution or symmetry"
                : "The mesh has to finish generating first"
            }
          >
            <Play size={10} aria-hidden /> solve
          </button>
          <button
            type="button"
            className="sv sv--add"
            disabled={busy || actionsDisabled}
            onClick={() => onVariant?.(mesh)}
            title={
              actionsDisabled
                ? "Restore this design before adding work"
                : "Derive a new mesh from this one — same design, different parameters"
            }
          >
            <GitBranch size={10} aria-hidden /> variant
          </button>
        </div>
      </div>

      {active > 0 && (
        <span className="mt-active num" title={`${active} solve(s) queued or running`}>
          {active}
        </span>
      )}
    </div>
  );
}
