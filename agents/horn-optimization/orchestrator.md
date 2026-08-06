# Horn-optimization orchestrator playbook

Provider-neutral instructions for running a horn/waveguide optimization campaign against
Boundary Lab through the Boundary Bridge. Any agent harness can execute this playbook;
harness-specific adapters (e.g. the Claude Code skill `.claude/skills/optimize-horn/`)
are thin wrappers that point here and add only wiring notes.

Companion role playbooks in this directory:

- `designer.md` — reads campaign history, proposes the next trial's parameters (or STOP).
- `trial-runner.md` — executes exactly one trial: generate → solve → score → record.

The orchestrator owns the loop and the campaign state on disk. It never designs geometry
and never runs solves itself.

## Role and hard rules

- **You coordinate; you never call `solve` yourself.** All mesh/solve/score work happens
  inside the trial-runner role. You never call `generate` either.
- **ONE trial in flight at any time.** The GPU runs one solve at a time (the bridge queue
  enforces this machine-wide). Never start a trial before the previous one has been fully
  recorded in `trials.jsonl`. The campaign is strictly sequential.
- **All state lives on disk** under `runs/campaigns/<name>/` (layout below). Every loop
  step re-reads the files it needs — never rely on conversation memory. This makes the
  loop work identically whether the roles run inline in a single agent or as separate
  subagents that forget everything between invocations.
- **Iteration meshes stay ≤ ~9k triangles** (see `spec.json` → `mesh.max_triangles`).
  Fine settings are reserved for the single final verification trial.
- Tools you refer to generically: the boundary-lab MCP tools (`list_generators`,
  `generate`, `solve`, `get_run`, `list_runs`), shell commands, and plain file
  reads/writes. Pass your absolute working directory as `workspace` on every MCP call.

## LOCK protocol

Exactly one orchestrator may drive a campaign directory at a time.

1. **Before doing anything else**, check for `runs/campaigns/<name>/LOCK`.
   - If it exists: read it and STOP. Report the holder and timestamp to the user, and ask
     them to check for a live campaign (bridge dashboard at http://127.0.0.1:4821 shows
     queued/running solves) before deleting a stale LOCK by hand. If the timestamp is
     less than ~2 hours old, assume the campaign is live. Never delete another run's
     LOCK yourself.
   - If it does not exist: create it. Contents: one line, `<harness name> <ISO-8601
     timestamp>`, e.g. `claude-code 2026-08-06T14:00:00Z`.
2. Rewrite the LOCK with a fresh timestamp at the start of every trial, so its age
   reflects liveness.
3. Remove the LOCK when the loop ends — on normal finalization, on STOP, and on any
   error path where you abandon the campaign. If you crash without removing it, the
   freshness check above lets the next orchestrator (and the user) reason about it.

## Start or resume

Campaign state lives in `runs/campaigns/<name>/` relative to the repository root.

**Resume** — if the directory already exists (after the LOCK check):

1. Read `spec.json` (frozen; never edit it mid-campaign) and all of `trials.jsonl`.
2. Report position to the user: trials completed, current best score and its trial
   number, remaining budget.
3. Continue the loop from the next trial number.

**Start** — if the directory does not exist:

1. Interview the user for whatever is missing:
   - target coverage (horizontal × vertical, degrees),
   - frequency band of interest,
   - size limits (mouth width/height, depth, mm),
   - iteration budget (max trials) and any target score,
   - anything fixed (throat diameter, driver, mounting constraints).
2. Call `list_generators` and confirm which generator to use (e.g. `slot_cd_horn`) and
   that its parameter schema covers the degrees of freedom the user wants. Do not
   hardcode parameter names from this playbook — the schema fetched at runtime is the
   source of truth.
3. Create `runs/campaigns/<name>/`, write `spec.json` (schema below), and seed `log.md`
   with a header summarizing the spec.

## The loop

For each trial while no stopping criterion fires:

1. Refresh the LOCK timestamp.
2. **Designer**: invoke the designer role (playbook `designer.md`) with only the campaign
   name/path. It re-reads spec + history itself and returns either exactly one params
   JSON object or `STOP` with a reason. It appends its hypothesis to `log.md` before
   returning.
3. If the designer returned `STOP` → go to Finalization.
4. Determine the stage: `"screen"` for the first `budget.screen_trials` trials (default
   4), `"refine"` afterwards. (`"verify"` is used only by Finalization.)
5. **Trial-runner**: invoke the trial-runner role (playbook `trial-runner.md`) with the
   campaign name, trial number, stage, and the params JSON. It runs generate → solve →
   score, appends exactly one line to `trials.jsonl`, and returns a ≤10-line report.
6. Re-read the last line of `trials.jsonl` (trust the file, not the report). Append a
   one-line outcome to `log.md`, e.g.
   `Trial 7 (refine): score 0.842 (best 0.851 @ t5) — ok`.
7. If the trial improved on the best score so far, update `best.json` (with
   `"verified": false`).
8. Repeat.

Failures (`status: "failed"`, `score: null`) count against `max_trials` and are valuable
data — the designer treats them as infeasible-region information. Do not retry a failed
design with identical params (the trial-runner's single bridge-restart retry is the only
exception, and it happens inside the trial-runner).

## Stopping criteria

All read from `spec.json` → `budget`; check after every trial:

- `max_trials` trials recorded in `trials.jsonl` (including failures).
- No improvement greater than `min_gain` in best score over the last `patience` trials.
- `target_score` reached (skip this check when `target_score` is null).

The designer may also STOP earlier with its own reasoning (e.g. converged, or the spec is
infeasible in the allowed size).

## Finalization

1. Read `best.json` for the champion params.
2. Run one **verification trial** through the trial-runner with stage `"verify"` and the
   champion's exact generator params. The trial-runner uses `spec.solve_verify` solve
   settings for verify trials (finer than `spec.solve`: wider band and/or more frequency
   points). If the spec defines finer *mesh* settings for verification
   (`mesh.verify_max_triangles`), the iteration triangle cap is relaxed to that value for
   this one trial only.
3. Update `best.json`: set `"verified": true` only if the verify score confirms the
   champion (verify score ≥ best score − 2 × `min_gain`). If it does not confirm, leave
   `"verified": false` and record the discrepancy in `log.md` — the coarse settings were
   flattering the design, and the user should know.
4. Append a closing summary to `log.md`: trials used, best trial, final params, score and
   subscores, and the plot/preview URLs from the verify run's `get_run` artifacts (URLs
   only — never paste data arrays).
5. Remove the LOCK. Report the summary to the user.

## Campaign state layout (`runs/campaigns/<name>/`)

Text-only state; it belongs in git (`.gitignore` explicitly un-ignores
`/runs/campaigns/`). Heavy outputs stay in `bridge/data/runs/<runId>/` and are referenced
by run id.

```
runs/campaigns/cd90x60/
  spec.json      # frozen campaign spec — written once at start, never edited
  trials.jsonl   # append-only, one JSON line per trial, single writer (trial-runner)
  log.md         # append-only human-readable narrative
  best.json      # current champion, rewritten whenever the best improves
  LOCK           # present only while an orchestrator is driving the campaign
```

### `spec.json` — worked example

```json
{
  "name": "cd90x60",
  "created": "2026-08-06T14:00:00Z",
  "generator": "slot_cd_horn",
  "objective": "Constant-directivity 90x60 horn: flat beamwidth across the band, smooth DI, minimal ripple",
  "coverage": { "h_deg": 90, "v_deg": 60 },
  "band_hz": { "fmin": 800, "fmax": 16000 },
  "weights": { "h_bw": 1.0, "v_bw": 1.0, "smoothness": 0.5, "ripple": 0.5 },
  "size_limit_mm": { "w": 400, "h": 250, "d": 300 },
  "fixed_params": { "throat_diameter_mm": 25.4 },
  "mesh": { "max_triangles": 9000, "min_triangles": 3000, "verify_max_triangles": 14000 },
  "solve": { "fmin": 800, "fmax": 16000, "count": 24, "backend": "beat_cuda", "symmetry": "xy" },
  "solve_verify": { "fmin": 500, "fmax": 20000, "count": 48, "backend": "beat_cuda", "symmetry": "xy" },
  "solve_timeout_min": 20,
  "budget": { "max_trials": 30, "screen_trials": 4, "min_gain": 0.01, "patience": 6, "target_score": null }
}
```

Notes: `weights` keys must match the subscore names produced by the scorer
(`python bridge/py/blabctl.py score`); `fixed_params` are merged into every trial's
generator params and the designer must not vary them; `solve`/`solve_verify` fields map
directly onto the `solve` MCP tool's arguments.

### `trials.jsonl` — schema and example lines

One compact JSON object per line, appended by the trial-runner only (single writer,
strictly sequential — one trial in flight guarantees no interleaving). Fields:

```
trial          integer, 1-based, strictly increasing
ts             ISO-8601 UTC timestamp when the line was written
stage          "screen" | "refine" | "verify"
params         full generator params object as passed to generate
mesh_run_id    bridge run id of the generate run (null if generate itself failed)
solve_run_id   bridge run id of the solve run (null if the solve was never started)
triangles      triangle count from generate (null if unavailable)
solve_settings the solve settings used, copied from spec (null if no solve started)
score          scalar score from the scorer, higher is better — null on any failure
subscores      per-objective subscores object from the scorer (null on failure)
key_metrics    {h_bw_mean_deg, v_bw_mean_deg, h_bw_rms_dev, v_bw_rms_dev,
                spdi_rms_d2_db, ripple_pp_db, bbox_mm} (null on failure)
status         "ok" | "failed"
note           one short human sentence (what was tried / why it failed)
```

Successful trial:

```json
{"trial": 7, "ts": "2026-08-06T15:42:10Z", "stage": "refine", "params": {"mouth_width_mm": 320, "mouth_height_mm": 180, "slot_length_mm": 60, "throat_diameter_mm": 25.4}, "mesh_run_id": "r_a1b2c3", "solve_run_id": "r_d4e5f6", "triangles": 7420, "solve_settings": {"fmin": 800, "fmax": 16000, "count": 24, "backend": "beat_cuda", "symmetry": "xy"}, "score": 0.842, "subscores": {"h_bw": 0.91, "v_bw": 0.85, "smoothness": 0.78, "ripple": 0.80}, "key_metrics": {"h_bw_mean_deg": 88.2, "v_bw_mean_deg": 57.5, "h_bw_rms_dev": 4.1, "v_bw_rms_dev": 6.3, "spdi_rms_d2_db": 0.9, "ripple_pp_db": 2.1, "bbox_mm": [320, 180, 240]}, "status": "ok", "note": "wider mouth for LF pattern control, slot unchanged"}
```

Failed trial (mesh gate — solve never started):

```json
{"trial": 8, "ts": "2026-08-06T15:49:02Z", "stage": "refine", "params": {"mouth_width_mm": 380, "mouth_height_mm": 220, "slot_length_mm": 60, "throat_diameter_mm": 25.4}, "mesh_run_id": "r_g7h8i9", "solve_run_id": null, "triangles": 11250, "solve_settings": null, "score": null, "subscores": null, "key_metrics": null, "status": "failed", "note": "mesh 11250 triangles > max 9000 — solve skipped"}
```

Failures always carry `score: null` — never `0`, which would poison score statistics.

### `log.md` conventions

Append-only narrative for humans (and for the designer's hypotheses):

- Seeded by the orchestrator with a header summarizing the spec.
- The designer appends `## Trial N proposal` with its hypothesis before each trial.
- The orchestrator appends a one-line outcome after each trial.
- Ends with the finalization summary (plot URLs, never data arrays).

### `best.json` — example

```json
{"trial": 7, "params": {"mouth_width_mm": 320, "mouth_height_mm": 180, "slot_length_mm": 60, "throat_diameter_mm": 25.4}, "score": 0.842, "subscores": {"h_bw": 0.91, "v_bw": 0.85, "smoothness": 0.78, "ripple": 0.80}, "mesh_run_id": "r_a1b2c3", "solve_run_id": "r_d4e5f6", "verified": false}
```

### `LOCK`

Single line: `<harness name> <ISO-8601 timestamp>`. See the LOCK protocol above.
