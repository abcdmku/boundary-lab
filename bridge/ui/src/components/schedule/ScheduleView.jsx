import { useMemo, useRef, useState } from "react";
import { Layers, Server } from "lucide-react";
import { TargetColumn } from "./TargetColumn.jsx";
import { JobCard } from "./JobCard.jsx";
import { buildBoard, PLANNED } from "../../lib/board";
import { cn } from "../../lib/cn";
import { fmtClock, fmtRate, fmtShort } from "../../lib/format";
import { json } from "../../lib/api";
import "./schedule.css";

/**
 * The orchestration surface: everything that is planned, running or waiting,
 * across every machine, arranged by hand.
 *
 * The old batch dialog answered "create twelve jobs". It never answered the
 * question that actually gets asked — WHEN, WHERE and IN WHAT ORDER does this
 * run — so that decision was made implicitly at creation time and could not be
 * revisited. This board is that decision, and it is revisable: every card is
 * draggable until the moment it starts.
 *
 * Columns are machines. The left column is the backlog: configured work that
 * has not been handed to anything. Drag right to run it somewhere, drag left
 * to take it back. Nothing here destroys work — holding a queued job keeps its
 * configuration intact, which is why "I aimed the sweep at the wrong box" is
 * now a drag rather than a cancel-and-rebuild.
 *
 * Every move is one card, posted on its own. Two people (or a person and an
 * agent) rearranging at the same time merge instead of clobbering.
 */
export function ScheduleView({
  state,
  api,
  refetch,
  notify,
  onOpenJob,
  onOpenDialog,
  onOpenMachines,
}) {
  const board = useMemo(() => buildBoard(state), [state]);
  const [drag, setDrag] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [busy, setBusy] = useState(false);
  const liveRef = useRef(null);

  const burn = state?.vast?.activeBurnRatePerHour || 0;
  const { totals } = board;

  const announce = (message) => {
    if (liveRef.current) liveRef.current.textContent = message;
  };

  /** The one write path: post a move, let SSE bring the truth back. */
  const move = async (jobId, column, position) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api(
        "/api/schedule",
        json("POST", { moves: [{ jobId, column, ...(position !== undefined ? { position } : {}) }] }),
      );
      const skipped = res?.skipped || [];
      if (skipped.length) notify?.(skipped[0].reason);
      else announce(column === PLANNED ? "Held in planned" : `Moved to ${column}`);
      refetch();
    } catch {
      /* apiRequest toasted it */
    } finally {
      setBusy(false);
      setDrag(null);
      setDropIndex(null);
    }
  };

  const setSlots = async (target, slots) => {
    if (busy) return;
    const current = target.concurrency || 1;
    const pinned = target.devices?.length || 0;
    if (
      slots > current &&
      pinned < slots &&
      !window.confirm(
        `Run ${slots} solves at once on ${target.label}? They will share GPU memory, ` +
          "so a solve that fits alone can fail alongside another.",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await api(
        `/api/targets/${encodeURIComponent(target.id)}`,
        json("PATCH", { slots }),
      );
      if (res?.warning) notify?.(res.warning);
      refetch();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  const columnIdOf = (entry) => {
    const t = entry.job.target;
    return !t || t.type === "local" ? "local" : t.instanceId || t.serverUrl;
  };

  /**
   * Alt+arrows, doing exactly what a drag does. Left/right walk the columns in
   * the order they are drawn; up/down step through the waiting line.
   */
  const keyboardMove = (entry, dir) => {
    const columns = [PLANNED, ...board.columns.map((c) => c.id)];
    const current = entry.job.status === "draft" ? PLANNED : entry.lane ? columnIdOf(entry) : PLANNED;
    const at = columns.indexOf(current);
    if (dir === "left" || dir === "right") {
      const step = dir === "left" ? -1 : 1;
      let nextAt = at + step;
      while (nextAt >= 0 && nextAt < columns.length) {
        const candidate = columns[nextAt];
        if (candidate === PLANNED) break;
        const target = board.columns.find((c) => c.id === candidate)?.target;
        if (target?.available && (entry.job.kind !== "mesh" || target.id === "local")) break;
        nextAt += step;
      }
      const next = columns[nextAt];
      if (next === undefined) return;
      void move(entry.job.id, next);
      return;
    }
    const column = board.columns.find((c) => c.id === current);
    const list =
      current === PLANNED
        ? board.planned
        : entry.job.kind === "mesh"
          ? (column?.waitingMeshes ?? [])
          : (column?.waitingSolves ?? []);
    const index = list.findIndex((e) => e.job.id === entry.job.id);
    if (index < 0) return; // running jobs do not have a position to step through
    const to = dir === "up" ? index - 1 : index + 1;
    if (to < 0 || to >= list.length) return;
    void move(entry.job.id, current, to);
  };

  const plannedAccepts = drag !== null;
  const plannedOver = plannedAccepts && dropIndex?.column === PLANNED;

  const indexFromPointer = (container, clientY) => {
    const cards = [...(container?.querySelectorAll("[data-jc]") || [])];
    for (let i = 0; i < cards.length; i++) {
      const box = cards[i].getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return i;
    }
    return cards.length;
  };
  const plannedRef = useRef(null);

  return (
    <main
      id="view-schedule"
      className="sched"
      role="tabpanel"
      aria-labelledby="view-tab-schedule"
    >
      <div className="sched-top">
        <div className="sched-stat">
          <span className="sched-stat-n num">{totals.running}</span>
          <span className="sched-stat-l">
            running
            <span className="sched-stat-of num">
              {" "}· {totals.solvesRunning}/{totals.slots} GPU slots
            </span>
          </span>
        </div>
        <div className="sched-stat">
          <span className="sched-stat-n num">{totals.queued}</span>
          <span className="sched-stat-l">queued</span>
        </div>
        <div className="sched-stat">
          <span className="sched-stat-n num">{totals.planned}</span>
          <span className="sched-stat-l">planned</span>
        </div>
        <div className="sched-stat">
          <span className="sched-stat-n num">
            {totals.clearInSeconds === null
              ? "—"
              : totals.clearInSeconds > 0
                ? fmtClock(totals.clearInSeconds)
                : "now"}
          </span>
          <span className="sched-stat-l">
            all clear
            {totals.clearInSeconds > 0 ? (
              <span className="sched-stat-of num"> {fmtShort(totals.clearInSeconds)}</span>
            ) : null}
          </span>
        </div>
        {burn > 0 && (
          <button
            type="button"
            className="sched-stat sched-stat--cost"
            onClick={onOpenMachines}
            title="Open Machines — only destroying an instance ends its charges"
          >
            <span className="sched-stat-n num">{fmtRate(burn)}</span>
            <span className="sched-stat-l">burning</span>
          </button>
        )}
        <span className="sched-top-spacer" />
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => onOpenDialog?.({ type: "batch", kind: "solve" })}
          title="Stage a set of solves — they land in Planned, then you arrange them here"
        >
          <Layers size={12} aria-hidden /> Plan solves
        </button>
      </div>

      <div className="sched-board">
        <section
          className={cn("col col--planned", plannedAccepts && "col--accepts", plannedOver && "col--over")}
          aria-label="Planned"
          onDragOver={(e) => {
            if (!plannedAccepts) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropIndex({ column: PLANNED, index: indexFromPointer(plannedRef.current, e.clientY) });
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget)) return;
            setDropIndex(null);
          }}
          onDrop={(e) => {
            if (!plannedAccepts) return;
            e.preventDefault();
            void move(drag.job.id, PLANNED, indexFromPointer(plannedRef.current, e.clientY));
          }}
        >
          <header className="col-head">
            <span className="col-dot col-dot--planned" aria-hidden />
            <span className="col-name">Planned</span>
          </header>
          <div className="col-meta num">
            <span>{board.planned.length} staged</span>
          </div>
          <div ref={plannedRef} className="col-wait" role="list" aria-label="Planned work">
            {board.planned.map((entry, i) => (
              <div key={entry.job.id} data-jc>
                {plannedOver && dropIndex.index === i && <div className="drop-line" aria-hidden />}
                <JobCard
                  entry={entry}
                  dragging={drag?.job.id === entry.job.id}
                  onDragStart={setDrag}
                  onDragEnd={() => {
                    setDrag(null);
                    setDropIndex(null);
                  }}
                  onMove={keyboardMove}
                  onOpen={onOpenJob}
                  busy={busy}
                />
              </div>
            ))}
            {plannedOver && dropIndex.index >= board.planned.length && (
              <div className="drop-line" aria-hidden />
            )}
            {board.planned.length === 0 && (
              <p className="col-hint">
                Nothing staged. <b>Plan solves</b> puts work here; drag it onto a machine to run it.
              </p>
            )}
          </div>
        </section>

        {board.columns.map((column) => (
          <TargetColumn
            key={column.id}
            column={column}
            drag={drag}
            dropIndex={dropIndex}
            hovered={hovered}
            busy={busy}
            onHover={setHovered}
            onDragOverList={(columnId, index) => setDropIndex({ column: columnId, index })}
            onLeave={() => setDropIndex(null)}
            onDrop={(columnId, index) => void move(drag.job.id, columnId, index)}
            onDragStart={setDrag}
            onDragEnd={() => {
              setDrag(null);
              setDropIndex(null);
            }}
            onMove={keyboardMove}
            onOpen={onOpenJob}
            onSetSlots={(slots) => void setSlots(column.target, slots)}
          />
        ))}

        {/* The board IS the machine list, so "get another machine" belongs on
            it as the empty slot at the end — not in a separate view whose
            other half repeated these columns. */}
        <button type="button" className="col col--add" onClick={onOpenMachines}>
          <span className="col-add-icon" aria-hidden>
            <Server size={16} />
          </span>
          <span className="col-name">Machine</span>
          <span className="col-hint">
            {burn > 0 ? `${fmtRate(burn)} billing · rent, adopt or release` : "Rent or adopt a GPU"}
          </span>
        </button>
      </div>

      <p className="sched-foot">
        Drag a card to choose its machine and place in line. Alt + arrows, or a card's Move menu on
        touch screens, do the same. A job that has already started cannot be moved.
      </p>
      <div ref={liveRef} className="sr-live" role="status" aria-live="polite" />
    </main>
  );
}
