import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/modal.jsx";
import { apiCall, json } from "../../lib/api";
import { fmtDuration, fmtMoney, fmtRate } from "../../lib/format";
import "./compute.css";

const MONEY_KEYS = new Set(["pricePerHour", "estimatedDailyCost", "estimatedCostUsd", "maxPricePerHour", "storageCostPerGbMonth"]);
const LABELS = {
  pricePerHour: "price",
  estimatedDailyCost: "per day",
  estimatedCostUsd: "spent so far",
  uptimeSeconds: "uptime",
  storageCostPerGbMonth: "storage",
  gpuName: "GPU",
  numGpus: "GPUs",
  diskGb: "disk",
  offerId: "offer",
  instanceId: "instance",
  geolocation: "region",
};

/** The server's own quote, rendered without editorialising the numbers. */
export function QuoteTable({ quote }) {
  const entries = Object.entries(quote || {}).filter(([k]) => k !== "note");
  if (!entries.length) return null;
  return (
    <dl className="kv">
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{LABELS[k] || k}</dt>
          <dd>
            {k === "pricePerHour"
              ? fmtRate(v)
              : k === "uptimeSeconds"
                ? fmtDuration(v)
                : MONEY_KEYS.has(k) && typeof v === "number"
                  ? fmtMoney(v, 2)
                  : v === null || v === undefined
                    ? "—"
                    : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Two-phase confirmation for every money-moving vast.ai call.
 *
 * Phase 1 sends the request WITHOUT `confirm`, which the bridge answers with
 * 402 and a full quote — so the price shown is the server's, freshly computed,
 * not something the client remembered. Phase 2 resends with `confirm: true`.
 * There is no path here that spends money on a single click.
 */
export function ConfirmCostDialog({
  title,
  subtitle,
  description,
  method = "POST",
  path,
  body,
  actionLabel,
  danger,
  onClose,
  onDone,
  notify,
}) {
  const [quote, setQuote] = useState(null);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [phase, setPhase] = useState("quoting");

  // Callers pass inline closures and object literals; keying the effect on the
  // request's VALUE (not identity) keeps the quote from re-firing every render.
  const bodyKey = JSON.stringify(body ?? {});
  const cb = useRef({ onClose, onDone });
  cb.current = { onClose, onDone };

  const send = useCallback(
    (confirm) =>
      apiCall(path, json(method, { ...JSON.parse(bodyKey), ...(confirm ? { confirm: true } : {}) })),
    [path, method, bodyKey],
  );

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await send(false);
      if (!live) return;
      // 402 carries a price quote; 409 + requiresConfirmation is the same gate
      // without one (forgetting a still-billing instance), and must not be
      // mistaken for a hard failure.
      if (res.status === 402 || res.data.requiresConfirmation === true) {
        setQuote(res.data.quote || null);
        setNote(res.data.quote?.note || res.data.error || null);
        setPhase("ready");
      } else if (res.ok) {
        // The endpoint did not need confirmation after all (a free action).
        cb.current.onDone?.(res.data);
        cb.current.onClose();
      } else {
        setError(res.data.error || `request failed (${res.status})`);
        setPhase("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [send]);

  const commit = async () => {
    setPhase("committing");
    const res = await send(true);
    if (res.ok) {
      onDone?.(res.data);
      if (res.data.warning) notify?.(res.data.warning);
      onClose();
    } else {
      setError(res.data.error || `request failed (${res.status})`);
      setPhase("error");
    }
  };

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <span className="modal-foot-spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "btn btn--danger-solid" : "btn btn--primary"}
            disabled={phase !== "ready"}
            onClick={commit}
          >
            {phase === "committing" ? "Working…" : actionLabel}
          </button>
        </>
      }
    >
      <div className="field-stack">
        {description && <div className="panel-note">{description}</div>}
        {phase === "quoting" && (
          <div className="panel-note">
            <span className="spinner" /> Asking the bridge for a current quote…
          </div>
        )}
        {quote && (
          <div className={danger ? "notice notice--warn" : "notice notice--cost"}>
            <div className="notice-title">What this costs</div>
            <QuoteTable quote={quote} />
          </div>
        )}
        {note && <div className="panel-note">{note}</div>}
        {error && <div className="notice notice--warn">{error}</div>}
      </div>
    </Modal>
  );
}
