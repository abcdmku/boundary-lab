import { useCallback, useState } from "react";
import { Topbar } from "./components/Topbar.jsx";
import { Rail } from "./components/rail/Rail.jsx";
import { RunBoard } from "./components/runs/RunBoard.jsx";
import { Toasts } from "./components/Toasts.jsx";
import { Lightbox } from "./components/Lightbox.jsx";
import { useBridgeState, apiRequest } from "./lib/api";
import { useToasts } from "./lib/useToasts";

export default function App() {
  const { toasts, notify } = useToasts();
  const { state, connected, refetch } = useBridgeState(notify);
  const [lightboxUrl, setLightboxUrl] = useState(null);

  const api = useCallback((path, opts) => apiRequest(path, opts, notify), [notify]);

  return (
    <>
      <Topbar connected={connected} />
      <div className="flex items-stretch">
        <Rail generators={state?.generators} />
        <RunBoard
          runs={state?.runs || []}
          api={api}
          refetch={refetch}
          onOpenLightbox={setLightboxUrl}
        />
      </div>
      <Toasts toasts={toasts} />
      <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />
    </>
  );
}
