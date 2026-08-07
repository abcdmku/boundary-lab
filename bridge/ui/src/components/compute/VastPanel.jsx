import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { InstanceCard } from "./InstanceCard.jsx";
import { OfferSearch } from "./OfferSearch.jsx";
import { NumberInput } from "../ui/field.jsx";
import { apiCall, json, useFetch } from "../../lib/api";
import { fmtMoney, fmtRate } from "../../lib/format";
import { billingCount, isManaged } from "../../lib/vast";
import { cn } from "../../lib/cn";
import "./compute.css";

/**
 * The vast.ai rental surface.
 *
 * `state.vast` (cached, live over SSE) drives the instance list; the provider
 * config comes from GET /api/vast/status, which is safe to call with no key —
 * that is exactly the case this panel has to render well, since a broken panel
 * would leave an operator guessing where the key goes.
 */
export function VastPanel({ vast, targets, refetch, notify }) {
  const { data: status, error: statusError, loading, reload } = useFetch("/api/vast/status");
  const [tab, setTab] = useState("instances");
  const [importId, setImportId] = useState(undefined);
  const [importing, setImporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const configured = vast?.configured ?? status?.configured ?? false;
  const instances = vast?.instances || [];
  const managed = instances.filter(isManaged);
  const billing = billingCount(instances);
  const burn = vast?.activeBurnRatePerHour ?? 0;
  const targetFor = (id) => (targets || []).find((t) => t.id === `vast:${id}`);

  const refreshInstances = async () => {
    setRefreshing(true);
    const res = await apiCall("/api/vast/instances?refresh=true");
    setRefreshing(false);
    if (res.ok) refetch();
    else notify?.(res.data.error || "refresh failed");
  };

  const doImport = async () => {
    if (!importId) return;
    setImporting(true);
    const res = await apiCall(`/api/vast/instances/${importId}/import`, json("POST", {}));
    setImporting(false);
    if (res.ok) {
      setImportId(undefined);
      refetch();
      notify?.(`Imported instance ${importId}. It is already billing on vast.ai.`);
    } else {
      notify?.(res.data.error || `import failed (${res.status})`);
    }
  };

  // ---------- no key ----------
  if (!configured && !loading) {
    return (
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">vast.ai</span>
          <span className="panel-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={reload}>
              <RefreshCw size={12} aria-hidden /> Re-check
            </button>
          </span>
        </div>
        <div className="panel-body">
          <div className="notice">
            <div className="notice-title">No vast.ai API key configured</div>
            Renting cloud GPUs is off until this bridge can authenticate. The key is read in this
            order:
            <ol style={{ margin: "6px 0 6px 18px", lineHeight: 1.6 }}>
              <li>
                the <code className="mono">VAST_API_KEY</code> environment variable of the bridge
                process
              </li>
              <li>
                a file at{" "}
                <code className="mono">{status?.keyFile || "%USERPROFILE%\\.vast_api_key"}</code>{" "}
                containing just the key
              </li>
            </ol>
            Set one and restart the bridge (or press Re-check — the key is read per request). Get a
            key from the <b>Account</b> page of the vast.ai console.
          </div>
          {statusError && <div className="notice notice--warn" style={{ marginTop: 10 }}>{statusError}</div>}
          <div className="panel-note" style={{ marginTop: 10 }}>
            Everything else on this page — local GPU, queue lanes, targets — works without a key.
          </div>
        </div>
      </div>
    );
  }

  // ---------- configured ----------
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">vast.ai</span>
        <span className="panel-note">
          key from {status?.keySource || vast?.keySource || "?"}
          {status?.keyFingerprint ? ` · ${status.keyFingerprint}` : ""}
          {status?.limits ? ` · ceiling ${fmtMoney(status.limits.maxPricePerHour, 2)}/hr` : ""}
        </span>
        <span className="panel-actions">
          <div className="segmented" role="tablist" aria-label="vast.ai section">
            {[
              ["instances", `Instances${managed.length ? ` (${managed.length})` : ""}`],
              ["offers", "Rent a GPU"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={cn("segmented-item", tab === id && "segmented-item--active")}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </span>
      </div>

      {tab === "instances" ? (
        <>
          <div
            className="panel-body"
            style={{ display: "flex", alignItems: "end", gap: 8, flexWrap: "wrap", paddingBottom: 8 }}
          >
            <button
              type="button"
              className="btn btn--sm"
              onClick={refreshInstances}
              disabled={refreshing}
            >
              <RefreshCw size={12} aria-hidden /> {refreshing ? "Refreshing…" : "Refresh from vast"}
            </button>
            <span className="panel-note" style={{ marginLeft: "auto" }}>
              Adopt an instance rented outside this bridge:
            </span>
            <div style={{ width: 120 }}>
              <NumberInput
                value={importId}
                onValue={setImportId}
                placeholder="instance id"
                aria-label="Instance id to import"
              />
            </div>
            <button
              type="button"
              className="btn btn--sm"
              onClick={doImport}
              disabled={!importId || importing}
            >
              {importing ? "Importing…" : "Import"}
            </button>
          </div>
          {instances.length === 0 ? (
            <div className="panel-empty">
              No managed instances. Nothing is billing.
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn btn--sm" onClick={() => setTab("offers")}>
                  Search for a GPU →
                </button>
              </div>
            </div>
          ) : (
            <div className="instance-list">
              {instances.map((e) => (
                <InstanceCard
                  key={e.id}
                  instance={e}
                  target={targetFor(e.id)}
                  refetch={refetch}
                  notify={notify}
                />
              ))}
            </div>
          )}
          {burn > 0 && (
            <div className="panel-error">
              {fmtRate(burn)} is billing right now across {billing} instance
              {billing === 1 ? "" : "s"}. Stopping halts GPU charges but not storage — only Destroy
              ends all billing.
            </div>
          )}
        </>
      ) : (
        <div className="panel-body">
          <OfferSearch status={status} notify={notify} onRented={() => refetch()} />
        </div>
      )}
    </div>
  );
}
