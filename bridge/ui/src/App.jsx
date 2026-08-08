import { useCallback, useState } from "react";
import { Topbar } from "./components/Topbar.jsx";
import { Rail } from "./components/rail/Rail.jsx";
import { JobBoard } from "./components/jobs/JobBoard.jsx";
import { ComputeView } from "./components/compute/ComputeView.jsx";
import { MeshEditor } from "./components/jobs/MeshEditor.jsx";
import { SolveDialog } from "./components/jobs/SolveDialog.jsx";
import { BatchDialog } from "./components/jobs/BatchDialog.jsx";
import { Toasts } from "./components/Toasts.jsx";
import { Lightbox } from "./components/Lightbox.jsx";
import { useBridgeState, apiRequest } from "./lib/api";
import { useToasts } from "./lib/useToasts";

export default function App() {
  const { toasts, notify } = useToasts();
  const { state, connected, refetch } = useBridgeState(notify);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [view, setView] = useState("jobs");
  // Dialogs live here, above both views, so the rail can open the same sweep
  // builder the board does and a job link inside one keeps working.
  const [dialog, setDialog] = useState(null);

  const api = useCallback((path, opts) => apiRequest(path, opts, notify), [notify]);

  const lanes = state?.queue?.lanes || [];
  const running = lanes.reduce((n, l) => n + (l.active?.length || 0), 0);
  const queued = lanes.reduce((n, l) => n + (l.queued?.length || 0), 0);

  const focusJob = (id) => {
    setView("jobs");
    requestAnimationFrame(() => {
      const el = document.getElementById("job-" + id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const close = () => setDialog(null);

  return (
    <>
      <Topbar
        connected={connected}
        view={view}
        onView={setView}
        burn={state?.vast?.activeBurnRatePerHour || 0}
        running={running}
        queued={queued}
      />
      <div className="flex items-stretch">
        {view === "jobs" && (
          <Rail
            generators={state?.generators}
            generatorsError={state?.generatorsError}
            api={api}
            refetch={refetch}
            onNewMesh={(generatorId) => setDialog({ type: "mesh", generatorId })}
            onSweep={(generatorId) => setDialog({ type: "batch", kind: "mesh", generatorId })}
          />
        )}
        {view === "jobs" ? (
          <JobBoard
            jobs={state?.jobs || []}
            batches={state?.batches || []}
            generators={state?.generators || []}
            targets={state?.targets || []}
            lanes={lanes}
            api={api}
            refetch={refetch}
            notify={notify}
            onOpenLightbox={setLightboxUrl}
            onOpenQueue={() => setView("compute")}
            onOpenDialog={setDialog}
          />
        ) : (
          <ComputeView state={state} refetch={refetch} notify={notify} onNavigateJob={focusJob} />
        )}
      </div>

      {dialog?.type === "mesh" && (
        <MeshEditor
          generators={state?.generators || []}
          initialGeneratorId={dialog.generatorId}
          api={api}
          refetch={refetch}
          onClose={close}
        />
      )}
      {dialog?.type === "solve" && (
        <SolveDialog
          mesh={dialog.mesh}
          targets={state?.targets || []}
          api={api}
          refetch={refetch}
          onClose={close}
        />
      )}
      {dialog?.type === "batch" && (
        <BatchDialog
          kind={dialog.kind}
          initialGeneratorId={dialog.generatorId}
          initialMeshIds={dialog.initialMeshIds}
          jobs={state?.jobs || []}
          generators={state?.generators || []}
          targets={state?.targets || []}
          api={api}
          refetch={refetch}
          onClose={close}
        />
      )}

      <Toasts toasts={toasts} />
      <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />
    </>
  );
}
