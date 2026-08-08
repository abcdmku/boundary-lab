import { useRef } from "react";
import { AlertTriangle, GripVertical } from "lucide-react";
import { StatusDot } from "../jobs/StatusDot.jsx";
import { cn } from "../../lib/cn";
import { fmtCompact, fmtShort } from "../../lib/format";
import { previewUrl, solveSpec, triangleCount } from "../../lib/board";

/**
 * One piece of work on the schedule board.
 *
 * Deliberately almost wordless. A card answers four questions and no others:
 * what geometry (the mesh thumbnail), which solve of it (the band, the point
 * count, the symmetry — as numerals), where it is in its life (the dot and the
 * progress bar), and how long (one duration). The job's full name is there for
 * the tooltip and the screen reader, not for the eye.
 *
 * Dragging is the primary interaction, so the whole card is the handle. Alt +
 * arrow keys do the same thing from the keyboard: a board you can only operate
 * with a mouse is a board half the time you cannot operate at all.
 */
export function JobCard({
  entry,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
  onOpen,
  compact = false,
  busy = false,
}) {
  const { job, mesh, estimate, forecast } = entry;
  const spec = solveSpec(job);
  const tris = triangleCount(mesh);
  const thumb = previewUrl(mesh);
  const running = job.status === "running";
  const percent =
    running && job.progress?.total
      ? Math.min(100, Math.round((100 * (job.progress.done || 0)) / job.progress.total))
      : null;

  // One duration per card, and it is whichever one the human is waiting on:
  // what is left of a running job, or how long a waiting job will take.
  const seconds = running
    ? (estimate?.remainingSeconds ?? null)
    : (forecast?.remainingSeconds ?? estimate?.totalSeconds ?? null);
  const startsIn = !running && forecast?.startsInSeconds ? forecast.startsInSeconds : null;
  const draggedRef = useRef(false);

  const label = [
    job.name || job.id,
    job.status,
    spec.count ? `${spec.count} points` : null,
    seconds !== null ? `about ${fmtShort(seconds)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  // A started job cannot move, so it must not look grabbable either — offering
  // the gesture and then refusing the drop teaches nothing.
  return (
    <li
      className={cn(
        "jc",
        compact && "jc--compact",
        running && "jc--running",
        job.status === "failed" && "jc--failed",
        dragging && "jc--dragging",
      )}
      draggable={!running && !busy}
      tabIndex={0}
      role="listitem"
      aria-label={label}
      aria-keyshortcuts={!running ? "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown" : undefined}
      title={job.name || job.id}
      onDragStart={(e) => {
        // A plain-text payload so a drop outside the board is inert rather
        // than mysterious, and so Firefox starts the drag at all.
        e.dataTransfer.setData("text/plain", job.id);
        e.dataTransfer.effectAllowed = "move";
        draggedRef.current = true;
        onDragStart?.(entry);
      }}
      onDragEnd={() => {
        onDragEnd?.();
        // Browsers may emit a click after dragend. Keep the drag marker alive
        // through that click so dropping a card never also opens its dialog.
        setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }}
      onClick={(event) => {
        if (event.target.closest("select") || draggedRef.current) return;
        onOpen?.(job.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(job.id);
          return;
        }
        if (!e.altKey || busy) return;
        const dir = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[
          e.key
        ];
        if (!dir) return;
        e.preventDefault();
        onMove?.(entry, dir);
      }}
    >
      <span className="jc-grip" aria-hidden>
        <GripVertical size={11} />
      </span>
      <span
        className={cn("jc-thumb", !thumb && "jc-thumb--blank")}
        style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}
        aria-hidden
      >
        {!thumb && (job.kind === "mesh" ? "△" : "◌")}
      </span>

      <span className="jc-main">
        <span className="jc-title">
          <StatusDot status={job.status} />
          <span className="jc-name">{job.name || job.id}</span>
        </span>
        <span className="jc-nums num">
          {job.kind === "mesh" ? (
            <>
              <b>{job.generator || "mesh"}</b>
              {tris !== null && <span>{fmtCompact(tris)}△</span>}
            </>
          ) : (
            <>
              {spec.fmin !== null && spec.fmax !== null && (
                <b>
                  {fmtCompact(spec.fmin)}–{fmtCompact(spec.fmax)}
                </b>
              )}
              {spec.count !== null && <span>{spec.count}pt</span>}
              {spec.symmetry && <span className="jc-sym">{spec.symmetry}</span>}
              {tris !== null && <span>{fmtCompact(tris)}△</span>}
            </>
          )}
        </span>
      </span>

      <span className="jc-time num">
        <span className={cn("jc-eta", estimate?.weak && "jc-eta--soft")}>
          {seconds !== null ? fmtShort(seconds) : "—"}
        </span>
        {startsIn !== null && <span className="jc-starts">in {fmtShort(startsIn)}</span>}
        {job.status === "failed" && (
          <span className="jc-warn" title={job.error}>
            <AlertTriangle size={11} aria-hidden />
          </span>
        )}
      </span>

      {!running && (
        <select
          className="jc-move"
          value=""
          disabled={busy}
          aria-label={`Move ${job.name || job.id}`}
          title="Move this job"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            const dir = event.target.value;
            if (dir) onMove?.(entry, dir);
          }}
        >
          <option value="">Move…</option>
          <option value="up">Earlier</option>
          <option value="down">Later</option>
          <option value="left">Previous column</option>
          <option value="right">Next column</option>
        </select>
      )}

      {percent !== null && (
        <span className="jc-bar" aria-hidden>
          <span className="jc-bar-fill" style={{ width: `${percent}%` }} />
        </span>
      )}
    </li>
  );
}
