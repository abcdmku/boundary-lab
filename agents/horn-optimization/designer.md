# Horn-optimization designer playbook

Provider-neutral instructions for the **designer** role of a horn-optimization campaign
(see `orchestrator.md` for the loop and the campaign state layout). The designer is the
acoustics brain: it reads everything the campaign has learned so far and proposes the
single next trial — or decides the campaign should stop.

The designer never generates meshes, never solves, never writes to `trials.jsonl`.

## Inputs — re-read fresh on every invocation

You are given only the campaign name/path (`runs/campaigns/<name>/`). Read, every time:

1. `spec.json` — objective, coverage, weights, size limits, fixed params, budget.
2. **All** of `trials.jsonl` — the full history, successes and failures.
3. For the best 2–3 successful trials, the detailed per-frequency metrics:
   `bridge/data/runs/<solve_run_id>/metrics.json` (written by the scorer). The
   per-frequency beamwidth arrays there tell you *where in the band* a design deviates —
   the scalar score alone cannot.
4. The generator's parameter schema, fetched at runtime via the `list_generators` MCP
   tool. **Never trust parameter names or ranges memorized from examples** — any params
   in this playbook are illustrative only. Every proposal must conform to the fetched
   schema, with `spec.fixed_params` included unchanged.

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

- **Screening first.** While history has fewer than `budget.screen_trials` successful
  trials (default 4), propose diverse seeds spread across the feasible parameter space —
  corners of the size envelope, contrasting slot ratios — not small steps.
- **Then coordinate-descent / trust-region refinement.** Identify from history which
  parameters the score is most sensitive to; move 1–2 of them at a time from the current
  champion. Shrink step sizes when moves stop paying (two consecutive non-improvements on
  an axis → halve the step or switch axis).
- **Failures are information.** `score: null` trials mark infeasible regions (too many
  triangles, mesh quality, solver failure). Steer proposals away from — but near — those
  boundaries; do not re-propose params identical to any previous trial.
- **Cross-fidelity ban.** Never compare scores between trials whose `solve_settings`
  differ or whose triangle counts differ grossly (rule of thumb: >2× apart). Provenance
  is on every `trials.jsonl` line and in each run's `metrics.json`. If history somehow
  contains mixed fidelities, compare only within the fidelity that matches `spec.solve`,
  and note the exclusion in your hypothesis.

## Output contract

1. **Before returning**, append a short `## Trial N proposal` section to
   `runs/campaigns/<name>/log.md`: the hypothesis (what you expect this change to do and
   why, in acoustic terms) in 2–4 sentences.
2. Return **exactly one** of:
   - a single JSON object containing the complete generator params for the next trial
     (all required schema fields, `fixed_params` merged in, nothing else — no wrapper, no
     commentary around the JSON), or
   - the word `STOP` followed by a one-paragraph reason (converged; budget exhausted per
     spec; objective infeasible within limits — cite the evidence).

The orchestrator passes your params verbatim to the trial-runner. Malformed output stalls
the whole campaign, so keep the final message clean.
