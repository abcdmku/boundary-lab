# Boundary Lab — agent briefing

Boundary Lab (`blab`) is a BEM loudspeaker radiation solver. Waveguide/horn design work in
this workspace goes through **Boundary Bridge** — an MCP server (`boundary-lab`, see
`.mcp.json`) with a live dashboard at http://127.0.0.1:4821. Start it with
`npm start` in `bridge/` if the tools are unreachable.

## Using the bridge tools

- Always pass your absolute working directory as `workspace` on every tool call.
- `list_generators` → available geometry generators and their parameter schemas.
- `list_targets` → where solves can run: the local GPU plus any registered remote instances.
- `list_projects` → the designs this bridge holds. Pass `project: "<name>"` when creating
  work; an unknown name creates the project, a known one resolves to it.
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
- `schedule_jobs` decides where and in what order staged work runs — one move per job,
  `column` being a target id or `"planned"` to hold it back.
- Results are compact summaries + URLs. Hand preview/plot URLs to the human — they render
  in a browser and in the dashboard.

## How the work is shaped

```
project ──┬── mesh (root) ── variants ──…      one design, many geometries
          └── each mesh ── many solves          coarse look, fine verification, …
```

- **One mesh, many solves** is the normal case. A coarse preview and a fine verification
  of one geometry are two solves of the same mesh — do not regenerate the mesh for each.
- **Produce each optimization trial with `create_mesh_variant`**, not `generate`. It
  patches the parent's params (pass only what changes), records the lineage and inherits
  the project, so a campaign reads as a chain of edits instead of N unrelated meshes.
- **File work under a project** so its variants and results stay together.

## Hard rules on this machine

- **One GPU task at a time.** The bridge's `local:solve` lane has ONE slot by default and
  enforces this structurally — never run `blab solve` directly while bridge jobs are
  queued or running, and never run two CUDA solves concurrently by any path. (Remote
  targets get their own lanes and do run in parallel; that does not relax the rule here.)
  The slot count is the human's to raise (schedule board / `set_target_slots`), and on
  this single-GPU box it should stay at 1 — do not raise it on your own.
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
