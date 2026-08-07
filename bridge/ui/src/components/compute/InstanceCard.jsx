import { useState } from "react";
import { cn } from "../../lib/cn";
import { apiCall, json } from "../../lib/api";
import { fmtDuration, fmtMoney, fmtNum, fmtRate, relTime } from "../../lib/format";
import { ConfirmCostDialog } from "./ConfirmCostDialog.jsx";
import "./compute.css";

const STATUS_MOD = {
  ready: "instance-status--ready",
  renting: "instance-status--work",
  starting: "instance-status--work",
  provisioning: "instance-status--work",
  error: "instance-status--error",
};

/**
 * One rented box: what it is, what it has cost, whether it can take a solve,
 * and every lifecycle action the bridge exposes.
 *
 * Provisioning progress is live for free — registry mutations emit an SSE
 * change with no jobId, which the client turns into a full-state refetch, so
 * `instance.progress` re-renders here as the bootstrap walks its stages.
 */
export function InstanceCard({ instance: e, target, api, refetch, notify }) {
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(null);

  const live = e.live || {};
  const price = live.pricePerHour ?? e.pricePerHour;
  const billing = e.status !== "destroyed" && e.status !== "stopped";

  const act = (label, path, opts) => async () => {
    setBusy(label);
    const res = await apiCall(path, opts);
    setBusy(null);
    if (res.ok) {
      if (res.data.warning) notify?.(res.data.warning);
      if (res.data.note) notify?.(res.data.note);
      refetch();
    } else {
      notify?.(res.data.error || `${label} failed (${res.status})`);
    }
  };

  const health = e.lastHealth;

  return (
    <div className="instance">
      <div className="instance-head">
        <span className="instance-name">
          {e.gpuName}
          {e.numGpus > 1 ? ` ×${e.numGpus}` : ""}
        </span>
        <span className="instance-id">#{e.id}</span>
        <span className="instance-id">{e.label}</span>
        <span className={cn("instance-status", STATUS_MOD[e.status])}>{e.status}</span>
        <span className="instance-cost">
          {billing ? <b>{fmtRate(price)}</b> : <span>{fmtRate(price)} when running</span>}
          {live.estimatedCostUsd !== null && live.estimatedCostUsd !== undefined && (
            <div>
              {fmtMoney(live.estimatedCostUsd, 2)} spent · {fmtDuration(live.uptimeSeconds)} up
            </div>
          )}
        </span>
      </div>

      <div className="instance-grid">
        <div className="target-meta">
          target id <span className="mono">vast:{e.id}</span>
        </div>
        <div className="target-meta">disk {e.diskGb ?? "—"} GB</div>
        <div className="target-meta">solver port {e.solverPort}</div>
        <div className="target-meta">created {relTime(e.createdAt)}</div>
        {live.actualStatus && (
          <div className="target-meta">
            vast: {live.actualStatus}
            {live.intendedStatus && live.intendedStatus !== live.actualStatus
              ? ` → ${live.intendedStatus}`
              : ""}
          </div>
        )}
        {e.ssh && (
          <div className="target-meta">
            ssh {e.ssh.user}@{e.ssh.host}:{e.ssh.port}
            {e.ssh.direct ? "" : " (proxy)"}
          </div>
        )}
      </div>

      {e.serverUrl && <div className="target-url">{e.serverUrl}</div>}

      {e.progress && (
        <div className="provision-progress">
          <span className="spinner" />
          <span className="provision-stage">{e.progress.stage}</span>
          <span className="provision-msg">{e.progress.message}</span>
          <span className="lane-job-meta">{relTime(e.progress.at)}</span>
        </div>
      )}

      {health && (
        <div className={cn("health-line", !health.ok && "health-line--bad")}>
          health {health.ok ? "ok" : "failed"} · {relTime(health.checkedAt)}
          {health.latencyMs !== undefined && health.latencyMs !== null
            ? ` · ${fmtNum(health.latencyMs, 0)} ms`
            : ""}
          {health.solver ? ` · ${health.solver}` : ""}
          {health.backend ? ` / ${health.backend}` : ""}
          {health.error ? ` · ${health.error}` : ""}
        </div>
      )}
      {!health && e.status !== "destroyed" && (
        <div className="health-line">Never health-checked — not selectable as a target yet.</div>
      )}
      {e.error && <div className="health-line health-line--bad">{e.error}</div>}
      {target && !target.available && target.unavailableReason && (
        <div className="target-reason">{target.unavailableReason}</div>
      )}

      <div className="instance-actions">
        {e.status !== "destroyed" && (
          <>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy !== null || e.status === "provisioning" || e.status === "starting"}
              onClick={act(
                "provision",
                `/api/vast/instances/${e.id}/provision`,
                json("POST", {}),
              )}
              title="Install the solver and start `blab server`. Free — the rental is already billing."
            >
              {busy === "provision" ? "Starting…" : e.provisionedAt ? "Re-provision" : "Provision"}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy !== null || !e.serverUrl}
              onClick={act("health", `/api/vast/instances/${e.id}/health`, json("POST", {}))}
              title={e.serverUrl ? "Probe /health now" : "No server URL yet — provision it first"}
            >
              {busy === "health" ? "Probing…" : "Health check"}
            </button>
          </>
        )}
        {e.status === "stopped" && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              setConfirm({
                kind: "start",
                title: `Start instance ${e.id}`,
                description:
                  "Starting a stopped instance resumes full GPU billing, and its port mappings change — re-provision afterwards.",
                path: `/api/vast/instances/${e.id}/start`,
                method: "POST",
                actionLabel: "Start — resume billing",
              })
            }
          >
            Start
          </button>
        )}
        {billing && e.status !== "destroyed" && (
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy !== null}
            onClick={act("stop", `/api/vast/instances/${e.id}/stop`, json("POST", {}))}
            title="Halt the container. Storage keeps billing — only Destroy ends all charges."
          >
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
        )}
        {e.status !== "destroyed" && (
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={() =>
              setConfirm({
                kind: "destroy",
                title: `Destroy instance ${e.id}`,
                description:
                  "Irreversible. This is the only action that ends all billing; the cached Julia depot and venv on the instance disk go with it.",
                path: `/api/vast/instances/${e.id}`,
                method: "DELETE",
                actionLabel: "Destroy permanently",
                danger: true,
              })
            }
          >
            Destroy
          </button>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={busy !== null}
          onClick={
            // A destroyed instance needs no confirmation, so it would only
            // flash the dialog open and shut — call it straight through.
            e.status === "destroyed"
              ? act("forget", `/api/vast/instances/${e.id}/registry`, { method: "DELETE" })
              : () =>
                  setConfirm({
                    kind: "forget",
                    title: `Forget instance ${e.id}`,
                    description:
                      "Drops the local record only. The instance KEEPS BILLING on vast.ai and this bridge will lose track of it.",
                    path: `/api/vast/instances/${e.id}/registry`,
                    method: "DELETE",
                    actionLabel: "Forget locally",
                    danger: true,
                  })
          }
          title="Remove from this bridge's registry"
        >
          Forget
        </button>
      </div>

      {confirm && (
        <ConfirmCostDialog
          {...confirm}
          subtitle={`${e.gpuName} · ${e.label}`}
          body={{}}
          notify={notify}
          onDone={() => refetch()}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
