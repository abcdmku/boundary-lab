import { useMemo, useState } from "react";
import { Archive, ChevronRight, FolderPlus, Plus } from "lucide-react";
import { MeshTile } from "./MeshTile.jsx";
import { StatusDot } from "../jobs/StatusDot.jsx";
import { Select, TextInput } from "../ui/field.jsx";
import { cn } from "../../lib/cn";
import { fmtScore } from "../../lib/format";
import { buildDesigns } from "../../lib/board";
import { json } from "../../lib/api";
import "../jobs/jobs.css";
import "./designs.css";

/**
 * Designs: every geometry this bridge holds, grouped by the thing it is trying
 * to be, with its answers attached.
 *
 * The unit here is a PROJECT — one design being explored. Under it, meshes in
 * lineage order (a root and the variants derived from it), and under each mesh
 * the solves computed from it. That is the actual shape of the work, and it is
 * the shape an optimization campaign produces: twenty variants of one design,
 * each with a coarse solve and maybe a fine one.
 *
 * Meshes that were never filed are not an error state — they get an
 * "Unassigned" group and can be moved into a project when there is a reason to.
 */
export function DesignsView({ state, api, refetch, notify, onOpenJob, onOpenDialog }) {
  const designs = useMemo(() => buildDesigns(state), [state]);
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const groups = [
    ...designs.projects,
    ...(designs.unassigned ? [designs.unassigned] : []),
    ...(designs.archived || []),
  ];
  const q = query.trim().toLowerCase();

  // A mesh matches on its own fields, its design's name, OR any of its solves —
  // searching for a solve should find the geometry it belongs to, which is the
  // whole reason the flat job list is gone.
  const matchesQuery = (node, group) =>
    !q ||
    (node.mesh.name || "").toLowerCase().includes(q) ||
    node.mesh.id.toLowerCase().includes(q) ||
    (node.mesh.generator || "").toLowerCase().includes(q) ||
    (group.project?.name || "").toLowerCase().includes(q) ||
    node.solves.some(
      (s) => (s.name || "").toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
    );

  const isActive = (j) => j.status === "queued" || j.status === "running";
  const isBad = (j) => j.status === "failed" || j.status === "cancelled";
  const matchesStatus = (node) => {
    if (statusFilter === "all") return true;
    const all = [node.mesh, ...node.solves];
    if (statusFilter === "active") return all.some(isActive);
    if (statusFilter === "failed") return all.some(isBad);
    return all.some((j) => j.status === "draft");
  };

  const visible = groups
    .map((g) => ({ ...g, meshes: g.meshes.filter((n) => matchesQuery(n, g) && matchesStatus(n)) }))
    // A newly created design must remain visible so the next action is
    // obvious. Empty designs only disappear while a search/filter is active.
    .filter(
      (g) =>
        g.meshes.length > 0 ||
        (!!g.project && !q && statusFilter === "all"),
    );

  const orphans = (designs.orphans || []).filter(
    (s) =>
      (!q || (s.name || "").toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) &&
      (statusFilter === "all" ||
        (statusFilter === "active" && isActive(s)) ||
        (statusFilter === "failed" && isBad(s)) ||
        (statusFilter === "draft" && s.status === "draft")),
  );

  const newProject = async () => {
    const name = draftName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api("/api/projects", json("POST", { name }));
      setDraftName("");
      setNaming(false);
      refetch();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  /**
   * File loose meshes under a design. Only the lineage ROOTS are named: the
   * server carries each mesh's variants and solves along with it, so passing
   * the whole tree would just be the same move repeated.
   */
  const fileInto = async (group, projectId) => {
    if (!projectId) return;
    setBusy(true);
    try {
      await api(
        "/api/projects/assign",
        json("POST", {
          jobIds: group.meshes.filter((n) => n.depth === 0).map((n) => n.mesh.id),
          projectId,
        }),
      );
      refetch();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  const setProjectArchived = async (projectId, archived) => {
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}`, json("PATCH", { archived }));
      refetch();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <main
      id="view-designs"
      className="designs"
      role="tabpanel"
      aria-labelledby="view-tab-designs"
    >
      <div className="designs-head">
        <div className="board-title">Designs</div>
        <span className="board-count num">
          {groups.reduce((n, g) => n + g.meshes.length, 0)} meshes ·{" "}
          {groups.reduce((n, g) => n + g.solves.length, 0)} solves
        </span>
        <div className="filter-set designs-filters" role="group" aria-label="Filter by status">
          {[
            ["all", "All"],
            ["active", "Active"],
            ["draft", "Planned"],
            ["failed", "Failed"],
          ].map(([id, label]) => (
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
          className="designs-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search meshes and solves…"
          aria-label="Search meshes and solves"
        />
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setNaming((v) => !v)}
          aria-expanded={naming}
        >
          <FolderPlus size={12} aria-hidden /> Design
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => onOpenDialog?.({ type: "mesh" })}
        >
          <Plus size={12} aria-hidden /> Mesh
        </button>
      </div>

      {naming && (
        <div className="design-new">
          <TextInput
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void newProject();
              }
              if (e.key === "Escape") setNaming(false);
            }}
            placeholder="Name this design — e.g. cd90x60"
            aria-label="New design name"
          />
          <button
            type="button"
            className="btn btn--sm"
            disabled={!draftName.trim() || busy}
            onClick={newProject}
          >
            Create
          </button>
        </div>
      )}

      {visible.length === 0 && orphans.length === 0 && (
        <div className="panel-empty">
          {q || statusFilter !== "all"
            ? "Nothing matches that."
            : "No meshes yet — start with one and its variants follow."}
        </div>
      )}

      {visible.map((group) => {
        const key = group.project?.id ?? "unassigned";
        const open = !closed.has(key);
        const variants = group.meshes.filter((n) => n.depth > 0).length;
        return (
          <section
            key={key}
            className={cn(
              "design",
              !group.project && "design--loose",
              group.project?.archived && "design--archived",
            )}
          >
            <header className="design-head">
              <button
                type="button"
                className="design-toggle"
                aria-expanded={open}
                onClick={() => toggle(key)}
              >
                <ChevronRight size={13} className={cn("design-caret", open && "design-caret--open")} />
                <span className="design-name">{group.project?.name ?? "Unassigned"}</span>
              </button>
              <span className="design-meta num">
                {group.meshes.length} mesh{group.meshes.length === 1 ? "" : "es"}
                {variants > 0 && ` · ${variants} variant${variants === 1 ? "" : "s"}`}
                {group.solves.length > 0 && ` · ${group.solves.length} solve${group.solves.length === 1 ? "" : "s"}`}
                {group.running > 0 && ` · ${group.running} active`}
              </span>
              {group.bestScore !== null && (
                <span className="design-best num" title="Best score in this design">
                  ★{fmtScore(group.bestScore)}
                </span>
              )}
              {group.project?.archived ? (
                <div className="design-actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => void setProjectArchived(group.project.id, false)}
                  >
                    Restore
                  </button>
                </div>
              ) : group.project ? (
                <div className="design-actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => void setProjectArchived(group.project.id, true)}
                    title="Archive this design without deleting its jobs"
                  >
                    <Archive size={11} aria-hidden /> Archive
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={
                      busy || !group.meshes.some((node) => node.mesh.status === "done")
                    }
                    onClick={() =>
                      onOpenDialog?.({
                        type: "batch",
                        kind: "solve",
                        initialMeshIds: group.meshes
                          .filter((n) => n.mesh.status === "done")
                          .map((n) => n.mesh.id),
                      })
                    }
                    title={
                      group.meshes.some((node) => node.mesh.status === "done")
                        ? "Plan solves across every finished mesh in this design"
                        : "Generate a mesh before planning solves"
                    }
                  >
                    Plan solves
                  </button>
                </div>
              ) : designs.projects.length > 0 ? (
                <Select
                  className="design-file"
                  value=""
                  disabled={busy}
                  aria-label="File these meshes under a design"
                  onChange={(e) => void fileInto(group, e.target.value)}
                >
                  <option value="">File under…</option>
                  {designs.projects.map((g) => (
                    <option key={g.project.id} value={g.project.id}>
                      {g.project.name}
                    </option>
                  ))}
                </Select>
              ) : null}
            </header>

            {group.project?.goal && <p className="design-goal">{group.project.goal}</p>}

            {open && (
              <div className="design-body">
                {group.meshes.length === 0 && group.project && (
                  <div className="design-empty">
                    <span>No meshes in this design yet.</span>
                    {!group.project.archived && (
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() =>
                          onOpenDialog?.({ type: "mesh", projectId: group.project.id })
                        }
                      >
                        <Plus size={12} aria-hidden /> New mesh
                      </button>
                    )}
                  </div>
                )}
                {group.meshes.map((node) => (
                  <MeshTile
                    key={node.mesh.id}
                    node={node}
                    busy={busy}
                    actionsDisabled={!!group.project?.archived}
                    onOpen={onOpenJob}
                    onSolve={(mesh) => onOpenDialog?.({ type: "solve", mesh })}
                    onVariant={(mesh) => onOpenDialog?.({ type: "mesh", variantOf: mesh })}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {/* Solves whose mesh was deleted. They have no tile to live in, but they
          still hold results and still take disk, so they get a plain row
          rather than silently disappearing from the only ledger there is. */}
      {orphans.length > 0 && (
        <section className="design design--loose">
          <header className="design-head">
            <span className="design-name">Solves without a mesh</span>
            <span className="design-meta num">
              {orphans.length} — their mesh job was deleted
            </span>
          </header>
          <div className="design-body design-body--row">
            {orphans.map((solve) => (
              <button
                key={solve.id}
                type="button"
                className={cn("sv", `sv--${solve.status}`)}
                onClick={() => onOpenJob?.(solve.id)}
                title={solve.name || solve.id}
              >
                <StatusDot status={solve.status} />
                <span>{solve.name || solve.id}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
