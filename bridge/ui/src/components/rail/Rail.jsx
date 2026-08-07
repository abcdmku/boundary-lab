import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { GeneratorCard } from "./GeneratorCard.jsx";
import { ToolsList } from "./ToolsList.jsx";
import "../ui/controls.css";

export function Rail({ generators, generatorsError, api, refetch, onNewMesh, onSweep }) {
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api("/api/generators/refresh", { method: "POST" });
      refetch();
    } catch {
      /* toasted */
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <aside className="sticky top-12 h-[calc(100vh-3rem)] w-70 shrink-0 overflow-y-auto border-r border-border p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Generators
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm ml-auto"
          onClick={refresh}
          disabled={refreshing}
          title="Re-read the generator catalog from the python layer"
        >
          <RefreshCw size={11} aria-hidden />
        </button>
      </div>
      {generatorsError && <div className="notice notice--warn mb-2">{generatorsError}</div>}
      {(generators || []).map((g) => (
        <GeneratorCard
          key={g.id}
          generator={g}
          onConfigure={onNewMesh ? () => onNewMesh(g.id) : undefined}
          onSweep={onSweep ? () => onSweep(g.id) : undefined}
        />
      ))}
      {!generatorsError && !(generators || []).length && (
        <div className="panel-note">No generators reported by the python layer yet.</div>
      )}
      <ToolsList />
    </aside>
  );
}
