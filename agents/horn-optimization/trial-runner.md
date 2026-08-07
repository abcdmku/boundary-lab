# Horn-optimization trial-runner playbook

Provider-neutral instructions for the **trial-runner** role of a horn-optimization
campaign (see `orchestrator.md` for the loop and state layout). The trial-runner is a
procedural executor: it runs exactly ONE trial end to end and records exactly ONE line in
`trials.jsonl`. No design decisions — the params are given.

Inputs from the orchestrator: campaign name, trial number, stage
(`screen`/`refine`/`verify`), and the complete generator params JSON (the designer has
already merged `spec.fixed_params` in). Read `runs/campaigns/<name>/spec.json` yourself
for everything else — in particular the generator id (`spec.generator`), the mesh gates
(`spec.mesh`), and the solve settings. Pass your absolute working directory as
`workspace` on every MCP call.

Preflight: confirm `spec.json` exists and that `trials.jsonl` (if present) does not
already contain a line for this trial number — if it does, stop and report instead of
writing a duplicate. For `verify` trials: overlay `spec.mesh_verify_params` (if present)
onto the given params before generating — these are resolution-only generator parameters
that refine the mesh without touching the champion's geometry.

**The overlay is a floor, not a replacement.** Apply each override only where it makes the
mesh *finer* than the champion's own value; if the champion is already finer on that
parameter, keep the champion's value. For segment/subdivision counts (`angular_segments`,
`*_segments` — higher is finer) that means `max(champion, override)`; for a
spacing-style parameter (element size — lower is finer) it means `min(champion, override)`;
for `outer_coarsen` (higher is coarser) it means `min(champion, override)`. Read the
parameter's schema `description` if the direction is not obvious. A verification that
came out coarser than the trial it is confirming proves nothing, and can even fail the
`min_triangles` floor. Note in the trial `note` whenever you kept a champion value in
preference to an override. Generation never refuses a mesh for its size, so a verify mesh may be as fine
as the spec's verify gates allow; the `generate` result carries a `vramEstimate` per
symmetry option, and `solve` warns (never blocks) if that estimate exceeds the local
GPU's VRAM. Use `spec.solve_verify` instead of `spec.solve`,
`spec.mesh.verify_max_triangles` (if present) instead of `spec.mesh.max_triangles`, and
`spec.solve_verify_timeout_min` (default 3 × `solve_timeout_min`) as the timeout — fine
meshes can legitimately take an hour or more.

Work from the repository root that hosts the live bridge — `bridge/data/jobs/<jobId>/`
is the bridge's job store, and the `score` command below resolves paths relative to that
root.

## Steps

### (a) Generate and gate the mesh

Call the `generate` MCP tool with `generator` = `spec.generator`, the given params, plus
`workspace` and a `name` like `<campaign> t<trial>`. Record `jobId` (this is
`mesh_job_id`) and `triangles`. Generation is normally seconds; if the tool returns
"still running after 120 s", poll `get_job` with ~30 s waits, and treat anything past ~5
more minutes as a failed trial.

Gate — record a failure line (step d) and **skip the solve entirely** if any of:

- **Triangle gates use the *effective solved* count**, not the raw `triangles` value:
  with `symmetry` `"x"` the solver receives the reduced half-mesh, with `"xy"` the
  quarter-mesh, so `effective = triangles / 1|2|4` for `off`/`x`/`xy` (from the spec's
  solve block for this stage). Solve cost and fidelity follow the mesh actually sent to
  the solver — gating the full-mesh count would let a quadrant solve slip under the
  anti-gaming floor.
  - `effective` > `spec.mesh.max_triangles` (default 9000) — a per-campaign *time*
    budget, not a hardware limit: nothing below this layer refuses a large mesh
    (~13.6k ≈ 1 h+ on this GPU; the queue is shared), so keeping iteration meshes small
    is what makes the campaign finish. Raise it deliberately per campaign if you are
    willing to pay for the wall-clock;
  - `effective` < `spec.mesh.min_triangles` (default 3000) — anti-gaming floor: a solve
    this coarse produces flattering, untrustworthy scores;
- `bboxMm` from the generate result exceeds `spec.objective.size_limit_mm` (width,
  height, or depth) — the scorer penalizes but does not refuse an oversized envelope, so
  such a design would otherwise be free to become champion. `bboxMm` is the **outer**
  box, which for `slot_cd_horn` is larger than `mouth_width`/`mouth_height` by the shell
  margin (see `designer.md` → "Size budgeting"); the generate result also carries
  `estimatedBboxMm`, the closed-form prediction of the same number;
- `triangles` or `bboxMm` is null/missing — the gates cannot be verified;
- `qualityWarning` is non-null in the generate result;
- the generate job itself failed (record its `jobId` as `mesh_job_id` if one was
  returned; `mesh_job_id` is null only when no job id exists at all).

If several gates fire, list all reasons in the `note`. Record the raw `triangles` value
in the trial line (provenance is per-campaign, so symmetry — and thus the effective
factor — is constant across comparable trials).

### (b) Solve, poll, timeout

Call the `solve` MCP tool with `mesh_job_id` and the spec's solve block
(`fmin`, `fmax`, `count`, `backend`, `symmetry` from `spec.solve` — or `spec.solve_verify`
for verify trials), plus `workspace` and a name. If the spec's solve block carries a
`target`, pass it through verbatim; otherwise omit it and the solve runs on the local
GPU. Do NOT use `create_solve_jobs` here — a trial is exactly one solve, and batching
would break the one-trial-in-flight rule. It returns immediately with `jobId` (this is
`solve_job_id`) and a queue position.

Then poll `get_job` with **~30-second sleeps** between calls (use your harness's wait
facility, e.g. a shell `sleep 30`) until `status` is terminal (`done` / `failed` /
`cancelled`):

> **Why the sleep is load-bearing — do not "optimize" it away.** Solve-completion
> wake-ups only reach live t3 threads. Subagents (and most harnesses running this
> playbook) get NO wake-up: polling is the only way to learn the solve finished. Solves
> take minutes to tens of minutes; a tight polling loop burns tokens and hammers the
> bridge for zero information gain. Keep the ~30 s spacing. Do not tighten it, do not
> remove it, do not busy-wait.

**Timeout:** the clock starts when the `solve` call returns; queue wait counts (a
cancelled queued job frees the lane either way). If the job is not terminal after
`spec.solve_timeout_min` minutes (default 20; the verify-trial override above applies) —
at ~30 s spacing that is about `2 × timeout_min` polls — stop waiting, then cancel the
job to free the GPU lane
via the bridge HTTP API (there is deliberately **no cancel MCP tool** — do not invent
one):

```
curl -X POST http://127.0.0.1:4821/api/jobs/<solve_job_id>/cancel
```

Confirm with one more `get_job` that the job reached a terminal status. If the cancel
request fails or the bridge is unreachable, say so prominently in your report — the
orchestrator must not start another trial until the lane is confirmed free. Either way,
record a timeout failure line (step d) with `score: null` and a note like
`solve timeout after 20 min — cancelled`.

**Terminal statuses:** only `done` proceeds to scoring. `cancelled` (by anyone) or
`failed` → failure line, with one exception: if the status is `failed` and the error
text explicitly indicates the job was interrupted by a bridge restart, ONE retry is
allowed — re-queue the same solve once (same `mesh_job_id`, same settings; timeout clock
restarts) and resume polling. Record the retry's `solve_job_id` in the trial line and
mention the first attempt's id in the `note`. If in doubt whether the error is a restart,
do not retry. If after a restart the mesh job id is no longer known to the bridge,
that is a failed trial — do not re-generate.

### (c) Score and rescan

> The `score` subcommand and the rescan endpoint below are delivered by the scoring work
> stream (they are contracts, not yet on every branch). If either is missing on your
> checkout, campaigns cannot run yet — stop and report rather than improvising a scorer.

When the solve is `done`, from the repository root:

```
python bridge/py/blabctl.py score --solve-run bridge/data/jobs/<solve_job_id> --mesh-run bridge/data/jobs/<mesh_job_id> --spec runs/campaigns/<name>/spec.json
```

The campaign `spec.json` goes in **unchanged** — the scorer reads its `objective` block
directly, so there is nothing to translate or duplicate. If it errors with
`spec must contain an "objective" object`, the spec is malformed, not the solve: report
the scorer's message (it names the exact shape) and record a failed trial; never edit a
frozen spec yourself.

This writes `metrics.json` (score, subscores, key metrics, per-frequency arrays) into the
solve job directory. A subscore that could not be measured from the data is `null` there,
not 1.0 — it is named in `unmeasured_subscores`, its weight is dropped from the score,
and the reason is in `warnings` (also printed as a `score` progress line). Copy the nulls
through into `trials.jsonl` and mention any warning in the `note`; the trial is still
`ok`. Then tell the bridge to pick up the new artifacts:

```
curl -X POST http://127.0.0.1:4821/api/jobs/<solve_job_id>/rescan
```

If scoring fails, that is a failed trial (`score: null`, note the scorer error) — do not
improvise a score from plots. If scoring succeeded but the rescan request fails, the
trial is still `ok` — mention the rescan failure in the `note` and your report.

### (d) Record exactly one line in trials.jsonl

Append ONE compact single-line JSON object (newline-terminated) to
`runs/campaigns/<name>/trials.jsonl`, creating the file if this is trial 1. You are the
only writer and trials are strictly sequential, so append-only is safe — but never
rewrite existing lines, and keep the object on one line.

```
{"trial": <n>, "ts": "<ISO-8601 UTC>", "stage": "<stage>", "params": {…}, "mesh_job_id": "…"|null, "solve_job_id": "…"|null, "triangles": <int>|null, "solve_settings": {…}|null, "score": <float>|null, "subscores": {…}|null, "key_metrics": {"h_bw_mean_dev_deg": …, "v_bw_mean_dev_deg": …, "h_bw_rms_dev_deg": …, "v_bw_rms_dev_deg": …, "h_within_tol_fraction": …, "v_within_tol_fraction": …, "spdi_rms_d2_db": …, "ripple_pp_db": …, "bbox_mm": […]}|null, "status": "ok"|"failed", "note": "…"}
```

- `score` and `subscores` are copied from `metrics.json` verbatim (`subscores` keeps all
  four keys `coverage`, `di_smoothness`, `on_axis_ripple`, `size`, nulls included).
- `key_metrics` is a flat digest of `metrics.json`, one field per line below. If a source
  field is missing or null, null that key — not the whole object.

  | key_metrics key         | metrics.json path                                    |
  | ----------------------- | ---------------------------------------------------- |
  | `h_bw_mean_dev_deg`     | `coverage.horizontal.mean_dev_deg`                   |
  | `v_bw_mean_dev_deg`     | `coverage.vertical.mean_dev_deg`                     |
  | `h_bw_rms_dev_deg`      | `coverage.horizontal.rms_dev_deg`                    |
  | `v_bw_rms_dev_deg`      | `coverage.vertical.rms_dev_deg`                      |
  | `h_within_tol_fraction` | `coverage.horizontal.within_tolerance_fraction`      |
  | `v_within_tol_fraction` | `coverage.vertical.within_tolerance_fraction`        |
  | `spdi_rms_d2_db`        | `di_smoothness.spdi_rms_d2_db`                       |
  | `ripple_pp_db`          | `on_axis_ripple.peak_to_peak_db` (null if unmeasured) |
  | `bbox_mm`               | `[size.dimensions.width_mm, .height_mm, .depth_mm]`  |

  The per-frequency arrays (`coverage.*.freq_hz` / `beamwidth_deg`, `di_smoothness.*`)
  stay in `metrics.json` — the designer reads them there. Never copy them into a trial
  line.
- `solve_settings` is exactly the solve block used (`fmin`, `fmax`, `count`, `backend`,
  `symmetry`, and `target` when the spec set one) — `spec.solve_verify` for verify trials
  (the `stage` field marks which).
- Failures of any kind use `status: "failed"` and `score: null` — **never 0** (a zero is
  a real, terrible score; null is "no score exists").
- Fields that never happened are null (e.g. `solve_job_id` and `solve_settings` when the
  mesh gate failed). A timed-out or failed solve DID happen: keep `solve_job_id`,
  `solve_settings`, and `triangles`.

### (e) Report

Return a report of **at most 10 lines**: trial number, stage, status, score and
subscores (or the failure reason), triangle count, job ids, and the preview/plot URLs
from `get_job` (on failed trials, the mesh preview URL if one exists). **Never paste
polar/beamwidth/frequency arrays or file dumps** — URLs and scalars only.
