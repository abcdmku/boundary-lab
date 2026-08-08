import { useCallback, useState } from "react";
import { Topbar } from "./components/Topbar.jsx";
import { Rail } from "./components/rail/Rail.jsx";
import { DesignsView } from "./components/designs/DesignsView.jsx";
import { ScheduleView } from "./components/schedule/ScheduleView.jsx";
import { MachinesDialog } from "./components/compute/MachinesDialog.jsx";
import { JobDialog } from "./components/jobs/JobDialog.jsx";
import { NewMeshDialog } from "./components/jobs/NewMeshDialog.jsx";
import { SolveDialog } from "./components/jobs/SolveDialog.jsx";
import { BatchDialog } from "./components/jobs/BatchDialog.jsx";
import { Toasts } from "./components/Toasts.jsx";
import { Lightbox } from "./components/Lightbox.jsx";
import { useBridgeState, apiRequest } from "./lib/api";
import { useToasts } from "./lib/useToasts";

/**
 * Two surfaces over one state, and one dialog for the thing itself:
 *
 *   designs   WHAT is being built — projects, mesh lineage, the solves of each
 *             mesh. This is the ledger; every job lives here, in the structure
 *             it actually has.
 *   schedule  WHEN and WHERE it runs — the drag-and-drop board, one column per
 *             machine.
 *   JobDialog one job in full: config, geometry, plots, log, actions.
 *
 * There is deliberately no flat "jobs" list and no separate "compute" view.
 * Both were second renderings of records these two surfaces already show — the
 * jobs board relisted every mesh and solve that Designs groups properly, and
 * the compute view relisted the machines that are the schedule's columns. What
 * each of them uniquely owned survived: the job detail panel became JobDialog,
 * and renting a GPU became the Machines dialog.
 *
 * Dialogs live here, above both views, so either can open any of them and a
 * job link inside one keeps working.
 */
export default function App() {
  const { toasts, notify } = useToasts();
  const { state, connected, refetch } = useBridgeState(notify);
  const [lightbox, setLightbox] = useState(null);
  const [view, setView] = useState("designs");
  const [dialog, setDialog] = useState(null);

  const api = useCallback((path, opts) => apiRequest(path, opts, notify), [notify]);

  const lanes = state?.queue?.lanes || [];
  const running = lanes.reduce((n, l) => n + (l.active?.length || 0), 0);
  const queued = lanes.reduce((n, l) => n + (l.queued?.length || 0), 0);

  const jobs = state?.jobs || [];
  const projects = state?.projects || [];
  const activeProjects = projects.filter((project) => !project.archived);
  /** Open one job's detail. The same call from a tile, a chip or a board card. */
  const openJob = (jobId) => setDialog({ type: "job", jobId });
  const openJobDialog = dialog?.type === "job" ? jobs.find((j) => j.id === dialog.jobId) : null;

  const close = () => setDialog(null);

  return (
    <>
      <Topbar
        connected={connected}
        view={view}
        onView={setView}
        onOpenMachines={() => setDialog({ type: "machines" })}
        burn={state?.vast?.activeBurnRatePerHour || 0}
        running={running}
        queued={queued}
      />
      <div className="app-body flex items-stretch">
        {view === "designs" && (
          <>
            <Rail
              generators={state?.generators}
              generatorsError={state?.generatorsError}
              api={api}
              refetch={refetch}
              onNewMesh={(generatorId) => setDialog({ type: "mesh", generatorId })}
              onSweep={(generatorId) => setDialog({ type: "batch", kind: "mesh", generatorId })}
            />
            <DesignsView
              state={state}
              api={api}
              refetch={refetch}
              notify={notify}
              onOpenJob={openJob}
              onOpenDialog={setDialog}
            />
          </>
        )}
        {view === "schedule" && (
          <ScheduleView
            state={state}
            api={api}
            refetch={refetch}
            notify={notify}
            onOpenJob={openJob}
            onOpenDialog={setDialog}
            onOpenMachines={() => setDialog({ type: "machines" })}
          />
        )}
      </div>

      {openJobDialog && (
        <JobDialog
          job={openJobDialog}
          jobs={jobs}
          projectName={projects.find((p) => p.id === openJobDialog.projectId)?.name}
          generators={state?.generators || []}
          targets={state?.targets || []}
          api={api}
          refetch={refetch}
          notify={notify}
          onOpenLightbox={(url, label) => setLightbox({ url, label })}
          onOpenSolve={(mesh) => setDialog({ type: "solve", mesh })}
          onNavigate={openJob}
          onClose={close}
        />
      )}
      {dialog?.type === "machines" && (
        <MachinesDialog state={state} refetch={refetch} notify={notify} onClose={close} />
      )}
      {dialog?.type === "mesh" && (
        <NewMeshDialog
          generators={state?.generators || []}
          initialGeneratorId={dialog.generatorId}
          initialProjectId={dialog.projectId}
          variantOf={dialog.variantOf}
          projects={activeProjects}
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
          jobs={jobs}
          generators={state?.generators || []}
          targets={state?.targets || []}
          projects={activeProjects}
          api={api}
          refetch={refetch}
          onClose={close}
        />
      )}

      <Toasts toasts={toasts} />
      <Lightbox
        url={lightbox?.url}
        label={lightbox?.label}
        onClose={() => setLightbox(null)}
      />
    </>
  );
}
