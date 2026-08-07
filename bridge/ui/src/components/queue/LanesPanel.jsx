import { cn } from "../../lib/cn";
import { StatusDot } from "../jobs/StatusDot.jsx";
import "./queue.css";

/**
 * `queue.lanes` made visible.
 *
 * The whole point of picking targets per job is parallelism, and parallelism
 * you cannot see is indistinguishable from a stuck queue. One lane per
 * (kind, target): its concurrency as slots, what occupies them, and the line
 * waiting behind — so batching across local + N remotes reads at a glance.
 */

const laneDepth = (lane) => (lane.active?.length || 0) + (lane.queued?.length || 0);

export function LaneStrip({ lanes, onNavigate }) {
  const list = (lanes || []).filter((l) => laneDepth(l) > 0);
  if (!list.length) return null;
  return (
    <div className="lane-strip">
      {list.map((lane) => (
        <span
          key={lane.key}
          className={cn("lane-pill", lane.active?.length && "lane-pill--busy")}
          title={`${lane.label} — target ${lane.targetId}, concurrency ${lane.concurrency}`}
        >
          {lane.active?.length ? <StatusDot status="running" /> : null}
          <span className="lane-pill-label">{lane.label}</span>
          <span>
            {lane.active?.length || 0}/{lane.concurrency}
          </span>
          {lane.queued?.length > 0 && (
            <>
              <span className="lane-pill-sep">·</span>
              <span>{lane.queued.length} queued</span>
            </>
          )}
        </span>
      ))}
      {onNavigate && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onNavigate}>
          Queue →
        </button>
      )}
    </div>
  );
}

function LaneJob({ job, id, meta, onNavigate }) {
  return (
    <button type="button" className="lane-job" onClick={() => onNavigate?.(id)}>
      <StatusDot status={job ? job.status : "queued"} />
      <span className="lane-job-name">{job ? job.name || job.id : id}</span>
      <span className="lane-job-meta">{meta}</span>
    </button>
  );
}

export function LanesPanel({ lanes, jobs, onNavigate }) {
  const byId = new Map((jobs || []).map((j) => [j.id, j]));
  const list = lanes || [];
  if (!list.length) return <div className="panel-empty">No lanes yet.</div>;

  return (
    <div className="lane-list">
      {list.map((lane) => {
        const active = lane.active || [];
        const queued = lane.queued || [];
        const idle = active.length === 0 && queued.length === 0;
        return (
          <div key={lane.key} className={cn("lane", idle && "lane--idle")}>
            <div className="lane-title-row">
              <span className="lane-title">{lane.label}</span>
              <span className="lane-slots">
                {active.length}/{lane.concurrency} running
                {queued.length > 0 ? ` · ${queued.length} queued` : ""}
              </span>
            </div>
            <div className="lane-target">
              {lane.kind} · {lane.targetId}
            </div>
            <div className="lane-slot-bar" aria-hidden>
              {Array.from({ length: Math.max(lane.concurrency, 1) }, (_, i) => (
                <span key={i} className={cn("lane-slot", i < active.length && "lane-slot--on")} />
              ))}
            </div>
            {idle ? (
              <div className="lane-empty">Idle</div>
            ) : (
              <div className="lane-jobs">
                {active.map((id) => {
                  const job = byId.get(id);
                  const p = job?.progress;
                  return (
                    <LaneJob
                      key={id}
                      id={id}
                      job={job}
                      onNavigate={onNavigate}
                      meta={p && p.total ? `${p.done || 0}/${p.total}` : "running"}
                    />
                  );
                })}
                {queued.length > 0 && <div className="lane-queued-head">Waiting</div>}
                {queued.map((id, i) => (
                  <LaneJob
                    key={id}
                    id={id}
                    job={byId.get(id)}
                    onNavigate={onNavigate}
                    meta={`#${active.length + i + 1}`}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Lane + 1-based position for a job, derived from the same snapshot. */
export function queueInfoFor(lanes, jobId) {
  for (const lane of lanes || []) {
    const ids = [...(lane.active || []), ...(lane.queued || [])];
    const at = ids.indexOf(jobId);
    if (at >= 0) return { label: lane.label, position: at + 1, lane };
  }
  return null;
}
