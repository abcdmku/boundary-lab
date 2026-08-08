import { MeshViewer } from "./MeshViewer.jsx";
import { resolveMeshJob, viewerAssets } from "../../lib/viewerAssets";

export function MeshTab({ job, jobs, onOpenLightbox }) {
  const meshJob = resolveMeshJob(job, jobs);
  const { wallsUrl, drivenUrl, previewUrl } = viewerAssets(meshJob);

  if (wallsUrl) {
    return (
      <div className="mesh-frame">
        <MeshViewer wallsUrl={wallsUrl} drivenUrl={drivenUrl} />
      </div>
    );
  }
  if (previewUrl) {
    return (
      <button
        type="button"
        className="mesh-preview-button"
        onClick={() => onOpenLightbox(previewUrl, `${meshJob?.name || "mesh"} preview`)}
        aria-label="Open mesh preview"
      >
        <img src={previewUrl} alt="mesh preview" className="mesh-preview" />
      </button>
    );
  }
  return <div className="job-tab-empty">No mesh preview available</div>;
}
