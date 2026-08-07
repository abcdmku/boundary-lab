import { LanesPanel } from "../queue/LanesPanel.jsx";
import { TargetsPanel } from "./TargetsPanel.jsx";
import { VastPanel } from "./VastPanel.jsx";
import { fmtRate } from "../../lib/format";
import "./compute.css";

/**
 * Everything about WHERE work runs, in one column: what is billing, which
 * targets exist and why some cannot be selected, what occupies each lane, and
 * the vast.ai rental surface.
 */
export function ComputeView({ state, refetch, notify, onNavigateJob }) {
  const targets = state?.targets || [];
  const lanes = state?.queue?.lanes || [];
  const jobs = state?.jobs || [];
  const vast = state?.vast;
  const burn = vast?.activeBurnRatePerHour ?? 0;

  const available = targets.filter((t) => t.available).length;
  const running = lanes.reduce((n, l) => n + (l.active?.length || 0), 0);
  const queued = lanes.reduce((n, l) => n + (l.queued?.length || 0), 0);
  const slots = targets.reduce((n, t) => n + (t.available ? t.concurrency : 0), 0);

  return (
    <main className="compute-view">
      {burn > 0 && (
        <div className="burn-banner">
          <span className="burn-rate">{fmtRate(burn)}</span>
          <span className="burn-note">
            billing right now across{" "}
            {(vast?.instances || []).filter((i) => i.status !== "destroyed").length} rented
            instance(s). Only destroying an instance ends its charges.
          </span>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Compute</span>
        </div>
        <div className="stat-row">
          <div className="stat">
            <div className="stat-label">Targets</div>
            <div className="stat-value">
              {available}
              <span className="stat-value--muted" style={{ fontSize: 13 }}>
                {" "}
                / {targets.length}
              </span>
            </div>
            <div className="stat-sub">available</div>
          </div>
          <div className="stat">
            <div className="stat-label">Running</div>
            <div className="stat-value">
              {running}
              <span className="stat-value--muted" style={{ fontSize: 13 }}>
                {" "}
                / {slots}
              </span>
            </div>
            <div className="stat-sub">slots in use</div>
          </div>
          <div className="stat">
            <div className="stat-label">Queued</div>
            <div className="stat-value">{queued}</div>
            <div className="stat-sub">waiting for a slot</div>
          </div>
          <div className="stat">
            <div className="stat-label">Burn rate</div>
            <div className={"stat-value" + (burn > 0 ? " stat-value--cost" : " stat-value--muted")}>
              {fmtRate(burn)}
            </div>
            <div className="stat-sub">
              {burn > 0 ? "rented GPUs billing" : "nothing rented"}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Execution targets</span>
          <span className="panel-note">
            A target must be available before a job can be aimed at it.
          </span>
        </div>
        <div className="panel-body panel-body--flush">
          <TargetsPanel targets={targets} lanes={lanes} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Queue lanes</span>
          <span className="panel-note">One lane per kind and target — this is the parallelism.</span>
        </div>
        <div className="panel-body panel-body--flush">
          <LanesPanel lanes={lanes} jobs={jobs} onNavigate={onNavigateJob} />
        </div>
      </div>

      <VastPanel vast={vast} targets={targets} refetch={refetch} notify={notify} />
    </main>
  );
}
