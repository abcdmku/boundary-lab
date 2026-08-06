import { RunRow } from "./RunRow.jsx";
import "./runs.css";

export function RunBoard({ runs, api, refetch, onOpenLightbox }) {
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
          />
        ))
      )}
    </main>
  );
}
