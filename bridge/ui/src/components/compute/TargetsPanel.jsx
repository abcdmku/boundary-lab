import { cn } from "../../lib/cn";
import { fmtRate } from "../../lib/format";
import "./compute.css";

/**
 * Every place a job can be sent, from GET /api/targets (mirrored into
 * /api/state). Unavailable targets are shown, never hidden: "why can't I pick
 * the box I'm paying for" must be answerable from this panel alone.
 */
export function TargetsPanel({ targets, lanes }) {
  const list = targets || [];
  const laneFor = (id) => (lanes || []).filter((l) => l.targetId === id);

  return (
    <div className="target-list">
      {list.map((t) => {
        const info = t.info || {};
        const myLanes = laneFor(t.id);
        const running = myLanes.reduce((n, l) => n + (l.active?.length || 0), 0);
        const queued = myLanes.reduce((n, l) => n + (l.queued?.length || 0), 0);
        return (
          <div key={t.id} className={cn("target-card", !t.available && "target-card--off")}>
            <div className="target-head">
              <span className="target-name">{t.label}</span>
              <span
                className={cn(
                  "target-badge",
                  t.available ? "target-badge--ok" : "target-badge--off",
                )}
              >
                {t.available ? (t.status ?? "ready") : (t.status ?? "unavailable")}
              </span>
            </div>
            <div className="target-meta">
              <span className="mono">{t.id}</span>
              {info.gpuName ? ` · ${info.gpuName}${info.numGpus > 1 ? ` ×${info.numGpus}` : ""}` : ""}
              {typeof info.pricePerHour === "number" && info.pricePerHour > 0
                ? ` · ${fmtRate(info.pricePerHour)}`
                : ""}
              {` · ${t.concurrency} slot${t.concurrency === 1 ? "" : "s"}`}
              {running || queued ? ` · ${running} running, ${queued} queued` : " · idle"}
            </div>
            {t.serverUrl && <div className="target-url">{t.serverUrl}</div>}
            {!t.available && (
              <div className="target-reason">
                {t.unavailableReason ||
                  `This target is "${t.status || "unavailable"}" and cannot take work yet.`}
              </div>
            )}
            {info.error && <div className="target-reason">{String(info.error)}</div>}
          </div>
        );
      })}
    </div>
  );
}
