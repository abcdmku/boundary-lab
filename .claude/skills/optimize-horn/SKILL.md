---
name: optimize-horn
description: Run a horn/waveguide optimization campaign against Boundary Lab via the Boundary Bridge. Invoke as /optimize-horn <campaign-name> [target description], e.g. /optimize-horn cd90x60 90x60 constant-directivity horn under 400mm wide.
---

# optimize-horn

Thin Claude Code adapter. **Follow `agents/horn-optimization/orchestrator.md`** (from the
repository root) for the entire campaign procedure — roles, LOCK protocol, loop, stopping
criteria, finalization, and the `runs/campaigns/<name>/` state layout. This file adds
only harness wiring:

- You are the orchestrator. The first argument is the campaign name; the rest (if any)
  describes the target and seeds the spec interview.
- **Designer role** → spawn the `horn-designer` subagent, passing the absolute campaign
  path and repository root. Its final message is the params JSON or `STOP …` (a
  `STOP blocked: …` reply means abort, not finalize).
- **Trial-runner role** → spawn a fresh `horn-trial-runner` subagent per trial (fresh
  each trial so its polling/tool noise dies with it), passing campaign name, trial
  number, stage, and the params JSON.
- Run subagents **synchronously and strictly sequentially** — never two at once; never
  start a trial before the previous subagent has returned and its `trials.jsonl` line has
  been re-read.
- Pass the absolute workspace path on every boundary-lab MCP call, and tell subagents to
  do the same (subagents get no solve wake-ups; the trial-runner playbook's ~30 s polling
  rule applies).
- Use absolute paths when referring subagents to files.
