# Boundary Lab — agent briefing

Boundary Lab (`blab`) is a BEM loudspeaker radiation solver. Waveguide/horn design work in
this workspace goes through **Boundary Bridge** — an MCP server (`boundary-lab`, see
`.mcp.json`) with a live dashboard at http://127.0.0.1:4821. Start it with
`npm start` in `bridge/` if the tools are unreachable.

## Using the bridge tools

- Always pass your absolute working directory as `workspace` on every tool call.
- `list_generators` → available geometry generators and their parameter schemas.
- `list_targets` → where solves can run: the local GPU plus any registered remote instances.
- `generate` blocks briefly (seconds) and returns triangle count, bbox, and a preview URL.
- `solve` returns immediately with a job id. **Never busy-wait.** Poll `get_job`
  occasionally or continue other work; live t3 threads are woken automatically on
  completion (subagents and other harnesses get no wake-up — they must poll).
- For several solves on one mesh, use `create_solve_jobs` (a settings sweep against one or
  more meshes, grouped into one batch) instead of calling `solve` in a loop. Created jobs
  are **drafts** unless you pass `launch: true`; start them with `launch_jobs` and stop the
  whole sweep with `cancel_jobs {batch_id}`.
- Jobs can be staged before they run: `create_mesh_jobs` / `create_solve_jobs` +
  `update_job` configure work that only starts when it is explicitly launched.
- Results are compact summaries + URLs. Hand preview/plot URLs to the human — they render
  in a browser and in the dashboard.

## Hard rules on this machine

- **One GPU task at a time.** The bridge's `local:solve` queue lane enforces this
  structurally — never run `blab solve` directly while bridge jobs are queued or running,
  and never run two CUDA solves concurrently by any path. (Remote targets get their own
  lanes and do run in parallel; that does not relax the rule for this machine.)
- **Iteration meshes stay ≤ ~9k triangles** (6.8k ≈ 30 s on this GPU; 13.6k ≈ 1 h+).
  Use fine meshes only for final verification runs.
- Default backend is `beat_cuda`.

## Conventions

- Designs are files: keep chosen ATH configs / generator params in git. Heavy outputs
  (meshes, field data, plots) live under `bridge/data/` and are not committed.
- The direct CLI (`blab clean|solve|prepare|plot`) exists, but prefer the bridge tools so
  jobs are queued, visible, and comparable in the dashboard.

## Horn-optimization campaigns

- Playbooks in `agents/horn-optimization/` — start with `orchestrator.md` (designer and
  trial-runner roles alongside). Campaign state lives in `runs/campaigns/<name>/`
  (`spec.json`, `trials.jsonl`, `log.md`, `best.json`, `LOCK`). Scoring:
  `python bridge/py/blabctl.py score --solve-run <dir> --mesh-run <dir> --spec <spec.json>`.
