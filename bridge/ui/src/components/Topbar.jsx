import { cn } from "../lib/cn";
import { fmtRate } from "../lib/format";
import "./ui/controls.css";
import "./compute/compute.css";

/* Two views, and they answer different questions: Designs is WHAT is being
   built, Schedule is WHEN and WHERE it runs. There is no flat job list (Designs
   already holds every job, grouped the way the work is grouped) and no hardware
   view (the schedule board IS the machines, one column each). */
const VIEWS = [
  ["designs", "Designs"],
  ["schedule", "Schedule"],
];

export function Topbar({ connected, view, onView, onOpenMachines, burn = 0, running = 0, queued = 0 }) {
  return (
    <header className="topbar sticky top-0 z-2 flex h-12 items-center gap-3 border-b border-border bg-card px-4">
      <span
        className={cn("size-2 shrink-0 rounded-full bg-muted-foreground", connected && "bg-success")}
        title={connected ? "connected" : "disconnected"}
      />
      <h1 className="topbar-title text-[13px] font-medium">Boundary Lab</h1>
      <div className="segmented" role="tablist" aria-label="View">
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            id={`view-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={view === id}
            aria-controls={`view-${id}`}
            tabIndex={view === id ? 0 : -1}
            data-view-tab={id}
            className={cn("segmented-item", view === id && "segmented-item--active")}
            onClick={() => onView(id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = id === VIEWS[0][0] ? VIEWS[1][0] : VIEWS[0][0];
              onView(next);
              requestAnimationFrame(() =>
                document.querySelector(`[data-view-tab='${next}']`)?.focus(),
              );
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="topbar-status ml-auto flex items-center gap-2 text-[12px] text-muted-foreground">
        {(running > 0 || queued > 0) && (
          <span className="topbar-summary num">
            {running} running · {queued} queued
          </span>
        )}
        {/* Money that is being spent right now is never more than one glance
            away, on every view. */}
        {burn > 0 && (
          <button
            type="button"
            className="burn-pill"
            onClick={onOpenMachines}
            title="Rented instances are billing — open Machines to stop or destroy one"
          >
            {fmtRate(burn)}
          </button>
        )}
      </span>
    </header>
  );
}
