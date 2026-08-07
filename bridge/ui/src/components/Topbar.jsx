import { cn } from "../lib/cn";
import { fmtRate } from "../lib/format";
import "./ui/controls.css";
import "./compute/compute.css";

const VIEWS = [
  ["jobs", "Jobs"],
  ["compute", "Compute"],
];

export function Topbar({ connected, view, onView, burn = 0, running = 0, queued = 0 }) {
  return (
    <header className="sticky top-0 z-2 flex h-12 items-center gap-3 border-b border-border bg-card px-4">
      <span
        className={cn("size-2 shrink-0 rounded-full bg-muted-foreground", connected && "bg-success")}
        title={connected ? "connected" : "disconnected"}
      />
      <h1 className="text-[13px] font-medium">Boundary Lab</h1>
      <div className="segmented" role="tablist" aria-label="View">
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            className={cn("segmented-item", view === id && "segmented-item--active")}
            onClick={() => onView(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="ml-auto flex items-center gap-2 text-[12px] text-muted-foreground">
        {(running > 0 || queued > 0) && (
          <span className="num">
            {running} running · {queued} queued
          </span>
        )}
        {/* Money that is being spent right now is never more than one glance
            away, on every view. */}
        {burn > 0 && (
          <button
            type="button"
            className="burn-pill"
            onClick={() => onView("compute")}
            title="Rented vast.ai instances are billing — open the compute view"
          >
            {fmtRate(burn)}
          </button>
        )}
      </span>
    </header>
  );
}
