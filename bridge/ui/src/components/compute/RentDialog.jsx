import { useState } from "react";
import { Modal } from "../ui/modal.jsx";
import { Checkbox, Field, NumberInput, TextInput } from "../ui/field.jsx";
import { QuoteTable } from "./ConfirmCostDialog.jsx";
import { apiCall, json } from "../../lib/api";
import { fmtMoney, fmtNum, fmtRate } from "../../lib/format";
import "./compute.css";

/**
 * Rent one offer. Three deliberate steps, never fewer:
 *
 *   1. configure the box (disk changes the price, so it must be settled first);
 *   2. "Get quote" sends the request WITHOUT `confirm` — the bridge re-fetches
 *      the offer upstream and answers 402 with the real, current price, or
 *      403 (over this bridge's ceiling) / 409 (offer gone);
 *   3. only then does the confirm button appear, labelled with that price.
 *
 * Editing anything after a quote invalidates it: the number on the button is
 * always the number the server just quoted for exactly this configuration.
 */
export function RentDialog({ offer, defaults, maxPricePerHour, onClose, onDone, notify }) {
  const [label, setLabel] = useState("boundary-lab-solver");
  const [diskGb, setDiskGb] = useState(defaults?.diskGb ?? 60);
  const [image, setImage] = useState(defaults?.image ?? "");
  const [provision, setProvision] = useState(true);
  const [quote, setQuote] = useState(null);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [phase, setPhase] = useState("configure");

  const bodyOf = (confirm) => ({
    offerId: offer.id,
    label: label.trim() || undefined,
    diskGb,
    image: image.trim() || undefined,
    provision,
    ...(confirm ? { confirm: true } : {}),
  });

  const invalidate = (fn) => (v) => {
    setQuote(null);
    setNote(null);
    setError(null);
    setPhase("configure");
    fn(v);
  };

  const getQuote = async () => {
    setPhase("quoting");
    setError(null);
    const res = await apiCall("/api/vast/instances", json("POST", bodyOf(false)));
    if (res.status === 402) {
      setQuote(res.data.quote || {});
      setNote(res.data.quote?.note || null);
      setPhase("quoted");
    } else if (res.ok) {
      // Should not happen — the route requires confirm — but never silently
      // treat a 2xx as "nothing was rented".
      notify?.(res.data.warning || "Instance created.");
      onDone?.(res.data);
      onClose();
    } else {
      // 403 (over this bridge's ceiling) and 409 (offer already gone) both
      // carry a self-explanatory message from the server; show it verbatim and
      // stay in the configure phase so nothing can be committed.
      setError(res.data.error || `quote failed (${res.status})`);
      setPhase("configure");
    }
  };

  const rent = async () => {
    setPhase("renting");
    const res = await apiCall("/api/vast/instances", json("POST", bodyOf(true)));
    if (res.ok) {
      notify?.(res.data.warning || `Instance ${res.data.instance?.id} is now billing.`);
      onDone?.(res.data);
      onClose();
    } else {
      setError(res.data.error || `rent failed (${res.status})`);
      setPhase("quoted");
    }
  };

  return (
    <Modal
      title={`Rent ${offer.gpuName}${offer.numGpus > 1 ? ` ×${offer.numGpus}` : ""}`}
      subtitle={`offer ${offer.id} · ${offer.geolocation || "unknown region"} · ${fmtRate(offer.pricePerHour)} listed`}
      onClose={onClose}
      footer={
        <>
          <span className="panel-note">
            Ceiling {fmtMoney(maxPricePerHour, 2)}/hr (VAST_MAX_PRICE_PER_HOUR)
          </span>
          <span className="modal-foot-spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          {phase === "quoted" || phase === "renting" ? (
            <button
              type="button"
              className="btn btn--danger-solid"
              disabled={phase === "renting"}
              onClick={rent}
            >
              {phase === "renting"
                ? "Renting…"
                : `Rent — ${fmtRate(quote?.pricePerHour ?? offer.pricePerHour)}`}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={phase === "quoting"}
              onClick={getQuote}
            >
              {phase === "quoting" ? "Getting quote…" : "Get quote"}
            </button>
          )}
        </>
      }
    >
      <div className="field-stack">
        <div className="notice">
          <div className="notice-title">This machine</div>
          {offer.gpuName}
          {offer.numGpus > 1 ? ` ×${offer.numGpus}` : ""} · {fmtNum(offer.gpuRamGb, 0)} GB VRAM each ·{" "}
          {offer.cpuCores ?? "?"} vCPU · {fmtNum(offer.cpuRamGb, 0)} GB RAM · CUDA{" "}
          {offer.cudaMaxGood ?? "?"} · reliability {fmtNum((offer.reliability ?? 0) * 100, 1)}% ·{" "}
          {offer.verified ? "verified host" : "unverified host"} · {offer.directPortCount ?? 0} direct
          ports
        </div>

        <div className="field-row field-row--2">
          <Field label="label" hint="shows up on the vast.ai console">
            <TextInput value={label} onChange={(e) => invalidate(setLabel)(e.target.value)} />
          </Field>
          <Field label="disk (GB)" hint="Julia depot + CUDA artifacts need ~30 GB; disk changes the price">
            <NumberInput value={diskGb} onValue={invalidate(setDiskGb)} min={10} step={10} />
          </Field>
        </div>
        <Field label="image" hint="CUDA runtime image the container boots">
          <TextInput value={image} onChange={(e) => invalidate(setImage)(e.target.value)} />
        </Field>
        <Checkbox
          label="Provision immediately (install the solver and start `blab server`)"
          checked={provision}
          onChange={(e) => setProvision(e.target.checked)}
        />

        {quote && (
          <div className="notice notice--cost">
            <div className="notice-title">Bridge quote — this is what you will be charged</div>
            <QuoteTable quote={quote} />
          </div>
        )}
        {note && <div className="panel-note">{note}</div>}
        {phase === "quoted" && (
          <div className="notice notice--warn">
            Billing starts as soon as the instance boots, and storage keeps billing while it is
            stopped. Only <b>Destroy</b> ends all charges.
          </div>
        )}
        {error && <div className="notice notice--warn">{error}</div>}
      </div>
    </Modal>
  );
}
