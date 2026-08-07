# Boundary Bridge

One process, three faces: a minimal web dashboard for humans, an MCP endpoint for AI
agents (T3 Code, Claude Code, Codex — anything speaking streamable-HTTP MCP), and an
optional t3code orchestration client. It wraps Boundary Lab's headless pipeline
(ATH / procedural geometry generation → mesh clean → BEM solve → plots) behind one
GPU-safe job queue.

## Run

```
cd bridge
npm install
npm start
```

Dashboard: http://127.0.0.1:4821 — MCP: `POST http://127.0.0.1:4821/mcp`
(already wired into the repo's `.mcp.json`).

## Configuration (env)

| Var | Default | |
| --- | --- | --- |
| `PORT` | `4821` | |
| `BRIDGE_PUBLIC_URL` | `http://127.0.0.1:4821` | base for URLs handed to agents |
| `PYTHON` | `python` | interpreter with `blab` installed |
| `BLAB_JULIA_EXECUTABLE` | Julia 1.12.6 install path | passed to solver children |
| `T3_BASE_URL` / `T3_TOKEN` | unset | optional; enables thread spawn + wake-up |

Without t3 configured everything works except thread orchestration.

## Layout

- `src/` — server: config, store, queue (mesh + solve lanes, concurrency 1 each), MCP tools, t3 client
- `py/` — Python glue: `blabctl.py` (NDJSON CLI) + `generators/` (ATH waveguide, procedural axisymmetric horn)
- `ui/` — static dashboard
- `data/` — run state + artifacts (gitignored)

## Solving on another machine

`blabctl solve --backend server --server-url http://<host>:8765` sends the whole
job (config + mesh, inlined) to a `blab server` elsewhere and streams results
back, so a rented GPU box needs no shared filesystem. `blabctl remote-check
--server-url ...` preflights one: reachability, which solver it runs, whether it
accepts symmetry-reduced meshes, and its GPU/VRAM. `BLAB_SERVER_URL` and
`BLAB_SERVER_TOKEN` supply defaults. See `docs/Boundary Lab Server.md`.

## Adding a generator

Drop a module in `py/generators/` exposing `SCHEMA` (id/title/description + JSON-Schema
params) and `generate(params, out_dir, name, emit)`. It appears in the UI form builder
and as an MCP `generate` target on next refresh — no server changes needed.
