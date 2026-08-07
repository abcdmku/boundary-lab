import { useState } from "react";
import { cn } from "../../lib/cn";
import { MeshTab } from "./MeshTab.jsx";
import { PlotsTab } from "./PlotsTab.jsx";
import { ConfigTab } from "./ConfigTab.jsx";
import { JobFooter } from "./JobFooter.jsx";

const TABS = ["Config", "Mesh", "Plots"];

export function JobDetail({
  job,
  jobs,
  generators,
  targets,
  api,
  refetch,
  notify,
  onOpenLightbox,
  onOpenSolve,
}) {
  // A draft has nothing to show but its configuration; a finished solve opens
  // on its plots, a mesh on its geometry.
  const [tab, setTab] = useState(job.status === "draft" ? "Config" : job.kind === "mesh" ? "Mesh" : "Plots");

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
        {tab === "Config" ? (
          <ConfigTab
            job={job}
            jobs={jobs}
            generators={generators}
            targets={targets}
            api={api}
            refetch={refetch}
            notify={notify}
            onOpenSolve={onOpenSolve}
          />
        ) : tab === "Mesh" ? (
          <MeshTab job={job} jobs={jobs} onOpenLightbox={onOpenLightbox} />
        ) : (
          <PlotsTab job={job} onOpenLightbox={onOpenLightbox} />
        )}
      </div>
      <JobFooter job={job} />
    </div>
  );
}
