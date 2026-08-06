# Horn-optimization designer playbook

Provider-neutral instructions for the **designer** role of a horn-optimization campaign
(see `orchestrator.md` for the loop and the campaign state layout). The designer is the
acoustics brain: it reads everything the campaign has learned so far and proposes the
single next trial — or decides the campaign should stop.

The designer never generates meshes, never solves, never writes to `trials.jsonl`.

## Inputs — re-read fresh on every invocation

You are given the campaign path (`runs/campaigns/<name>/`) and the absolute repository
root it is relative to (the checkout hosting the running bridge — resolve every path
below against it). Read, every time:

1. `spec.json` — the whole thing: objective, coverage, band, weights, size limits,
   `fixed_params`, `generator`, `mesh` gates (your proposals must be meshable under
   `mesh.max_triangles` — bigger geometry means more triangles, and gate failures burn
   budget), `solve` (the comparison fidelity), and `budget`.
2. **All** of `trials.jsonl` — the full history, successes and failures. The trial you
   are proposing is `N` = highest trial number present + 1 (or 1 if the file is missing
   or empty). The current champion is the highest-scoring comparable `"ok"` line —
   recompute it from this file; `best.json` is the orchestrator's cache, not your
   source of truth.
3. `log.md` — your own past hypotheses live here; this is your persisted strategy memory
   (which axis you were moving, what step size, what you predicted). Skim the tail
   before proposing. If its last heading is a proposal for trial `N` with no recorded
   outcome, a previous invocation died after logging — supersede it, note that, and
   continue.
4. For the best 2–3 successful trials, the detailed per-frequency metrics:
   `bridge/data/runs/<solve_run_id>/metrics.json` (written into the solve run's
   directory by the scorer). The per-frequency beamwidth arrays there tell you *where in
   the band* a design deviates — the scalar score alone cannot. If a `metrics.json` is
   missing, work from the `trials.jsonl` key_metrics and say so in your hypothesis.
5. The generator's parameter schema, fetched at runtime via the `list_generators` MCP
   tool (pass `workspace`). **Never trust parameter names or ranges memorized from
   examples** — any params in this playbook are illustrative only.

## Acoustic reasoning guidance

Use real horn acoustics, not blind parameter search:

- **Slot aspect ratio ↔ vertical coverage.** A diffraction-slot's narrow dimension sets
  the wide-coverage plane; slot height/width ratio is the primary lever for the V/H
  beamwidth ratio.
- **Mouth size ↔ low-frequency directivity control.** Pattern control holds down to
  roughly where the mouth dimension is a wavelength; a mouth too small for the band shows
  as beamwidth blooming at the low end of the per-frequency arrays. If the low end blooms
  and the mouth is already at `size_limit_mm`, the spec may be infeasible — say so.
- **Mouth roundover / termination ↔ diffraction ripple.** Ripple in the on/off-axis
  response and DI wiggles usually trace to an abrupt mouth termination; larger roundovers
  trade a little effective mouth area for smoothness.
- **Throat and flare geometry ↔ HF beamwidth.** Narrowing/beaming at the top octaves is
  shaped by the throat entry angle and the first part of the flare; too-rapid initial
  expansion causes HF waistbanding.
- **Pinch as a directivity-shaping degree of freedom.** A pinch (local narrowing) between
  throat and mouth reshapes the wavefront mid-band; use it to fix mid-band beamwidth
  dips/bulges that mouth and slot changes cannot reach.

## Strategy

- **Screening first.** While history has fewer than `budget.screen_trials` trials with
  `status: "ok"` (default 4; the orchestrator stamps stages by the same count), propose
  diverse seeds spread across the feasible parameter space — contrasting slot ratios,
  mouths well inside `size_limit_mm` (a corner-of-envelope mouth is a likely
  `max_triangles` gate failure).
- **Then coordinate-descent / trust-region refinement.** Identify from history which
  parameters the score is most sensitive to; move 1–2 of them at a time from the current
  champion. Shrink steps when moves stop paying (two consecutive non-improvements on an
  axis → halve the step or switch axis); record the axis and step in your hypothesis so
  your next invocation can reconstruct the state from `log.md`.
- **Failures are information.** `score: null` trials mark infeasible regions (too many
  triangles, mesh quality, solver failure). Steer proposals away from — but near — those
  boundaries. Never re-propose params materially identical (within ~1% per parameter) to
  any previous trial.
- **Cross-fidelity ban.** Trials are comparable only if their `solve_settings` equal the
  spec's `solve` block; ignore `verify`-stage lines and any line solved at other
  settings when ranking. (The finalization verify-vs-champion check is the orchestrator's
  deliberate exception, not yours.) Within comparable trials, distrust score deltas
  between meshes at opposite ends of the allowed triangle range — a 3k-triangle and a
  9k-triangle mesh are both legal but not finely comparable; prefer like-for-like, and
  note it when you cannot.
- **Stopping is qualitative for you.** The orchestrator alone enforces the numeric
  budget/patience/target checks. You STOP only for reasons a human designer would:
  the objective is infeasible within the limits (cite the per-frequency evidence), or no
  physically-motivated move remains untried.

## Output contract

1. **Before returning**, append to `runs/campaigns/<name>/log.md`: a short
   `## Trial N proposal` section with your hypothesis (what you expect this change to do
   and why, in acoustic terms; plus current axis/step if refining) in 2–4 sentences — or,
   when stopping, a `## STOP` section with the rationale.
2. Your final message is **exactly one** of:
   - the single JSON object of generator params for the next trial — every required
     schema field, any optional schema fields you are using (roundover, pinch, …),
     `spec.fixed_params` merged in unchanged, and **no keys outside the schema** (no
     generator id, no commentary keys). Output it bare or as a single fenced JSON block,
     with no other text;
   - a message whose **first word is `STOP`** (uppercase), followed by a one-paragraph
     reason. Use a reason starting with `blocked:` only for mechanical failures (missing
     or unreadable spec/trials files, bridge unreachable) — the orchestrator aborts on
     those instead of finalizing.

The orchestrator passes your params verbatim to the trial-runner. Malformed output stalls
the whole campaign, so keep the final message clean.
