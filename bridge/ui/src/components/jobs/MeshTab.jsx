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
      <img
        src={previewUrl}
        alt="mesh preview"
        onClick={() => onOpenLightbox(previewUrl)}
        className="mesh-preview"
      />
    );
  }
  return <div className="job-tab-empty">No mesh preview available</div>;
}
