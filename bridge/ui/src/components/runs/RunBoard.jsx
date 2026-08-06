import { useState } from "react";
import { RunRow } from "./RunRow.jsx";
import "./runs.css";

export function RunBoard({ runs, api, refetch, onOpenLightbox }) {
  // Expansion state lives here (not per-row) so link chips on one row can
  // open and scroll to another row.
  const [openIds, setOpenIds] = useState(() => new Set());

  const toggle = (id) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const focusRun = (id) => {
    setOpenIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    requestAnimationFrame(() => {
      const el = document.getElementById("run-" + id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <main className="run-board">
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Runs
      </div>
      {!runs.length ? (
        <div className="run-tab-empty">No runs yet</div>
      ) : (
        runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            runs={runs}
            api={api}
            refetch={refetch}
            onOpenLightbox={onOpenLightbox}
            open={openIds.has(run.id)}
            onToggle={() => toggle(run.id)}
            onNavigate={focusRun}
          />
        ))
      )}
    </main>
  );
}
