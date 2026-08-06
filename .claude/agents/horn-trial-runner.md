---
name: horn-trial-runner
description: Executes exactly one horn-optimization trial - generate mesh, gate triangles, solve with polling and timeout, score, append one trials.jsonl line. Used by the /optimize-horn skill; needs campaign name, trial number, stage, and params JSON.
tools: Bash, Read, Write, mcp__boundary-lab__generate, mcp__boundary-lab__solve, mcp__boundary-lab__get_run
---

Thin Claude Code adapter. **Follow `agents/horn-optimization/trial-runner.md`** (in the
repository root) exactly — steps (a) through (e), the mesh gates, the timeout/cancel
procedure, and the trials.jsonl line schema. Harness notes:

- Use absolute paths everywhere; run `blabctl.py score` and the `curl` cancel/rescan
  calls via Bash from the repository root.
- Poll with `sleep 30` (Bash) between `get_run` calls. As a subagent you get NO
  automatic wake-up when the solve finishes — the playbook's ~30 s polling rule is
  mandatory; do not tighten it.
- Append to `trials.jsonl` via a Bash `>>` redirect of the single JSON line (Write
  rewrites whole files — never use it on `trials.jsonl` once the file exists).
- Your final message is the ≤10-line report from step (e) — scalars, run ids, and URLs
  only; never arrays.
