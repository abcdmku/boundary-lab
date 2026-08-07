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
  workers that forget everything between invocations.
- **Iteration meshes stay ≤ ~9k triangles** (see `spec.json` → `mesh.max_triangles`).
  Fine settings are reserved for the single final verification trial.
- Tools you refer to generically: the boundary-lab MCP tools (`list_generators`,
  `generate`, `solve`, `get_run`, `list_runs`), shell commands, and plain file
  reads/writes. Pass your absolute working directory as `workspace` on every MCP call.
- **"Repository root"** throughout means the checkout that hosts the running bridge
  (`bridge/data/` lives there). Campaign paths and score commands resolve against it,
  and it is the path to pass as `workspace`.
- If the MCP tools are unreachable, ask the user to start the bridge (`npm start` in
  `bridge/`). Do not restart a bridge yourself mid-campaign — it may be serving other
  work.

## LOCK protocol

Exactly one orchestrator may drive a campaign directory at a time.

1. **Before doing anything else**, check for `runs/campaigns/<name>/LOCK`.
   - If it exists: read it and STOP. Report the holder and timestamp to the user, and ask
     them to check for a live campaign (bridge dashboard at http://127.0.0.1:4821 shows
     queued/running solves) before deleting a stale LOCK by hand. If the timestamp is
     less than ~2 hours old, assume the campaign is live. Never delete another run's
     LOCK yourself.
   - If it does not exist: create it (creating the campaign directory first if needed)
     with an **atomic exclusive create** — an operation that fails if the file already
     exists, e.g. in a POSIX shell `(set -C; echo "claude-code $(date -u +%FT%TZ)" > runs/campaigns/<name>/LOCK)`
     (noclobber makes the redirect fail on an existing file). If the exclusive create
     fails, another orchestrator won the race: treat it exactly as "LOCK exists" above.
     Never use a plain check-then-write, which lets two orchestrators both proceed.
     Contents: one line, `<harness name> <ISO-8601 UTC timestamp>` — harness name is any
     short stable identifier for your runtime (e.g. `claude-code`, `cursor`, `manual`).
2. Rewrite the LOCK with a fresh timestamp at the start of every trial — including the
   verification trial, which can be the longest — so its age reflects liveness.
3. Remove the LOCK when the loop ends — on normal finalization, on STOP, and on any
   error path where you abandon the campaign. On an error path, first note any in-flight
   solve run id in `log.md` so the next orchestrator does not start a trial against an
   occupied GPU. If you crash without removing the LOCK, the freshness check above lets
   the next orchestrator (and the user) reason about it.

## Start or resume

Campaign state lives in `runs/campaigns/<name>/` relative to the repository root.

**Resume** — if `spec.json` exists (after the LOCK check; the directory alone proves
nothing, since creating the LOCK creates it):

1. Read `spec.json` (frozen; never edit it mid-campaign) and all of `trials.jsonl`
   (absent or empty means no trials have completed yet — that is a valid resume state).
2. Report position to the user: trials completed, current best score and its trial
   number, remaining budget.
3. Continue the loop from the next trial number.

**Start** — if `spec.json` does not exist:

1. Interview the user for whatever is missing:
   - target coverage (horizontal × vertical, degrees),
   - frequency band of interest,
   - size limits (mouth width/height, depth, mm),
   - iteration budget (max trials) and any target score,
   - anything fixed (throat diameter, driver, mounting constraints).
   For anything the user has no opinion on, use the defaults from the worked example
   below. If you cannot ask (non-interactive), use those defaults and record every
   assumption in `log.md`.
2. Call `list_generators` and confirm which generator to use (e.g. `slot_cd_horn`) and
   that its parameter schema covers the degrees of freedom the user wants. If no
   generator fits, stop and tell the user — do not improvise geometry through the wrong
   generator. Do not hardcode parameter names from this playbook — the schema fetched at
   runtime is the source of truth.
3. Write `spec.json` (schema below) and seed `log.md` with a header summarizing the
   spec. `trials.jsonl` and `best.json` are NOT pre-created: the trial-runner creates
   `trials.jsonl` on the first trial, and you create `best.json` at the first successful
   trial (with no prior success, any `status: "ok"` trial becomes the best).

## The loop

For each trial:

1. **Check the stopping criteria (below) against the recorded history first.** If one
   already holds, go straight to Finalization. Because this check runs before anything
   else, a resumed (or already-completed) campaign never launches a trial beyond an
   exhausted budget or past an achieved target.
2. Refresh the LOCK timestamp.
3. **Designer**: invoke the designer role (playbook `designer.md`) with the campaign
   path (give it the absolute repository root too). It re-reads spec + history itself
   and returns either exactly one params JSON object or a message starting with `STOP`.
   It appends its hypothesis to `log.md` before returning.
4. If the designer returned `STOP` (first word of its reply):
   - reason starting with `blocked:` → abort: report the blocker to the user, remove the
     LOCK, and stop (no finalization);
   - any other reason → go to Finalization.
5. Determine the stage: `"screen"` until `budget.screen_trials` (default 4) trials with
   `status: "ok"` exist in `trials.jsonl`, `"refine"` afterwards. (`"verify"` is used
   only by Finalization.) This matches the designer's own screening rule, so the stage
   label always agrees with the strategy that produced the proposal.
6. **Trial-runner**: invoke the trial-runner role (playbook `trial-runner.md`) with the
   campaign name, trial number (last recorded trial + 1, or 1), stage, and the params
   JSON. The trial-runner stays alive for the whole trial — polling the solve per its
   playbook — and returns only after it has appended its `trials.jsonl` line. Wait for
   it; never start anything else meanwhile.
7. Re-read the last line of `trials.jsonl` (trust the file, not the report). If no line
   for this trial appeared (runner crashed): check `list_runs`/`get_run` for a solve
   still queued or running for this trial — if one exists, keep waiting (poll with ~30 s
   sleeps) until it is terminal; do NOT start another trial. Once nothing is in flight,
   append the missing line yourself with `status: "failed"`, `score: null`, and a note
   `trial-runner crashed` (this is the one sanctioned exception to the trial-runner
   being the sole writer).
8. Append a one-line outcome to `log.md`, e.g.
   `Trial 7 (refine): score 0.842 (best 0.851 @ t5) — ok`.
9. If the trial improved on the best score so far, rewrite `best.json` (with
   `"verified": false`).
10. Repeat from 1.

Failures (`status: "failed"`, `score: null`) count against `max_trials` and are valuable
data — the designer treats them as infeasible-region information. Do not retry a failed
design with identical params (the trial-runner's single bridge-restart retry is the only
exception, and it happens inside the trial-runner).

## Stopping criteria

All read from `spec.json` → `budget`; evaluated at the top of every loop iteration,
which also covers resuming a campaign whose budget is already spent:

- `max_trials` trials recorded in `trials.jsonl` (including failures; the verification
  trial is extra and does not count against this budget).
- No improvement: once at least `patience` trials exist, stop when the best score now
  exceeds the best score as of `patience` trials ago by less than `min_gain` (failed
  trials count as non-improvements).
- `target_score` reached (skip this check when `target_score` is null).

The designer may also STOP earlier with its own qualitative reasoning (e.g. the spec is
infeasible in the allowed size); the numeric checks above are yours alone — the designer
does not duplicate them.

## Finalization

1. Read `best.json` for the champion params. If there is no `best.json` (no trial ever
   succeeded), skip verification: write a closing `log.md` summary saying the campaign
   produced no feasible design (and why, from the failure notes), remove the LOCK, and
   report to the user.
2. Run one **verification trial** through the trial-runner with stage `"verify"`, the
   next trial number, and the champion's exact generator params. The trial-runner
   overlays `spec.mesh_verify_params` onto them — resolution-only generator parameters
   (e.g. a smaller element size) that actually refine the mesh; merely raising the
   triangle cap would regenerate the identical iteration mesh, since density is a
   generator param. It also uses `spec.solve_verify` solve settings (finer than
   `spec.solve`: wider band and/or more frequency points), the relaxed
   `mesh.verify_max_triangles` cap, and the longer `solve_verify_timeout_min` — fine
   meshes can take an hour or more on this GPU.
3. Update `best.json`: set `"verified": true` only if the verify score confirms the
   champion (verify score ≥ best score − 2 × `min_gain`). This is a deliberate
   cross-fidelity comparison — its whole purpose is to detect coarse-settings flattery,
   so the designer's cross-fidelity ban does not apply to it; the `2 × min_gain`
   tolerance absorbs the fidelity gap. If the verify trial fails (`score: null`) or does
   not confirm, leave `"verified": false` and record the discrepancy in `log.md` — the
   user should know the iteration-fidelity score was not reproduced.
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
  "mesh_verify_params": { "element_size_mm": 4 },
  "solve": { "fmin": 800, "fmax": 16000, "count": 24, "backend": "beat_cuda", "symmetry": "xy" },
  "solve_verify": { "fmin": 500, "fmax": 20000, "count": 48, "backend": "beat_cuda", "symmetry": "xy" },
  "solve_timeout_min": 20,
  "solve_verify_timeout_min": 90,
  "budget": { "max_trials": 30, "screen_trials": 4, "min_gain": 0.01, "patience": 6, "target_score": null }
}
```

Notes:

- The scorer (`python bridge/py/blabctl.py score`) produces a scalar `score` normalized
  to 0–1 (higher is better) and the subscores `h_bw`, `v_bw`, `smoothness`, `ripple`;
  `weights` keys must use those names (copying them from this example is correct — it is
  the scorer contract, unlike generator params, which must come from `list_generators`).
- `fixed_params` are merged into every proposal **by the designer** and must not be
  varied; the trial-runner passes the designer's params through verbatim.
- `solve`/`solve_verify` fields map directly onto the `solve` MCP tool's arguments.
  `symmetry` is one of `off` / `x` / `xy`; anything but `off` requires the generator to
  emit a reduced (unmirrored) mesh — if the first trial fails with a symmetry/mesh
  error, re-create the spec with `"symmetry": "off"`.
- `solve_timeout_min` (and `solve_verify_timeout_min` for verify trials, default
  3 × `solve_timeout_min`) is enforced by the trial-runner, which cancels a timed-out
  run through the bridge HTTP API.
- `mesh.max_triangles` / `min_triangles` gate the **effective solved** triangle count
  (full count ÷ 2 for symmetry `x`, ÷ 4 for `xy` — the solver receives the reduced
  mesh); see `trial-runner.md`. These are this campaign's own budget knobs — nothing
  below them refuses a mesh for being large — so `max_triangles` is really a wall-clock
  budget (iteration meshes stay small because that is what makes a campaign finish, not
  because a guard forbids more) and `min_triangles` is the anti-gaming floor. The
  trial-runner also rejects meshes whose `bboxMm` exceeds `size_limit_mm`.
- `mesh_verify_params` are resolution-only parameter overrides (names must come from the
  generator's schema; the value here is illustrative) applied on top of the champion's
  params for the verification trial — they must refine the mesh, never change geometry.
  Set `verify_max_triangles` as high as the verify budget allows: generation imposes no
  size limit of its own. The one hardware constraint is GPU memory, and it is advisory —
  `generate` reports an estimated peak VRAM per symmetry option and `solve` warns
  (without refusing) when the estimate exceeds the local GPU's VRAM.

### `trials.jsonl` — schema and example lines

One compact JSON object per line, appended by the trial-runner only (single writer,
strictly sequential — one trial in flight guarantees no interleaving; the sole exception
is the orchestrator's crashed-runner failure line, loop step 6). Fields:

```
trial          integer, 1-based, strictly increasing
ts             ISO-8601 UTC timestamp when the line was written
stage          "screen" | "refine" | "verify"
params         full generator params object as passed to generate
mesh_run_id    bridge run id of the generate run (null only if no run id was returned)
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

Append-only narrative for humans (and the designer's persisted strategy memory):

- Seeded by the orchestrator with a header summarizing the spec.
- The designer appends `## Trial N proposal` with its hypothesis before each trial (or a
  `## STOP` section with its rationale when it stops the campaign).
- The orchestrator appends a one-line outcome after each trial.
- Ends with the finalization summary (plot URLs, never data arrays).

Writers alternate strictly (designer → orchestrator, one trial at a time), so plain
appends are safe.

### `best.json` — example

```json
{"trial": 7, "params": {"mouth_width_mm": 320, "mouth_height_mm": 180, "slot_length_mm": 60, "throat_diameter_mm": 25.4}, "score": 0.842, "subscores": {"h_bw": 0.91, "v_bw": 0.85, "smoothness": 0.78, "ripple": 0.80}, "mesh_run_id": "r_a1b2c3", "solve_run_id": "r_d4e5f6", "verified": false}
```

`trial` stays the champion's iteration trial number; verification only flips `verified`.

### `LOCK`

Single line: `<harness name> <ISO-8601 UTC timestamp>`. See the LOCK protocol above.
