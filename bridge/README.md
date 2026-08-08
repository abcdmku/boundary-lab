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
npm test          # model / draft / batch / lane-concurrency tests
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
| `BRIDGE_REMOTE_CONCURRENCY` | `1` | default concurrent jobs per remote instance |
| `BLAB_PREVIEW_IDLE_SECONDS` | `300` | idle time before the mesh-editor preview worker is shut down |
| `BLAB_PREVIEW_TIMEOUT_SECONDS` | `90` | a preview slower than this means the worker is wedged; it gets replaced |
| `BLAB_ATH_LOCK_TIMEOUT_S` | `240` (`5` in previews) | wait for the shared `ath.cfg` lock before giving up |
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
id to a solve: `POST /api/solve {"meshJobId":"abc123","target":"vast:20250806"}`, or the
`target` argument of the MCP `solve` / `create_solve_jobs` tools. `GET /api/targets` (or
the MCP `list_targets`) lists what is selectable; `GET /api/vast/targets?refresh=true` is
the same list with a fresh health probe per instance. `target` also accepts `"local"`
(the default) and a bare `http://host:port` for any `blab server` this bridge does not
manage. Under the hood the job is dispatched as
`blabctl solve --backend server --server-url ...`, which inlines the config and mesh into
the request — no shared filesystem needed. A target that is not provisioned and healthy
is refused when the solve is submitted (404 unknown / 409 not ready), rather than failing
an hour later.

Each rented instance gets **its own queue lane**, so a batch spread over three boxes runs
three solves at once while the local GPU stays strictly serialized. See "Queue lanes".

**Provisioning** pipes `provision/vast_bootstrap.sh` over SSH and runs it. The script is
idempotent: each slow stage (apt, repo, python, julia) is stamped with a fingerprint of
its inputs, so re-provisioning a reused instance skips straight to restarting the
server. It streams `::blab:<kind>:<stage>:<message>` markers, which the bridge turns
into live progress on the instance record. A cold box spends most of an hour in the
Julia/CUDA stage; a warm one is ready in under a minute.

Register your SSH public key on your vast.ai account **before** renting — account keys
are baked in at create time and are not added to existing instances.

## Layout

- `src/` — server: config, store, targets, queue (per-target lanes), MCP tools, t3 client
- `src/vast/` — vast.ai compute provider: client, instance registry, SSH provisioning, `/api/vast` routes
- `py/` — Python glue: `blabctl.py` (NDJSON CLI), `mesh_preview_worker.py` (warm worker behind the live mesh editor) + `generators/` (ATH waveguide, procedural axisymmetric horn)
- `provision/` — `vast_bootstrap.sh`, the idempotent remote installer
- `ui/` — dashboard (Vite + React)
- `tests/` — `npm test` (node:test + fixtures; never touches the network)
- `data/` — job state + artifacts (gitignored)

---

# The job model

A **job** is one unit of work: `kind: "mesh"` (generate a mesh) or `kind: "solve"`
(BEM solve on a finished mesh). Jobs exist *before* they run.

```ts
status: "draft" | "queued" | "running" | "done" | "failed" | "cancelled"
```

- **draft** — fully configured, editable, **never** enqueued. This is what lets the
  board show 10 meshes ready and a rack of staged solves. A draft only starts when it
  is explicitly launched.
- **queued / running** — owned by the queue.
- **done / failed / cancelled** — terminal.

A job carries an execution **target** (where it runs) and an optional **batchId**
(what sweep it belongs to).

```ts
type JobTarget =
  | { type: "local" }
  | { type: "remote"; instanceId?: string; serverUrl: string; label?: string }

interface Job {
  id: string;              // 6-char
  kind: "mesh" | "solve";
  name: string;
  status: JobStatus;
  createdAt: string;       // ISO-8601
  updatedAt?: string;      // last draft edit
  launchedAt?: string;     // draft -> queued
  startedAt?: string;
  finishedAt?: string;
  generator?: string;      // mesh jobs
  params: Record<string, unknown>;
                           // mesh: generator params
                           // solve: { meshJobId, fmin?, fmax?, count?, backend?, symmetry? }
  target?: JobTarget;      // absent = local
  batchId?: string;        // "b_xxxxxxxx"
  batchName?: string;
  parentJobId?: string;    // solve -> its mesh job
  workspace?: string;
  threadId?: string;
  progress?: { stage: string; message: string; done?: number; total?: number };
  pid?: number;
  summary?: unknown;       // blabctl's result JSON
  error?: string;
  artifacts: { name: string; kind: ArtifactKind; url: string }[];
}
```

`ArtifactKind` is `"preview" | "plot" | "mesh" | "data" | "config" | "log"`.
Artifact URLs are always `/artifacts/<jobId>/<path>` — that shape is frozen (it is
embedded in already-persisted summaries and campaign logs).

## Queue lanes

Lanes are keyed by **target**, each with its own concurrency:

| lane key | contents | concurrency |
| --- | --- | --- |
| `local:mesh` | all mesh jobs (meshing never leaves the bridge host) | 1 |
| `local:solve` | solves with `target.type === "local"` | 1 — **not configurable**, the GPU rule |
| `remote:<instanceId>` or `remote:<serverUrl>` | solves pinned to that remote | from the target registry, default `BRIDGE_REMOTE_CONCURRENCY` (1) |

So a batch spanning three remote instances runs three solves in parallel while local
work stays strictly serialized. A remote solve is dispatched as
`blabctl solve … --backend server --server-url <url>`; the job's own `backend` param
is a *local* solver id and is not forwarded.

Remote execution therefore needs a blabctl that understands `--server-url`. The bridge
probes `blabctl solve --help` once (cached) and refuses a **remote launch** with a
legible 409 if the flag is definitely absent, rather than letting argparse exit 2 with a
cryptic log. The probe fails open: if it cannot tell (no python, a stubbed CLI, a
timeout) the launch proceeds. Staging a remote *draft* is always allowed.

## Persistence

`data/state.json` is `{ "version": 2, "jobs": [...] }`. A v1 ledger (`{ "runs": [...] }`,
`parentRunId`, `params.meshRunId`, job dirs under `data/runs/`) is migrated in place on
first load: the original is copied to `state.json.v1.bak` first, and `data/runs/` is
renamed to `data/jobs/`. Artifact URLs are untouched.

blabctl records **absolute** paths (`result.json`'s `cleaned_msh_path`, the solve
config's mesh reference, and the same strings mirrored into `job.summary`), and a later
solve re-reads its mesh job's `result.json` and checks those files exist. So the
directory move also rewrites the old root prefix everywhere it appears — in the ledger
and in every `.json` / `.toml` / `.cfg` / `.ini` / `.txt` / `.yaml` file under the job
dirs — in each of the three encodings those files use (native separators, JSON-escaped
backslashes, forward slashes). Without that, every already-generated mesh would become
unsolvable after the upgrade.

`tests/live-migration-check.mts` verifies a real ledger end to end; run it against a
**copy** of `bridge/data` before deploying a schema change.

---

# HTTP API

All bodies and responses are JSON. Errors are `{ "error": "<message>" }` with 400
(validation), 404 (unknown id) or 409 (wrong state).

### `GET /api/state`
The whole board in one shot (also the first SSE frame).
```jsonc
{
  "generators": [...], "generatorsError": null,
  "jobs": [Job, ...],                       // newest first
  "queue": { "lanes": [
    { "key": "local:solve", "kind": "solve", "targetId": "local",
      "label": "local solve", "concurrency": 1,
      "active": ["ab12cd"], "queued": ["ef34gh"] }
  ]},
  "targets": [ComputeTarget, ...],
  "batches": [BatchSummary, ...],
  "t3": { "configured": false },
  "publicUrl": "http://127.0.0.1:4821"
}
```

### `GET /api/targets`
`{ "targets": [ { "id", "type": "local"|"remote", "label", "serverUrl"?, "concurrency", "status"?, "info"? } ] }`
Always contains `local`. Remote entries come from the instance registry.

### `POST /api/generators/refresh`
Re-reads the python generator catalog. Returns the cache.

### `POST /api/generate` — create **and launch** a mesh job
Body: `{ generator: string, name?: string, params?: object, batchId?: string }`
→ `Job`

### `POST /api/solve` — create **and launch** one solve
Body: `{ meshJobId: string, name?, fmin?, fmax?, count?, backend?, symmetry?,`
`options?: {…same five…}, target?: Target, batchId?: string }`
→ `Job`. Requires the mesh job to be `done`.

`Target` accepts a string (`"local"`, a registry instance id, or an `http(s)` URL) or
an object `{ type?: "local"|"remote", instanceId?, serverUrl?, label? }`. A remote
target must resolve to a `serverUrl` (given directly or via a registered `instanceId`).

### `GET /api/jobs`
Query: `kind`, `status` (comma-separated), `batchId`, `parentJobId`, `limit`.
→ `{ "jobs": [Job, ...] }`

### `POST /api/jobs` — create **one draft**
Body: `{ kind: "mesh"|"solve", name?, generator?, params?, meshJobId?, fmin?, fmax?,`
`count?, backend?, symmetry?, options?, target?, batchId?, batchName? }`
→ `Job` with `status: "draft"`. A solve draft only requires the mesh job to *exist*
(it may still be running); "done" is checked at launch.

### `POST /api/jobs/batch` — create a sweep
```jsonc
{
  "kind": "solve",
  "name": "cd90 sweep",              // batch label; each job's name derives from it
  "meshJobIds": ["xclhn4", "9ycf74"],// or "meshJobId": "xclhn4"
  "options": { "fmin": 800, "fmax": 16000, "count": 24, "symmetry": "off" },
  "variants": [                      // one job per variant PER MESH (cross product)
    { "symmetry": "xy" },
    { "count": 48 },
    { "name": "hires", "count": 96, "fmax": 20000,
      "target": { "type": "remote", "instanceId": "vast-42" } }
  ],
  "target": { "type": "local" },     // default for variants that don't override
  "batchId": "b_reuse_me",           // optional; a new one is minted otherwise
  "launch": false                    // true = queue them immediately
}
```
Mesh batches use `generator` + `params` and variants of the form
`{ "name"?, "params": {...} }` (variant params are merged over the shared `params`).

Validation is all-or-nothing: an unknown mesh id, an unknown target or a cross product
over `MAX_BATCH_JOBS` (200) rejects the request before creating anything.

→ `{ batchId, batchName?, created: number, jobs: [Job…], launched: [{jobId, lane, queuePosition}], skipped: [{jobId, reason}] }`

### `POST /api/jobs/launch` — launch drafts
Body: `{ jobIds?: string[], batchId?: string }` (either or both).
→ `{ launched: [{ jobId, name, lane, queuePosition }], skipped: [{ jobId, reason }] }`
Non-drafts and solves whose mesh is not `done` are *skipped*, not errors — they stay
drafts and stay editable.

### `POST /api/jobs/cancel` — cancel a set
Body: `{ jobIds?: string[], batchId?: string }`
→ `{ cancelled: [{ jobId, status }], skipped: [{ jobId, reason }] }`
Queued jobs drop out immediately; running jobs have their process tree killed and
reach `cancelled` asynchronously; drafts are closed as `cancelled`.

### `GET /api/jobs/:id`
→ `Job` plus `{ lane: string|null, queuePosition: number }` (0 = not in a lane).

### `PATCH /api/jobs/:id` — edit a draft
Body: any of `{ name, generator, params, meshJobId, fmin, fmax, count, backend,`
`symmetry, options, target, batchId (null to ungroup), batchName }`
→ the updated `Job`. **409** if the job is not a draft.

### `POST /api/jobs/:id/launch`
→ same shape as `/api/jobs/launch`.

### `POST /api/jobs/:id/cancel`
→ `Job`.

### `POST /api/jobs/:id/rescan`
Re-ingests the job directory (post-hoc plots, `metrics.json` score/subscores). → `Job`.

### `DELETE /api/jobs/:id`
→ `{ ok: true }`. **409** while running, or while the job is the mesh of a
draft/queued/running solve.

### `GET /api/batches`
→ `{ "batches": [BatchSummary, ...] }`, newest batch first.
```ts
BatchSummary = { batchId, batchName?, kinds: ("mesh"|"solve")[], createdAt,
                 total: number,
                 counts: { draft, queued, running, done, failed, cancelled },
                 jobIds: string[] }
```

### `GET /api/batches/:batchId`
→ `BatchSummary & { jobs: [Job, ...] }`. 404 if the batch has no jobs.

### `POST /api/batches/:batchId/launch` → same as `/api/jobs/launch` with that batch.
### `POST /api/batches/:batchId/cancel` → same as `/api/jobs/cancel` with that batch.
Both 404 on a batch id with no jobs.
### `DELETE /api/batches/:batchId`
→ `{ deleted: string[] }`. **409** if any job in the batch is queued or running.

### `GET /api/events` (SSE)
First frame `{"type":"state","state":<GET /api/state>}`, then on every mutation
either `{"type":"job","job":<Job>}` or a full `{"type":"state",…}` frame. Treat it as
a change ping and refetch if you prefer.

### `GET /artifacts/:jobId/*`
Serves a file from the job's directory (path-traversal guarded).

## Live mesh preview

The mesh editor (the `+ Mesh` button) renders geometry as you edit. Previews are
**not jobs**: no board row, no run directory, no queue slot — they must never wait
behind a solve. `src/preview.ts` runs one warm python worker
(`py/mesh_preview_worker.py`) that holds the gmsh/meshio imports, which otherwise
dominate the round trip; a render costs ~0.2 s instead of ~1 s.

One request is in flight at a time (gmsh is not reentrant), with at most one
*queued* request per session — a newer edit supersedes the older one rather than
queueing behind it, so dragging a slider costs one render per settle. The worker is
started on first use and shut down after `BLAB_PREVIEW_IDLE_SECONDS` (default 300)
of silence, or after 200 renders, whichever comes first.

**Ath is the exception to "previews are independent."** `ath.exe` reads its config
from a single `ath/ath.cfg` beside the executable, and the runner reads
`OutputRootDir` back out of that same file to learn where a run landed — so two
Ath generations cannot overlap, or the second redirects the first's output into
its own directory. `blab.ath.ath_config_lock` is a cross-process lock file that
covers the write-then-run window, taken by mesh jobs and previews alike. A
preview waits only `BLAB_ATH_LOCK_TIMEOUT_S` (5 s) before answering 422 with
"another Ath generation is running", rather than hanging the editor behind a
multi-minute mesh job.

### `POST /api/preview`
```jsonc
{ "sessionId": "ed-…",       // [A-Za-z0-9_-]{1,64}; names a scratch directory
  "generator": "slot_cd_horn",
  "params": { … } }          // sparse; the generator's schema defaults fill the rest
```
→ `{ seq, wallsUrl, drivenUrl, triangles, vertices, bboxMm, mirrorAxes,
qualityWarning, vramBytes, elapsedMs, params }`, where `params` is the full set
*after* defaults. → `{ "superseded": true }` if a newer edit from the same session
overtook this one before it ran. **422** when the generator rejects the parameters —
a normal answer while someone is still typing, not a server fault.

### `GET /api/preview/:sessionId/:seq/:file`
The two STLs a render produced (`preview_walls.stl`, `preview_driven.stl`, allowlisted).
Each render gets its own `seq` directory, so a URL's contents never change; only the
newest three are kept.

### `DELETE /api/preview/:sessionId`
Drops that editor's scratch geometry. The UI calls this on close; the bridge also
sweeps sessions untouched for 30 minutes, because browsers close without warning.

---

# MCP tools

Every tool takes an optional `workspace` (your absolute cwd) so jobs are linked to
your t3 thread and solve completions wake you up.

| tool | arguments |
| --- | --- |
| `list_generators` | `workspace?` |
| `list_targets` | `workspace?` |
| `generate` | `generator`, `params?`, `name?`, `workspace?` — creates **and runs** one mesh, waits up to 120 s |
| `solve` | `mesh_job_id`, `fmin?`, `fmax?`, `count?`, `backend?`, `symmetry?`, `target?`, `name?`, `batch_id?`, `workspace?` — creates **and queues** one solve, returns immediately |
| `create_mesh_jobs` | `generator`, `params?`, `variants?: [{name?, params?}]`, `name?`, `batch_id?`, `launch?`, `workspace?` |
| `create_solve_jobs` | `mesh_job_ids: string[]`, `variants?: [{name?, target?, fmin?, fmax?, count?, backend?, symmetry?}]`, `fmin?`, `fmax?`, `count?`, `backend?`, `symmetry?`, `target?`, `name?`, `batch_id?`, `launch?`, `workspace?` |
| `update_job` | `job_id`, `name?`, `params?`, `mesh_job_id?`, `fmin?`, `fmax?`, `count?`, `backend?`, `symmetry?`, `target?`, `batch_id?` (empty string ungroups), `workspace?` |
| `launch_jobs` | `job_ids?: string[]`, `batch_id?`, `workspace?` |
| `cancel_jobs` | `job_ids?: string[]`, `batch_id?`, `workspace?` |
| `delete_job` | `job_id`, `workspace?` |
| `get_job` | `job_id`, `workspace?` |
| `list_jobs` | `kind?`, `status?`, `batch_id?`, `limit?`, `workspace?` |
| `spawn_thread` | `title`, `prompt`, `workspace?` |

`target` on any tool is the same union as the HTTP API: a string id/URL, or
`{type, instanceId?, serverUrl?}`.

## Adding a generator

Drop a module in `py/generators/` exposing `SCHEMA` (id/title/description + JSON-Schema
params) and `generate(params, out_dir, name, emit)`. It appears in the UI form builder
and as an MCP `generate` target on next refresh — no server changes needed.

## Solving on another machine

`blabctl solve --backend server --server-url http://<host>:8765` sends the whole job
(config + mesh, inlined) to a `blab server` elsewhere and streams results back, so a
rented GPU box needs no shared filesystem. `blabctl remote-check --server-url …`
preflights one: reachability, which solver it runs, whether it accepts
symmetry-reduced meshes, and its GPU/VRAM. `BLAB_SERVER_URL` and `BLAB_SERVER_TOKEN`
supply defaults. See `docs/Boundary Lab Server.md`.

The bridge drives all of that through a job's `target`: pick a remote and the queue
gives it its own lane and dispatches with `--backend server --server-url`.

## Adding remote compute

Call `registerTargetProvider()` from `src/targets.ts` at startup with a function
returning `ComputeTarget[]`. The vast.ai instance registry does exactly this — its
ready instances become selectable targets — and nothing else in the bridge needs to
know about a specific cloud provider.
