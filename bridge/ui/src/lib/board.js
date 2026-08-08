/**
 * Turning the bridge's state into the two shapes the new views need:
 *
 *   buildBoard(state)     — the schedule board: a planned backlog plus one
 *                           column per compute target, each column knowing its
 *                           lanes, its slots, what occupies them and when it
 *                           will be clear.
 *   buildDesigns(state)   — the designs view: projects, each holding a mesh
 *                           lineage, each mesh holding its solves.
 *
 * Both are pure derivations of `state`. Nothing here fetches, and nothing here
 * decides — the server owns order and scheduling, these functions only read it
 * back out in the shape a human looks at.
 */

export const PLANNED = "planned";

/** The registry id of a job's target, matching GET /api/targets. */
export function targetIdOf(job) {
  const t = job?.target;
  if (!t || t.type === "local") return "local";
  return t.instanceId || t.serverUrl || "local";
}

/** The mesh a solve reads (or the job itself, for a mesh job). */
export function meshOf(job, byId) {
  if (!job) return null;
  if (job.kind === "mesh") return job;
  return byId.get(job.parentJobId || job.params?.meshJobId) || null;
}

/** First preview image of a mesh job — the thumbnail every card wants. */
export function previewUrl(meshJob) {
  const art = (meshJob?.artifacts || []).find((a) => a.kind === "preview");
  return art ? art.url : null;
}

export const triangleCount = (meshJob) => {
  const s = meshJob?.summary;
  const v = s?.triangles ?? s?.n_triangles;
  return typeof v === "number" ? v : null;
};

/**
 * The three or four numbers that actually distinguish one solve of a mesh from
 * another: band, point count, symmetry. Returned as parts so the card can lay
 * them out as numerals rather than a sentence.
 */
export function solveSpec(job) {
  const p = job?.params || {};
  return {
    fmin: typeof p.fmin === "number" ? p.fmin : null,
    fmax: typeof p.fmax === "number" ? p.fmax : null,
    count: typeof p.count === "number" ? p.count : null,
    symmetry: p.symmetry && p.symmetry !== "off" ? String(p.symmetry) : null,
    backend: p.backend ? String(p.backend) : null,
  };
}

/** Score a finished solve reported, if the analysis step lifted one. */
export const scoreOf = (job) => {
  const v = job?.summary?.score;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

const byPriority = (a, b) =>
  (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
  a.createdAt.localeCompare(b.createdAt);

/**
 * The schedule board.
 *
 * A column is a MACHINE, not a lane: the human asks "what is this box doing",
 * and the fact that meshing and solving are separate queues on it is a detail
 * the column shows rather than a reason to split it in two. Each column
 * therefore carries its lanes separately (drops need a lane key) but presents
 * as one place.
 */
export function buildBoard(state) {
  const jobs = state?.jobs || [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const lanes = state?.queue?.lanes || [];
  const targets = state?.targets || [];
  const estimates = state?.estimates || {};

  const laneEntry = (lane, jobId) =>
    (lane.forecast?.entries || []).find((e) => e.jobId === jobId) || null;

  const columns = targets.map((target) => {
    const mine = lanes.filter((l) => l.targetId === target.id);
    const solveLane = mine.find((l) => l.kind === "solve") || null;
    const meshLane = mine.find((l) => l.kind === "mesh") || null;

    const cardsOf = (lane, ids) =>
      (ids || [])
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((job) => ({
          job,
          lane,
          mesh: meshOf(job, byId),
          estimate: estimates[job.id] || null,
          forecast: laneEntry(lane, job.id),
          slot: (lane.slots || []).find((s) => s.jobId === job.id) || null,
        }));

    const runningSolves = solveLane ? cardsOf(solveLane, solveLane.active) : [];
    const runningMeshes = meshLane ? cardsOf(meshLane, meshLane.active) : [];
    const running = [...runningMeshes, ...runningSolves];
    // Meshes and solves wait in different lanes with different rules, so they
    // are two lists — but they belong to the same machine and read as one card
    // stack under it.
    const waitingSolves = solveLane ? cardsOf(solveLane, solveLane.queued) : [];
    const waitingMeshes = meshLane ? cardsOf(meshLane, meshLane.queued) : [];

    // The lane whose clear time answers "when is this box free": the solve
    // lane, since mesh work is seconds and never the thing you wait on.
    const clearInSeconds = solveLane?.forecast?.clearInSeconds ?? null;

    return {
      id: target.id,
      target,
      solveLane,
      meshLane,
      running,
      runningSolves,
      runningMeshes,
      waitingSolves,
      waitingMeshes,
      // Mesh generation has its own CPU lane and may overlap a solve. It must
      // not consume or visually fill one of the target's GPU solve slots.
      slotsUsed: runningSolves.length,
      slots: target.concurrency || 1,
      clearInSeconds,
      backlogSeconds: solveLane?.forecast?.backlogSeconds ?? null,
    };
  });

  // Configured but unlaunched work, in the order the board says it will run.
  const planned = jobs
    .filter((j) => j.status === "draft")
    .sort(byPriority)
    .map((job) => ({
      job,
      lane: null,
      mesh: meshOf(job, byId),
      estimate: estimates[job.id] || null,
      forecast: null,
      slot: null,
    }));

  const running = columns.reduce((n, c) => n + c.running.length, 0);
  const solvesRunning = columns.reduce((n, c) => n + c.runningSolves.length, 0);
  const meshesRunning = columns.reduce((n, c) => n + c.runningMeshes.length, 0);
  const queued = columns.reduce((n, c) => n + c.waitingSolves.length + c.waitingMeshes.length, 0);
  const clears = columns.map((c) => c.clearInSeconds);
  return {
    planned,
    columns,
    totals: {
      running,
      solvesRunning,
      meshesRunning,
      queued,
      planned: planned.length,
      slots: columns.reduce((n, c) => n + (c.target.available ? c.slots : 0), 0),
      // "Everything done by" is the SLOWEST machine, not the sum: they run in
      // parallel. Unknown if any lane contains a job nothing can estimate.
      clearInSeconds: clears.some((c) => c === null) ? null : Math.max(0, ...clears, 0),
    },
  };
}

/**
 * The designs view: project → mesh lineage → solves.
 *
 * Meshes are ordered as a lineage (a root, then its variants, depth first) so
 * a campaign's twenty trials read as a chain of edits rather than a wall of
 * timestamps. Unassigned work is a real bucket, not an error — a mesh you made
 * in thirty seconds should not have to be filed before it is visible.
 */
export function buildDesigns(state) {
  const jobs = state?.jobs || [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const meshes = jobs.filter((j) => j.kind === "mesh");
  const solvesByMesh = new Map();
  for (const job of jobs) {
    if (job.kind !== "solve") continue;
    const meshId = job.parentJobId || job.params?.meshJobId;
    if (!meshId) continue;
    const list = solvesByMesh.get(meshId);
    if (list) list.push(job);
    else solvesByMesh.set(meshId, [job]);
  }

  const childrenOf = new Map();
  for (const mesh of meshes) {
    // A variantOf pointing at a mesh that is not in this project (or is gone)
    // must not hide the mesh — it is treated as a root instead.
    const parent = mesh.variantOf && byId.has(mesh.variantOf) ? mesh.variantOf : null;
    const key = parent ?? "";
    const list = childrenOf.get(key);
    if (list) list.push(mesh);
    else childrenOf.set(key, [mesh]);
  }

  const meshNode = (mesh, depth, rootParams) => {
    const solves = (solvesByMesh.get(mesh.id) || []).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    return {
      mesh,
      depth,
      solves,
      // What makes this variant different from the lineage root — the only
      // part of a twenty-parameter geometry worth showing on a tile.
      delta: paramDelta(rootParams, mesh.params),
      triangles: triangleCount(mesh),
      preview: previewUrl(mesh),
      bestScore: solves.reduce((best, s) => {
        const v = scoreOf(s);
        return v !== null && (best === null || v > best) ? v : best;
      }, null),
    };
  };

  const lineage = (projectId) => {
    const inProject = (m) => (m.projectId ?? null) === projectId;
    const out = [];
    const walk = (mesh, depth, rootParams) => {
      out.push(meshNode(mesh, depth, rootParams));
      for (const child of (childrenOf.get(mesh.id) || [])
        .filter(inProject)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
        walk(child, depth + 1, rootParams);
    };
    const roots = meshes
      .filter(
        (m) =>
          inProject(m) &&
          (!m.variantOf || !byId.has(m.variantOf) || byId.get(m.variantOf).projectId !== projectId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const root of roots) walk(root, 0, root.params || {});
    return out;
  };

  const projectGroups = (state?.projects || []).map((project) => {
      const nodes = lineage(project.id);
      const solves = nodes.flatMap((n) => n.solves);
      return {
        project,
        meshes: nodes,
        solves,
        bestScore: nodes.reduce(
          (best, n) => (n.bestScore !== null && (best === null || n.bestScore > best) ? n.bestScore : best),
          null,
        ),
        running: solves.filter((s) => s.status === "running" || s.status === "queued").length,
      };
    });
  const projects = projectGroups.filter((group) => !group.project.archived);
  const archived = projectGroups.filter((group) => group.project.archived);

  const loose = lineage(null);

  // Solves whose mesh no longer exists. Rare, but they must not vanish just
  // because this view groups by mesh — a deleted mesh does not delete the
  // answers computed from it, and a record you cannot see is a record you
  // cannot delete either.
  const orphans = jobs.filter(
    (j) => j.kind === "solve" && !byId.has(j.parentJobId || j.params?.meshJobId || ""),
  );

  const group = (project, nodes) => ({
    project,
    meshes: nodes,
    solves: nodes.flatMap((n) => n.solves),
    bestScore: nodes.reduce(
      (best, n) => (n.bestScore !== null && (best === null || n.bestScore > best) ? n.bestScore : best),
      null,
    ),
    running: nodes
      .flatMap((n) => n.solves)
      .filter((s) => s.status === "running" || s.status === "queued").length,
  });

  return {
    projects,
    unassigned: loose.length > 0 ? group(null, loose) : null,
    orphans,
    archived,
  };
}

/** Keys whose value differs from the lineage root, as [key, value] pairs. */
export function paramDelta(base, params) {
  const out = [];
  for (const [key, value] of Object.entries(params || {})) {
    const before = (base || {})[key];
    if (JSON.stringify(before) !== JSON.stringify(value)) out.push([key, value]);
  }
  return out;
}
