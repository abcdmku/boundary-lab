import { useId, useState } from "react";
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
  const tabsId = useId();

  const selectRelativeTab = (event, index) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next =
      (index + (event.key === "ArrowLeft" ? -1 : 1) + TABS.length) % TABS.length;
    setTab(TABS[next]);
    event.currentTarget.parentElement?.querySelectorAll("[role='tab']")[next]?.focus();
  };

  return (
    <div className="job-detail" onClick={(e) => e.stopPropagation()}>
      <div className="job-tabs" role="tablist" aria-label="Job details">
        {TABS.map((t, index) => (
          <button
            key={t}
            type="button"
            id={`${tabsId}-tab-${index}`}
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${tabsId}-panel`}
            tabIndex={tab === t ? 0 : -1}
            onClick={(e) => {
              e.stopPropagation();
              setTab(t);
            }}
            onKeyDown={(event) => selectRelativeTab(event, index)}
            className={cn("job-tab", tab === t && "job-tab--active")}
          >
            {t}
          </button>
        ))}
      </div>
      <div
        id={`${tabsId}-panel`}
        className="job-tab-panel"
        role="tabpanel"
        aria-labelledby={`${tabsId}-tab-${TABS.indexOf(tab)}`}
      >
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
