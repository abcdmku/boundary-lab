import { useState } from "react";
import { cn } from "../../lib/cn";
import { MeshTab } from "./MeshTab.jsx";
import { PlotsTab } from "./PlotsTab.jsx";
import { JobFooter } from "./JobFooter.jsx";

const TABS = ["Mesh", "Plots"];

export function JobDetail({ job, jobs, onOpenLightbox }) {
  // Solve jobs open on their plots; mesh jobs open on the geometry.
  const [tab, setTab] = useState(job.kind === "mesh" ? "Mesh" : "Plots");

  return (
    <div className="job-detail" onClick={(e) => e.stopPropagation()}>
      <div className="job-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            aria-selected={tab === t}
            onClick={(e) => {
              e.stopPropagation();
              setTab(t);
            }}
            className={cn("job-tab", tab === t && "job-tab--active")}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="job-tab-panel">
        {tab === "Mesh" ? (
          <MeshTab job={job} jobs={jobs} onOpenLightbox={onOpenLightbox} />
        ) : (
          <PlotsTab job={job} onOpenLightbox={onOpenLightbox} />
        )}
      </div>
      <JobFooter job={job} />
    </div>
  );
}
