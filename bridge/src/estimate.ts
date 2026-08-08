/**
 * "How long, and when will it be clear?"
 *
 * A schedule board is only useful if the cards carry time. This module answers
 * two questions and refuses to answer them badly:
 *
 *   1. estimateJob(job)    — seconds this job still needs
 *   2. laneForecast(...)   — when each waiting job starts and finishes, given
 *                            the lane's slot count and what is running now
 *
 * There is no hardcoded performance model, because there cannot be a useful
 * one. A BEM solve's cost is roughly O(triangles^2) per frequency point while
 * everything fits in VRAM, and then falls off a cliff when it does not (this
 * machine: 6.8k triangles ≈ 30 s, 13.6k ≈ an hour). A closed-form curve fitted
 * across that discontinuity is worse than no number at all.
 *
 * So the estimate is measured, not modelled:
 *
 *   - A RUNNING job with progress counters is timed directly. Once one
 *     frequency point has landed, elapsed/done × total is the truth, and
 *     nothing derived beats it.
 *   - A WAITING job is scaled from the most similar solve this bridge has
 *     actually finished — nearest neighbour in log(triangles), scaled linearly
 *     by frequency count and quadratically by triangles. Locally, near a
 *     sample of the same size, that scaling is right; globally it is never
 *     asked to extrapolate across the cliff, because the nearest neighbour is
 *     picked first.
 *   - With no comparable history at all, the answer is `null`. The UI shows
 *     "—", not a made-up clock.
 *
 * Every estimate carries its `basis` so the UI can show how much to trust it.
 */
import * as store from "./store.ts";

/** blabctl's own default for `solve --count`. Mirrors bridge/py/blabctl.py. */
const DEFAULT_FREQ_COUNT = 24;

/** Below this many finished samples an estimate is labelled `weak`. */
const CONFIDENT_SAMPLES = 3;

export type EstimateBasis =
  | "measured" // running, timed from its own progress counters
  | "history" // scaled from finished solves on the same target
  | "cross-target" // scaled from finished solves on a different target
  | "elapsed" // running, no counters — only "it has been going N s"
  | "none";

export interface Estimate {
  /** Seconds of work REMAINING, or null when nothing can be said. */
  remainingSeconds: number | null;
  /** Seconds the whole job is expected to take end to end, or null. */
  totalSeconds: number | null;
  basis: EstimateBasis;
  /** True when the estimate rests on fewer than CONFIDENT_SAMPLES samples. */
  weak: boolean;
}

const NO_ESTIMATE: Estimate = {
  remainingSeconds: null,
  totalSeconds: null,
  basis: "none",
  weak: true,
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Triangle count of the mesh a job is (or reads), from the generate summary. */
export function trianglesFor(job: store.Job): number | null {
  const mesh =
    job.kind === "mesh"
      ? job
      : store.getJob(String(job.parentJobId ?? job.params?.meshJobId ?? ""));
  const summary = asRecord(mesh?.summary);
  if (!summary) return null;
  return num(summary.triangles) ?? num(summary.n_triangles);
}

/** Frequency points a solve will compute. */
export const freqCountFor = (job: store.Job): number =>
  num(job.params?.count) ?? DEFAULT_FREQ_COUNT;

/**
 * The size knob a solve's cost actually turns on. Not a time — just a number
 * two solves can be compared by.
 */
const workUnits = (triangles: number, count: number) => triangles * triangles * count;

/** Wall-clock seconds a finished job took, or null if it was never timed. */
export function durationSeconds(job: store.Job): number | null {
  if (!job.startedAt || !job.finishedAt) return null;
  const ms = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
}

const targetIdOf = (job: store.Job): string =>
  !job.target || job.target.type === "local"
    ? "local"
    : (job.target.instanceId ?? job.target.serverUrl);

interface Sample {
  targetId: string;
  triangles: number;
  count: number;
  seconds: number;
}

/**
 * Finished solves worth learning from. Rebuilt per call rather than cached:
 * the ledger is small (hundreds of jobs), and a stale cache showing yesterday's
 * throughput on a box that has since been resized is a worse trade than the
 * scan.
 */
function samples(): Sample[] {
  const out: Sample[] = [];
  for (const job of store.listJobs()) {
    if (job.kind !== "solve" || job.status !== "done") continue;
    const seconds = durationSeconds(job);
    const triangles = trianglesFor(job);
    if (seconds === null || triangles === null || triangles <= 0) continue;
    out.push({ targetId: targetIdOf(job), triangles, count: freqCountFor(job), seconds });
  }
  return out;
}

/**
 * Scale one measured solve to a different size. Assembly of the dense
 * operators dominates and is quadratic in the element count; every frequency
 * point pays it again, hence linear in `count`.
 */
const scale = (sample: Sample, triangles: number, count: number) =>
  sample.seconds * (workUnits(triangles, count) / workUnits(sample.triangles, sample.count));

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * Predict a solve's total runtime from history. Prefers the same target (a
 * rented H100 and this desktop are not interchangeable), then the three
 * nearest samples by mesh size so the quadratic scaling is only ever asked to
 * interpolate locally.
 */
function predictFromHistory(
  triangles: number,
  count: number,
  targetId: string,
  pool: Sample[],
): { seconds: number; basis: EstimateBasis; used: number } | null {
  const sameTarget = pool.filter((s) => s.targetId === targetId);
  const [set, basis]: [Sample[], EstimateBasis] =
    sameTarget.length > 0 ? [sameTarget, "history"] : [pool, "cross-target"];
  if (set.length === 0) return null;

  const nearest = [...set]
    .sort(
      (a, b) =>
        Math.abs(Math.log(a.triangles / triangles)) - Math.abs(Math.log(b.triangles / triangles)),
    )
    .slice(0, 3);
  return {
    seconds: median(nearest.map((s) => scale(s, triangles, count))),
    basis,
    used: nearest.length,
  };
}

/**
 * What is left of one job. Mesh jobs are deliberately not modelled — they take
 * seconds and their own 5-minute timeout is the only bound that matters.
 */
export function estimateJob(job: store.Job, pool = samples()): Estimate {
  if (store.TERMINAL.has(job.status)) return NO_ESTIMATE;

  // 1. The job is running and counting frequency points: time it directly.
  if (job.status === "running" && job.startedAt) {
    const elapsed = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
    const done = num(job.progress?.done);
    const total = num(job.progress?.total);
    if (done !== null && total !== null && done > 0 && total > 0 && elapsed > 0) {
      const totalSeconds = (elapsed / done) * total;
      return {
        remainingSeconds: Math.max(0, totalSeconds - elapsed),
        totalSeconds,
        basis: "measured",
        weak: done < 2,
      };
    }
  }

  if (job.kind !== "solve") return NO_ESTIMATE;

  const triangles = trianglesFor(job);
  const predicted =
    triangles !== null && triangles > 0
      ? predictFromHistory(triangles, freqCountFor(job), targetIdOf(job), pool)
      : null;

  if (predicted === null) {
    // Running with no counters and no comparable history: all that is honestly
    // known is how long it has been going.
    if (job.status === "running" && job.startedAt) {
      return {
        remainingSeconds: null,
        totalSeconds: null,
        basis: "elapsed",
        weak: true,
      };
    }
    return NO_ESTIMATE;
  }

  const elapsed =
    job.status === "running" && job.startedAt
      ? (Date.now() - new Date(job.startedAt).getTime()) / 1000
      : 0;
  return {
    remainingSeconds: Math.max(0, predicted.seconds - elapsed),
    totalSeconds: predicted.seconds,
    basis: predicted.basis,
    weak: predicted.used < CONFIDENT_SAMPLES,
  };
}

export interface ForecastEntry {
  jobId: string;
  /** Seconds from now until this job starts (0 = already running). */
  startsInSeconds: number;
  /** Seconds from now until it finishes, or null when it cannot be estimated. */
  finishesInSeconds: number | null;
  remainingSeconds: number | null;
  basis: EstimateBasis;
}

export interface LaneForecast {
  /** Per job, in execution order: running first, then the waiting line. */
  entries: ForecastEntry[];
  /** Seconds until nothing is left in this lane, or null if any job is a blank. */
  clearInSeconds: number | null;
  /** Total work still parked in this lane, seconds; null when unknowable. */
  backlogSeconds: number | null;
}

/**
 * Walk a lane the way the queue will: `slots` jobs at a time, the running ones
 * already occupying their slots, each waiting job dropping into whichever slot
 * frees first.
 *
 * A job with no estimate does not poison the whole lane — it is scheduled with
 * zero assumed duration and reported as `finishesInSeconds: null`, and only
 * the lane's own `clearInSeconds` goes null to say "this line contains an
 * unknown". Anything else would make one unmeasurable job blank out the board.
 */
export function laneForecast(
  activeIds: string[],
  queuedIds: string[],
  slots: number,
  pool = samples(),
): LaneForecast {
  const entries: ForecastEntry[] = [];
  const freeAt: number[] = [];
  let anyUnknown = false;
  let backlog = 0;

  for (const jobId of activeIds) {
    const job = store.getJob(jobId);
    const est = job ? estimateJob(job, pool) : NO_ESTIMATE;
    const remaining = est.remainingSeconds;
    if (remaining === null) anyUnknown = true;
    else backlog += remaining;
    freeAt.push(remaining ?? 0);
    entries.push({
      jobId,
      startsInSeconds: 0,
      finishesInSeconds: remaining,
      remainingSeconds: remaining,
      basis: est.basis,
    });
  }
  // Empty slots are free right now.
  while (freeAt.length < Math.max(1, slots)) freeAt.push(0);

  for (const jobId of queuedIds) {
    const job = store.getJob(jobId);
    const est = job ? estimateJob(job, pool) : NO_ESTIMATE;
    const duration = est.totalSeconds;
    if (duration === null) anyUnknown = true;
    else backlog += duration;
    // Next slot to free is the one this job actually lands in.
    let slot = 0;
    for (let i = 1; i < freeAt.length; i++) if (freeAt[i]! < freeAt[slot]!) slot = i;
    const startsInSeconds = freeAt[slot]!;
    freeAt[slot] = startsInSeconds + (duration ?? 0);
    entries.push({
      jobId,
      startsInSeconds,
      finishesInSeconds: duration === null ? null : startsInSeconds + duration,
      remainingSeconds: duration,
      basis: est.basis,
    });
  }

  return {
    entries,
    clearInSeconds: anyUnknown ? null : Math.max(0, ...freeAt),
    backlogSeconds: anyUnknown ? null : backlog,
  };
}

/**
 * Throughput headline for a target: how many solves it has finished and the
 * median wall-clock time of the last few. Used for the column subtitle on the
 * schedule board — a number the human can sanity-check the ETAs against.
 */
export function targetThroughput(targetId: string): {
  finished: number;
  medianSeconds: number | null;
} {
  const mine = samples().filter((s) => s.targetId === targetId);
  return {
    finished: mine.length,
    medianSeconds: mine.length ? median(mine.slice(-10).map((s) => s.seconds)) : null,
  };
}

/** Exported for tests and for callers that forecast several lanes at once. */
export const historySamples = samples;
