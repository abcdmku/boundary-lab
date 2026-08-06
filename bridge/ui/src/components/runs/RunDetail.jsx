import { useState } from "react";
import { cn } from "../../lib/cn";
import { MeshTab } from "./MeshTab.jsx";
import { PlotsTab } from "./PlotsTab.jsx";
import { RunFooter } from "./RunFooter.jsx";

const TABS = ["Mesh", "Plots"];

export function RunDetail({ run, runs, onOpenLightbox }) {
  // Solve runs open on their plots; mesh runs open on the geometry.
  const [tab, setTab] = useState(run.kind === "mesh" ? "Mesh" : "Plots");

  return (
    <div className="run-detail" onClick={(e) => e.stopPropagation()}>
      <div className="run-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            aria-selected={tab === t}
            onClick={(e) => {
              e.stopPropagation();
              setTab(t);
            }}
            className={cn("run-tab", tab === t && "run-tab--active")}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="run-tab-panel">
        {tab === "Mesh" ? (
          <MeshTab run={run} runs={runs} onOpenLightbox={onOpenLightbox} />
        ) : (
          <PlotsTab run={run} onOpenLightbox={onOpenLightbox} />
        )}
      </div>
      <RunFooter run={run} />
    </div>
  );
}
