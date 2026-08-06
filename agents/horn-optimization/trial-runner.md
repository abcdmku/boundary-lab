# Horn-optimization trial-runner playbook

Provider-neutral instructions for the **trial-runner** role of a horn-optimization
campaign (see `orchestrator.md` for the loop and state layout). The trial-runner is a
procedural executor: it runs exactly ONE trial end to end and records exactly ONE line in
`trials.jsonl`. No design decisions — the params are given.

Inputs from the orchestrator: campaign name, trial number, stage
(`screen`/`refine`/`verify`), and the generator params JSON. Read
`runs/campaigns/<name>/spec.json` yourself for everything else. Pass your absolute
working directory as `workspace` on every MCP call.

For `verify` trials, use `spec.solve_verify` instead of `spec.solve`, and
`spec.mesh.verify_max_triangles` (if present) instead of `spec.mesh.max_triangles`.

## Steps

### (a) Generate and gate the mesh

Call the `generate` MCP tool with the given params (plus `workspace`, and a `name` like
`<campaign> t<trial>`). Record `runId` (this is `mesh_run_id`) and `triangles`. Generation
is normally seconds; if the tool returns "still running after 120 s", poll `get_run` with
~30 s sleeps, and treat anything past ~5 more minutes as a failed trial.

Gate — record a failure line (step d) and **skip the solve entirely** if any of:

- `triangles` > `spec.mesh.max_triangles` (default 9000) — too slow to iterate on
  (~13.6k ≈ 1 h+ on this GPU; the queue is shared);
- `triangles` < `spec.mesh.min_triangles` (default 3000) — anti-gaming floor: a mesh this
  coarse produces flattering, untrustworthy scores;
- `qualityWarning` is present in the generate result;
- the generate run itself failed.

### (b) Solve, poll, timeout

Call the `solve` MCP tool with `mesh_run_id` and the spec's solve block
(`fmin`, `fmax`, `count`, `backend`, `symmetry` from `spec.solve` — or `spec.solve_verify`
for verify trials), plus `workspace` and a name. It returns immediately with `runId`
(this is `solve_run_id`) and a queue position.

Then poll `get_run` with **~30-second sleeps** between calls until `status` is terminal
(`done` / `failed` / `cancelled`):

> **Why the sleep is load-bearing — do not "optimize" it away.** Solve-completion
> wake-ups only reach live t3 threads. Subagents (and most harnesses running this
> playbook) get NO wake-up: polling is the only way to learn the solve finished. Solves
> take minutes to tens of minutes; a tight polling loop burns tokens and hammers the
> bridge for zero information gain. Keep the ~30 s spacing. Do not tighten it, do not
> remove it, do not busy-wait.

**Timeout:** if the run is not terminal after `spec.solve_timeout_min` minutes (default
20), stop waiting, then cancel the run to free the GPU lane via the bridge HTTP API
(there is deliberately **no cancel MCP tool** — do not invent one):

```
curl -X POST http://127.0.0.1:4821/api/runs/<solve_run_id>/cancel
```

Record a timeout failure line (step d) with `score: null` and a note like
`solve timeout after 20 min — cancelled`.

If the solve ends `failed` with an error indicating it was interrupted by a bridge
restart, ONE retry is allowed: re-queue the same solve once and resume polling. Any other
failure → failure line, no retry.

### (c) Score and rescan

When the solve is `done`, from the repository root:

```
python bridge/py/blabctl.py score --solve-run bridge/data/runs/<solve_run_id> --mesh-run bridge/data/runs/<mesh_run_id> --spec runs/campaigns/<name>/spec.json
```

This writes `metrics.json` (score, subscores, key metrics, per-frequency arrays) into the
solve run directory. Then tell the bridge to pick up the new artifacts:

```
curl -X POST http://127.0.0.1:4821/api/runs/<solve_run_id>/rescan
```

If scoring fails, that is a failed trial (`score: null`, note the scorer error) — do not
improvise a score from plots.

### (d) Record exactly one line in trials.jsonl

Append ONE compact single-line JSON object to `runs/campaigns/<name>/trials.jsonl`. You
are the only writer and trials are strictly sequential, so append-only is safe — but
never rewrite existing lines, and keep the object on one line.

```
{"trial": <n>, "ts": "<ISO-8601 UTC>", "stage": "<stage>", "params": {…}, "mesh_run_id": "…", "solve_run_id": "…"|null, "triangles": <int>|null, "solve_settings": {…}|null, "score": <float>|null, "subscores": {…}|null, "key_metrics": {"h_bw_mean_deg": …, "v_bw_mean_deg": …, "h_bw_rms_dev": …, "v_bw_rms_dev": …, "spdi_rms_d2_db": …, "ripple_pp_db": …, "bbox_mm": […]}|null, "status": "ok"|"failed", "note": "…"}
```

- `score`, `subscores`, `key_metrics` come from the scorer's `metrics.json`.
- Failures of any kind use `status: "failed"` and `score: null` — **never 0** (a zero is
  a real, terrible score; null is "no score exists").
- Fields that never happened are null (e.g. `solve_run_id` when the mesh gate failed).

### (e) Report

Return a report of **at most 10 lines**: trial number, stage, status, score and
subscores (or the failure reason), triangle count, run ids, and the preview/plot URLs
from `get_run`. **Never paste polar/beamwidth/frequency arrays or file dumps** — URLs
and scalars only.
