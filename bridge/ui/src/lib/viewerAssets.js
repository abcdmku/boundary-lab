// A solve run has no geometry of its own — its Mesh tab shows the parent
// mesh run's viewer for context.
export function resolveMeshRun(run, runs) {
  if (!run) return null;
  if (run.kind === "mesh") return run;
  if (!run.parentRunId) return null;
  return (runs || []).find((r) => r.id === run.parentRunId) || null;
}

// Resolve the two STL artifacts (walls, driven) the python layer emits per
// mesh run, with graceful fallbacks: summary.viewer_stl, then any loose
// .stl artifact, then the static preview PNG for older runs.
export function viewerAssets(meshRun) {
  if (!meshRun) return { wallsUrl: null, drivenUrl: null, previewUrl: null };
  const arts = meshRun.artifacts || [];
  const bySuffix = (suf) => arts.find((a) => a.name && a.name.toLowerCase().endsWith(suf));
  let walls = bySuffix("_walls.stl");
  let driven = bySuffix("_driven.stl");
  const vs = meshRun.summary && meshRun.summary.viewer_stl;
  if (!walls && vs && vs.walls) walls = { url: vs.walls };
  if (!driven && vs && vs.driven) driven = { url: vs.driven };
  if (!walls) walls = arts.find((a) => a.name && a.name.toLowerCase().endsWith(".stl"));
  const preview = arts.find((a) => a.kind === "preview");
  return {
    wallsUrl: walls ? walls.url : null,
    drivenUrl: driven ? driven.url : null,
    previewUrl: preview ? preview.url : null,
  };
}
