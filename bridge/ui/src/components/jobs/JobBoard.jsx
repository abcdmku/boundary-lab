import { useState } from "react";
import { JobRow } from "./JobRow.jsx";
import "./jobs.css";

export function JobBoard({ jobs, api, refetch, onOpenLightbox }) {
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

  const focusJob = (id) => {
    setOpenIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    requestAnimationFrame(() => {
      const el = document.getElementById("job-" + id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <main className="job-board">
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Jobs
      </div>
      {!jobs.length ? (
        <div className="job-tab-empty">No jobs yet</div>
      ) : (
        jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            jobs={jobs}
            api={api}
            refetch={refetch}
            onOpenLightbox={onOpenLightbox}
            open={openIds.has(job.id)}
            onToggle={() => toggle(job.id)}
            onNavigate={focusJob}
          />
        ))
      )}
    </main>
  );
}
