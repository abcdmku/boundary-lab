import { useEffect, useMemo, useRef, useState } from "react";
import { Layers, Plus } from "lucide-react";
import { JobRow } from "./JobRow.jsx";
import { BatchGroup } from "./BatchGroup.jsx";
import { LaneStrip, queueInfoFor } from "../queue/LanesPanel.jsx";
import { TextInput } from "../ui/field.jsx";
import { cn } from "../../lib/cn";
import { json } from "../../lib/api";
import "./jobs.css";
import "./batch.css";

const KIND_FILTERS = [
  ["all", "All"],
  ["mesh", "Meshes"],
  ["solve", "Solves"],
];
const STATUS_FILTERS = [
  ["all", "All"],
  ["draft", "Drafts"],
  ["active", "Active"],
  ["done", "Done"],
  ["failed", "Failed"],
];

const matchesStatus = (job, f) =>
  f === "all"
    ? true
    : f === "active"
      ? job.status === "queued" || job.status === "running"
      : f === "failed"
        ? job.status === "failed" || job.status === "cancelled"
        : job.status === f;

export function JobBoard({
  jobs,
  batches,
  generators,
  targets,
  lanes,
  api,
  refetch,
  notify,
  onOpenLightbox,
  onOpenQueue,
  onOpenDialog,
}) {
  // Expansion state lives here (not per-row) so link chips on one row can
  // open and scroll to another row.
  const [openIds, setOpenIds] = useState(() => new Set());
  const [closedBatches, setClosedBatches] = useState(() => new Set());
  const [selected, setSelected] = useState(() => new Set());
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const armTimer = useRef(null);
  useEffect(() => () => clearTimeout(armTimer.current), []);

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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (jobs || []).filter(
      (j) =>
        (kindFilter === "all" || j.kind === kindFilter) &&
        matchesStatus(j, statusFilter) &&
        (!q ||
          (j.name || "").toLowerCase().includes(q) ||
          j.id.toLowerCase().includes(q) ||
          (j.generator || "").toLowerCase().includes(q) ||
          (j.batchName || "").toLowerCase().includes(q)),
    );
  }, [jobs, kindFilter, statusFilter, query]);

  const visibleIds = useMemo(() => new Set(visible.map((j) => j.id)), [visible]);
  const draftCount = (jobs || []).filter((j) => j.status === "draft").length;

  const selectOne = (id, on) => {
    setDeleteArmed(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const selectMany = (ids) => {
    setDeleteArmed(false);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) if (visibleIds.has(id)) next.add(id);
      return next;
    });
  };

  const selectedJobs = (jobs || []).filter((j) => selected.has(j.id));
  const selDrafts = selectedJobs.filter((j) => j.status === "draft");
  const selActive = selectedJobs.filter((j) => j.status === "queued" || j.status === "running");
  const selDeletable = selectedJobs.filter((j) => j.status !== "running" && j.status !== "queued");

  const bulk = async (label, fn) => {
    setBulkBusy(label);
    try {
      await fn();
      refetch();
    } catch {
      /* toasted */
    } finally {
      setBulkBusy(null);
    }
  };

  const launchSelected = () =>
    bulk("launch", async () => {
      const res = await api("/api/jobs/launch", json("POST", { jobIds: selDrafts.map((j) => j.id) }));
      const skipped = res?.skipped || [];
      if (skipped.length) notify?.(`${skipped.length} skipped: ${skipped[0].reason}`);
      setSelected(new Set());
    });

  const cancelSelected = () =>
    bulk("cancel", async () => {
      await api("/api/jobs/cancel", json("POST", { jobIds: selActive.map((j) => j.id) }));
      setSelected(new Set());
    });

  const deleteSelected = () =>
    bulk("delete", async () => {
      // No bulk delete endpoint: solves first, since a mesh with a pending
      // dependent solve is refused (409) by design.
      const ordered = [...selDeletable].sort((a, b) => (a.kind === "solve" ? -1 : 1));
      for (const job of ordered) {
        try {
          await api(`/api/jobs/${job.id}`, { method: "DELETE" });
        } catch {
          /* reported; keep going so one blocked mesh does not stop the rest */
        }
      }
      setSelected(new Set());
    });

  // Deleting many finished jobs at once is the most destructive thing on this
  // board and the least recoverable, so it arms exactly like the row and batch
  // delete buttons rather than firing on the first click.
  const armDelete = () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setDeleteArmed(false), 3000);
      return;
    }
    clearTimeout(armTimer.current);
    setDeleteArmed(false);
    void deleteSelected();
  };

  // ---- grouping ----
  const batchList = useMemo(() => {
    const byId = new Map((batches || []).map((b) => [b.batchId, b]));
    const groups = [];
    const seen = new Set();
    const loose = [];
    for (const job of visible) {
      if (!job.batchId || !byId.has(job.batchId)) {
        loose.push(job);
        continue;
      }
      if (!seen.has(job.batchId)) {
        seen.add(job.batchId);
        groups.push({ batch: byId.get(job.batchId), jobs: [] });
      }
      groups.find((g) => g.batch.batchId === job.batchId).jobs.push(job);
    }
    return { groups, loose };
  }, [visible, batches]);

  const renderRow = (job, showBatch) => (
    <JobRow
      key={job.id}
      job={job}
      jobs={jobs}
      generators={generators}
      targets={targets}
      queueInfo={queueInfoFor(lanes, job.id)}
      api={api}
      refetch={refetch}
      notify={notify}
      onOpenLightbox={onOpenLightbox}
      open={openIds.has(job.id)}
      onToggle={() => toggle(job.id)}
      onNavigate={focusJob}
      onOpenSolve={(mesh) => onOpenDialog({ type: "solve", mesh })}
      selected={selected.has(job.id)}
      onSelect={selectOne}
      showBatch={showBatch}
    />
  );

  return (
    <main className="job-board">
      <div className="board-head">
        <div className="board-title">Jobs</div>
        <span className="board-count">
          {visible.length === (jobs || []).length
            ? `${visible.length}`
            : `${visible.length} of ${jobs?.length || 0}`}
          {draftCount > 0 && ` · ${draftCount} draft${draftCount === 1 ? "" : "s"}`}
        </span>
        <div className="board-head-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onOpenDialog({ type: "mesh" })}
            title="Open the live mesh editor: shape the geometry, then save or generate"
          >
            <Plus size={12} aria-hidden /> Mesh
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() =>
              onOpenDialog({
                type: "batch",
                kind: "solve",
                initialMeshIds: selectedJobs.filter((j) => j.kind === "mesh").map((j) => j.id),
              })
            }
            title="Sweep settings across one or many meshes"
          >
            <Layers size={12} aria-hidden /> Batch…
          </button>
        </div>
      </div>

      <LaneStrip lanes={lanes} onNavigate={onOpenQueue} />

      <div className="board-filters">
        <div className="filter-set" role="group" aria-label="Filter by kind">
          {KIND_FILTERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn("filter-chip", kindFilter === id && "filter-chip--on")}
              aria-pressed={kindFilter === id}
              onClick={() => setKindFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="filter-set" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn("filter-chip", statusFilter === id && "filter-chip--on")}
              aria-pressed={statusFilter === id}
              onClick={() => setStatusFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <TextInput
          className="board-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search jobs…"
          aria-label="Search jobs"
        />
        <button
          type="button"
          className={cn("filter-chip", grouped && "filter-chip--on")}
          aria-pressed={grouped}
          onClick={() => setGrouped((g) => !g)}
          title="Group jobs by the batch that created them"
        >
          Batches
        </button>
      </div>

      {selected.size > 0 && (
        <div className="selection-bar">
          <span>
            <b>{selected.size}</b> selected
          </span>
          <span className="modal-foot-spacer" />
          <button
            type="button"
            className="btn btn--sm"
            disabled={!selDrafts.length || bulkBusy !== null}
            onClick={launchSelected}
          >
            Launch {selDrafts.length || ""}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!selActive.length || bulkBusy !== null}
            onClick={cancelSelected}
          >
            Cancel {selActive.length || ""}
          </button>
          <button
            type="button"
            className={cn("btn btn--sm", deleteArmed ? "btn--danger-solid" : "btn--danger")}
            disabled={!selDeletable.length || bulkBusy !== null}
            onClick={armDelete}
          >
            {deleteArmed ? `Confirm delete ${selDeletable.length}` : `Delete ${selDeletable.length || ""}`}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setDeleteArmed(false);
              setSelected(new Set());
            }}
          >
            Clear
          </button>
        </div>
      )}

      {!visible.length ? (
        <div className="job-tab-empty">
          {jobs?.length ? "No job matches these filters." : "No jobs yet — start with a mesh."}
        </div>
      ) : grouped ? (
        <>
          {batchList.groups.map(({ batch, jobs: groupJobs }) => (
            <BatchGroup
              key={batch.batchId}
              batch={batch}
              open={!closedBatches.has(batch.batchId)}
              onToggle={() =>
                setClosedBatches((prev) => {
                  const next = new Set(prev);
                  if (next.has(batch.batchId)) next.delete(batch.batchId);
                  else next.add(batch.batchId);
                  return next;
                })
              }
              api={api}
              refetch={refetch}
              notify={notify}
              onSelectAll={selectMany}
            >
              {groupJobs.map((job) => renderRow(job, false))}
            </BatchGroup>
          ))}
          {batchList.loose.map((job) => renderRow(job, true))}
        </>
      ) : (
        visible.map((job) => renderRow(job, true))
      )}
    </main>
  );
}
