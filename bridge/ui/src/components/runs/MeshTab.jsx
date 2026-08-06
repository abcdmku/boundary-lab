import { MeshViewer } from "./MeshViewer.jsx";
import { resolveMeshRun, viewerAssets } from "../../lib/viewerAssets";

export function MeshTab({ run, runs, onOpenLightbox }) {
  const meshRun = resolveMeshRun(run, runs);
  const { wallsUrl, drivenUrl, previewUrl } = viewerAssets(meshRun);

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
  return <div className="run-tab-empty">No mesh preview available</div>;
}
