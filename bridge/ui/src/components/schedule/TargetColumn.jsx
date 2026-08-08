import { useRef } from "react";
import { JobCard } from "./JobCard.jsx";
import { SlotPips } from "./SlotPips.jsx";
import { cn } from "../../lib/cn";
import { fmtClock, fmtRate, fmtShort } from "../../lib/format";

/**
 * The forecast, drawn.
 *
 * One bar per column: each job a segment as wide as the time it will take,
 * running work solid, waiting work hatched. It is the only place on the board
 * that shows the SHAPE of a queue — that four short solves and one long one
 * are not the same five jobs — and it costs no words at all.
 */
function LaneTimeline({ column, onHover, hovered }) {
  const parts = [
    ...column.running.map((e) => ({ e, live: true })),
    ...column.waitingSolves.map((e) => ({ e, live: false })),
  ]
    .map(({ e, live }) => ({
      e,
      live,
      seconds: live
        ? (e.estimate?.remainingSeconds ?? null)
        : (e.forecast?.remainingSeconds ?? e.estimate?.totalSeconds ?? null),
    }))
    .filter((p) => p.seconds !== null && p.seconds > 0);

  if (parts.length === 0) return null;
  const total = parts.reduce((n, p) => n + p.seconds, 0);
  return (
    <div className="tl" aria-hidden>
      {parts.map(({ e, live, seconds }) => (
        <span
          key={e.job.id}
          className={cn("tl-seg", live && "tl-seg--live", hovered === e.job.id && "tl-seg--hover")}
          style={{ width: `${(100 * seconds) / total}%` }}
          title={`${e.job.name || e.job.id} — ${fmtShort(seconds)}`}
          onMouseEnter={() => onHover?.(e.job.id)}
          onMouseLeave={() => onHover?.(null)}
        />
      ))}
    </div>
  );
}

/**
 * One machine.
 *
 * Reads top to bottom the way the work flows: who it is and when it will be
 * free, its slots, the shape of its queue, what is in the slots right now,
 * then the line waiting. Dropping anywhere in the column aims a job at this
 * machine; dropping inside the waiting list also places it in the order.
 */
export function TargetColumn({
  column,
  drag,
  dropIndex,
  hovered,
  onHover,
  onDragOverList,
  onLeave,
  onDrop,
  onDragStart,
  onDragEnd,
  onMove,
  onOpen,
  onSetSlots,
  busy,
}) {
  const listRef = useRef(null);
  const { target } = column;
  const price = target.info?.pricePerHour;
  // A mesh job can never run anywhere but the bridge host, so a remote column
  // must not pretend to accept one.
  const accepts = drag && (target.id === "local" || drag.job.kind !== "mesh") && target.available;
  const isDropTarget = accepts && dropIndex?.column === target.id;

  const indexFromPointer = (clientY) => {
    const selector = drag?.job.kind === "mesh" ? "[data-jc-mesh]" : "[data-jc-solve]";
    const cards = [...(listRef.current?.querySelectorAll(selector) || [])];
    for (let i = 0; i < cards.length; i++) {
      const box = cards[i].getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return i;
    }
    return cards.length;
  };

  return (
    <section
      className={cn(
        "col",
        !target.available && "col--off",
        accepts && "col--accepts",
        isDropTarget && "col--over",
      )}
      aria-label={target.label}
      onDragOver={(e) => {
        if (!accepts) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOverList?.(target.id, indexFromPointer(e.clientY));
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        onLeave?.();
      }}
      onDrop={(e) => {
        if (!accepts) return;
        e.preventDefault();
        onDrop?.(target.id, indexFromPointer(e.clientY));
      }}
    >
      <header className="col-head">
        <span className={cn("col-dot", target.available && "col-dot--on")} aria-hidden />
        <span className="col-name" title={target.serverUrl || "this machine"}>
          {target.label}
        </span>
        {!target.available && <span className="col-off">{target.status || "off"}</span>}
        {price > 0 && <span className="col-price num">{fmtRate(price)}</span>}
      </header>
      <div className="col-spec num" title={target.id}>
        {[
          target.info?.gpuName
            ? `${target.info.gpuName}${target.info.numGpus > 1 ? ` ×${target.info.numGpus}` : ""}`
            : target.type === "local"
              ? "this machine"
              : target.id,
        ]}
      </div>

      <div className="col-meta num">
        {column.clearInSeconds !== null && column.clearInSeconds > 0 ? (
          <span title="When this machine expects to be free">
            free {fmtClock(column.clearInSeconds)}
          </span>
        ) : column.running.length ? (
          <span>running</span>
        ) : (
          <span className="col-meta--idle">idle</span>
        )}
        {target.throughput?.medianSeconds ? (
          <span title={`${target.throughput.finished} solves finished here`}>
            ~{fmtShort(target.throughput.medianSeconds)}/solve
          </span>
        ) : null}
      </div>

      {/* "Why can't I use the box I'm paying for" has to be answerable from
          the column itself — that question used to live in the targets panel,
          and it must not have been lost with it. */}
      {!target.available && (
        <p className="col-reason">
          {target.unavailableReason ||
            `${target.status || "Unavailable"} — cannot take work yet.`}
        </p>
      )}
      {target.info?.error && <p className="col-reason">{String(target.info.error)}</p>}

      <SlotPips column={column} onSetSlots={onSetSlots} disabled={busy} />
      <LaneTimeline column={column} onHover={onHover} hovered={hovered} />

      <ul className="col-slots" role="list">
        {column.running.map((entry) => (
          <JobCard
            key={entry.job.id}
            entry={entry}
            dragging={false}
            onOpen={onOpen}
            onMove={onMove}
            busy={busy}
          />
        ))}
        {Array.from({ length: Math.max(0, column.slots - column.slotsUsed) }, (_, i) => (
          <li key={`free-${i}`} className="col-free" aria-hidden />
        ))}
      </ul>

      <div
        ref={listRef}
        className={cn("col-wait", isDropTarget && "col-wait--over")}
        role="list"
        aria-label={`${target.label} waiting`}
      >
        {/* Mesh and solve queues are independent lanes. Count and draw the
            insertion point in the lane that matches the card being moved. */}
        {column.waitingMeshes.map((entry, i) => (
          <div key={entry.job.id} data-jc-mesh>
            {isDropTarget && drag?.job.kind === "mesh" && dropIndex.index === i && (
              <div className="drop-line" aria-hidden />
            )}
            <JobCard
              entry={entry}
              compact
              dragging={drag?.job.id === entry.job.id}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onMove={onMove}
              onOpen={onOpen}
              busy={busy}
            />
          </div>
        ))}
        {isDropTarget &&
          drag?.job.kind === "mesh" &&
          dropIndex.index >= column.waitingMeshes.length && (
            <div className="drop-line" aria-hidden />
          )}
        {column.waitingSolves.map((entry, i) => (
          <div key={entry.job.id} data-jc-solve>
            {isDropTarget && drag?.job.kind !== "mesh" && dropIndex.index === i && (
              <div className="drop-line" aria-hidden />
            )}
            <JobCard
              entry={entry}
              dragging={drag?.job.id === entry.job.id}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onMove={onMove}
              onOpen={onOpen}
              busy={busy}
            />
          </div>
        ))}
        {isDropTarget &&
          drag?.job.kind !== "mesh" &&
          dropIndex.index >= column.waitingSolves.length && (
            <div className="drop-line" aria-hidden />
          )}
        {column.running.length === 0 &&
          column.waitingSolves.length === 0 &&
          column.waitingMeshes.length === 0 && <div className="col-empty" aria-hidden />}
      </div>
    </section>
  );
}
