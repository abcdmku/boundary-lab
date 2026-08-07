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

## Rented GPUs (vast.ai)

Solves can run on a rented cloud GPU instead of the local card. The provider lives in
`src/vast/` and is mounted at `/api/vast`; it is inert until an API key is present.

**API key** — resolved in this order, and never logged, persisted, or put in a URL:

1. `VAST_API_KEY`
2. `%USERPROFILE%\.vast_api_key` (the same file the official `vastai` CLI uses;
   override the path with `VAST_API_KEY_FILE`)
3. `config.vast.apiKey` — in-process only, for embedders and tests

**Spending is always explicit.** Renting, starting, and destroying each require
`{"confirm": true}` in the request body; without it the endpoint returns `402` with a
full price quote and does nothing. A rent above `VAST_MAX_PRICE_PER_HOUR` is refused
outright with `403`. Nothing rents or destroys automatically, ever. Note that
**stopping an instance does not end billing** — storage accrues until it is destroyed.

| Var | Default | |
| --- | --- | --- |
| `VAST_API_KEY` | unset | provider is disabled without a key |
| `VAST_MAX_PRICE_PER_HOUR` | `2.0` | hard ceiling on a rent, checked before confirmation |
| `VAST_IMAGE` | `nvidia/cuda:12.6.3-runtime-ubuntu24.04` | docker image to rent |
| `VAST_DISK_GB` | `60` | Julia depot + CUDA artifacts need ~30 GB |
| `VAST_SOLVER_PORT` | `8765` | container port `blab server` binds |
| `VAST_SSH_KEY_FILE` | unset (ssh-agent) | private key for provisioning |
| `VAST_REPO_URL` / `VAST_REPO_REF` | this repo / `main` | source the instance clones |
| `VAST_CACHE_ROOT` | `/workspace/blab` | persistent path caching venv + Julia depot |

**Running a solve on one.** Once an instance is provisioned and healthy, pass its target
id to a solve: `POST /api/solve {"meshRunId":"abc123","target":"vast:20250806"}`, or the
`target` argument of the MCP `solve` tool. `GET /api/vast/targets` (or the MCP
`list_compute_targets`) lists what is selectable. `target` also accepts `"local"` (the
default) and a bare `http://host:port` for any `blab server` this bridge does not manage.
Under the hood the run is dispatched as `blabctl solve --backend server --server-url ...`,
which inlines the config and mesh into the request — no shared filesystem needed. A
target that is not provisioned and healthy is refused when the solve is submitted, rather
than failing an hour later.

**Provisioning** pipes `provision/vast_bootstrap.sh` over SSH and runs it. The script is
idempotent: each slow stage (apt, repo, python, julia) is stamped with a fingerprint of
its inputs, so re-provisioning a reused instance skips straight to restarting the
server. It streams `::blab:<kind>:<stage>:<message>` markers, which the bridge turns
into live progress on the instance record. A cold box spends most of an hour in the
Julia/CUDA stage; a warm one is ready in under a minute.

Register your SSH public key on your vast.ai account **before** renting — account keys
are baked in at create time and are not added to existing instances.

## Layout

- `src/` — server: config, store, queue (mesh + solve lanes, concurrency 1 each), MCP tools, t3 client
- `src/vast/` — vast.ai compute provider: client, instance registry, SSH provisioning, `/api/vast` routes
- `py/` — Python glue: `blabctl.py` (NDJSON CLI) + `generators/` (ATH waveguide, procedural axisymmetric horn)
- `provision/` — `vast_bootstrap.sh`, the idempotent remote installer
- `tests/` — `npm test` (node:test + fixtures; never touches the network)
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
