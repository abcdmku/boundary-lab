// A solve job has no geometry of its own — its Mesh tab shows the parent
// mesh job's viewer for context.
export function resolveMeshJob(job, jobs) {
  if (!job) return null;
  if (job.kind === "mesh") return job;
  if (!job.parentJobId) return null;
  return (jobs || []).find((r) => r.id === job.parentJobId) || null;
}

// Resolve the two STL artifacts (walls, driven) the python layer emits per
// mesh job, with graceful fallbacks: summary.viewer_stl, then any loose
// .stl artifact, then the static preview PNG for older jobs.
export function viewerAssets(meshJob) {
  if (!meshJob) return { wallsUrl: null, drivenUrl: null, previewUrl: null };
  const arts = meshJob.artifacts || [];
  const bySuffix = (suf) => arts.find((a) => a.name && a.name.toLowerCase().endsWith(suf));
  let walls = bySuffix("_walls.stl");
  let driven = bySuffix("_driven.stl");
  const vs = meshJob.summary && meshJob.summary.viewer_stl;
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
