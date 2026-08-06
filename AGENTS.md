# Boundary Lab — agent briefing

Boundary Lab (`blab`) is a BEM loudspeaker radiation solver. Waveguide/horn design work in
this workspace goes through **Boundary Bridge** — an MCP server (`boundary-lab`, see
`.mcp.json`) with a live dashboard at http://127.0.0.1:4821. Start it with
`npm start` in `bridge/` if the tools are unreachable.

## Using the bridge tools

- Always pass your absolute working directory as `workspace` on every tool call.
- `list_generators` → available geometry generators and their parameter schemas.
- `generate` blocks briefly (seconds) and returns triangle count, bbox, and a preview URL.
- `solve` returns immediately with a run id. **Never busy-wait.** Poll `get_run`
  occasionally or continue other work; live t3 threads are woken automatically on
  completion (subagents and other harnesses get no wake-up — they must poll).
- Results are compact summaries + URLs. Hand preview/plot URLs to the human — they render
  in a browser and in the dashboard.

## Hard rules on this machine

- **One GPU task at a time.** The bridge solve queue enforces this — never run
  `blab solve` directly while bridge jobs are queued or running, and never run two
  CUDA solves concurrently by any path.
- **Iteration meshes stay ≤ ~9k triangles** (6.8k ≈ 30 s on this GPU; 13.6k ≈ 1 h+).
  Use fine meshes only for final verification runs.
- Default backend is `beat_cuda`.

## Conventions

- Designs are files: keep chosen ATH configs / generator params in git. Heavy outputs
  (meshes, field data, plots) live under `bridge/data/` and are not committed.
- The direct CLI (`blab clean|solve|prepare|plot`) exists, but prefer the bridge tools so
  runs are queued, visible, and comparable in the dashboard.

## Horn-optimization campaigns

- Playbooks in `agents/horn-optimization/` — start with `orchestrator.md` (designer and
  trial-runner roles alongside). Campaign state lives in `runs/campaigns/<name>/`
  (`spec.json`, `trials.jsonl`, `log.md`, `best.json`, `LOCK`). Scoring:
  `python bridge/py/blabctl.py score --solve-run <dir> --mesh-run <dir> --spec <spec.json>`.
