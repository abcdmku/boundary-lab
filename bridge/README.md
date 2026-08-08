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

## The dashboard

Two views over one state, plus one dialog for a job itself:

- **Designs** — what is being built, and the ledger of every job. Projects → mesh
  lineage → the solves of each mesh. A variant tile names only the parameters that
  differ from its lineage root; the solves of a mesh are chips inside its tile, because
  that is where they belong. Search matches meshes *and* their solves; the status chips
  narrow to active / planned / failed work. Clicking any tile or chip opens the job.
- **Job dialog** — one job in full: config, geometry, plots, log, and its actions
  (launch, cancel, rescan, delete). Opened from a mesh tile, a solve chip, or a card on
  the schedule board.
- **Schedule** — *when, where and in what order* it runs, and **the machines themselves**.
  One column per target, a **Planned** backlog on the left, cards you drag between them.
  Dropping a card on a machine runs it there; dropping it back on the backlog holds it
  as a draft with its configuration intact. Alt + arrow keys do the same from the
  keyboard. Column headers carry slot pips (where supported, click pip *n* to allow *n*
  concurrent jobs),
  a forecast bar showing the shape of the queue, the time the machine expects to be
  free, and — for an unusable target — why. The **+ Machine** column at the end opens
  the rental dialog.
There is deliberately no flat "jobs" list and no separate "compute" view. Both were
second renderings of records these two views already show — the jobs board relisted every
mesh and solve that Designs groups properly, and the compute view relisted the machines
that *are* the schedule's columns. Two places showing one truth is one too many. What each
uniquely owned survived: the job detail panel became the **job dialog**, and renting a GPU
became the **Machines** dialog, reached from the board's + Machine column or the burn pill.

The one thing with no new home is multi-select **bulk delete** of finished jobs. Launch,
hold and reorder in bulk are the schedule board; per-job delete is in the job dialog.

## Configuration (env)

| Var | Default | |
| --- | --- | --- |
| `PORT` | `4821` | |
| `BRIDGE_PUBLIC_URL` | `http://127.0.0.1:4821` | base for URLs handed to agents |
| `PYTHON` | `python` | interpreter with `blab` installed |
| `BLAB_JULIA_EXECUTABLE` | Julia 1.12.6 install path | passed to solver children |
| `BRIDGE_REMOTE_CONCURRENCY` | `1` | default concurrent jobs per remote instance |
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

- `src/` — server: config, store (projects + job ledger), targets (slots/devices), queue
  (per-target lanes), estimate (durations and lane forecasts), MCP tools, t3 client
- `src/vast/` — vast.ai compute provider: client, instance registry, SSH provisioning, `/api/vast` routes
- `py/` — Python glue: `blabctl.py` (NDJSON CLI) + `generators/` (ATH waveguide, procedural axisymmetric horn)
- `provision/` — `vast_bootstrap.sh`, the idempotent remote installer
- `ui/` — dashboard (Vite + React)
- `tests/` — `npm test` (node:test + fixtures; never touches the network)
- `data/` — job state + artifacts (gitignored)

---

# The model

```
project ──┬── mesh (root)          the geometry family being explored
          │     ├── mesh variant   same design, different params
          │     └── mesh variant
          └── each mesh ── many solves    coarse preview, fine verification,
                                          symmetry on/off, a remote rerun …
```

Three shapes, and the UI is built on them:

- **One mesh has many solves.** A coarse look and a fine verification of one geometry
  are two solves of *one* mesh, not two meshes. Solves carry `parentJobId` = the mesh
  they read, and the designs view renders them inside their mesh's tile.
- **A mesh can be a variant of another mesh.** `variantOf` records the lineage, so an
  optimization campaign's twenty trials read as a chain of parameter edits rather than
  twenty unrelated jobs. `POST /api/jobs/:id/variant` (MCP: `create_mesh_variant`) is
  the way to make one — it patches the parent's params, so only what changes travels.
- **A project is the design.** It holds a mesh lineage and every solve computed from
  it. Projects are optional (unfiled work shows under "Unassigned") and are referenced
  by id *or by name* — a name that does not exist yet is created, and the same name
  always resolves to the same project, so a campaign never has to bootstrap one.

`batchId` still records which single request created a job (so a sweep can be cancelled
as a unit), but grouping for humans is the project.

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
  projectId?: string;      // "p_xxxxxxxx"; absent = unassigned
  variantOf?: string;      // mesh -> the mesh it was derived from
  priority?: number;       // run order within a lane; lower runs first
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

## Queue lanes and slots

Lanes are keyed by **target**. A lane runs up to `slots` jobs at once:

| lane key | contents | slots |
| --- | --- | --- |
| `local:mesh` | all mesh jobs (meshing never leaves the bridge host) | 1, fixed |
| `local:solve` | solves with `target.type === "local"` | 1 by default, user-settable |
| `remote:<instanceId>` or `remote:<serverUrl>` | solves pinned to that remote | target registry, default `BRIDGE_REMOTE_CONCURRENCY` (1) |

**One GPU, one job** is the default everywhere and what you get by doing nothing. It is
no longer hardcoded, because the rule is right as a default and wrong as a law: a
two-GPU box wants one solve per card. `PATCH /api/targets/:id {slots, devices}` (MCP:
`set_target_slots`, UI: the slot pips on a schedule column) sets it per target.

Listing `devices: ["0","1"]` pins one GPU per slot — slot *i*'s child is spawned with
`CUDA_VISIBLE_DEVICES`/`HIP_VISIBLE_DEVICES` set to `devices[i]`, so the cards are
genuinely divided rather than two processes racing for card 0. Device pinning applies
to **local** lanes only; a remote job's blabctl just forwards an HTTP request, and the
remote server picks its own device. Raising `slots` past the number of pinned devices
is allowed and reported with a warning: solves sharing a card share its VRAM, so a mesh
that fits alone can fail alongside another.

Managed Vast servers are currently provisioned with one server-side worker, so their
single slot is provider-locked. The UI explains this instead of offering extra bridge-side
slots whose processes would only wait inside the remote server.

**Run order** inside a lane is the job's persisted `priority`, not arrival time, so an
order arranged on the schedule board survives a bridge restart.

So a batch spanning three remote instances runs three solves in parallel while local
work stays serialized (unless you widen it). A remote solve is dispatched as
`blabctl solve … --backend server --server-url <url>`; the job's own `backend` param
is a *local* solver id and is not forwarded.

Remote execution therefore needs a blabctl that understands `--server-url`. The bridge
probes `blabctl solve --help` once (cached) and refuses a **remote launch** with a
legible 409 if the flag is definitely absent, rather than letting argparse exit 2 with a
cryptic log. The probe fails open: if it cannot tell (no python, a stubbed CLI, a
timeout) the launch proceeds. Staging a remote *draft* is always allowed.

## Estimates

Cards on the schedule board carry time, and the numbers are **measured, not modelled**.
There is no built-in performance curve, because a useful one does not exist: a solve is
roughly O(triangles²) per frequency point while it fits in VRAM and then falls off a
cliff when it does not (this machine: 6.8k triangles ≈ 30 s, 13.6k ≈ an hour).

- A **running** job with progress counters is timed from its own counters —
  `elapsed/done × total`. Nothing beats it.
- A **waiting** job is scaled from the most similar solve this bridge has actually
  finished: nearest neighbour in log(triangles), then linear in frequency count and
  quadratic in triangles. Picking the neighbour first means the scaling only ever
  interpolates locally, never across the cliff.
- With **no comparable history**, the answer is `null` and the UI shows `—`. An
  estimate that rests on one sample is drawn quieter (`weak: true`) rather than hidden.

`GET /api/state` returns `estimates` (per unfinished job) and a per-lane `forecast`
walking the lane the way the queue will — `slots` at a time, each waiting job dropping
into whichever slot frees first.

## Persistence

`data/state.json` is `{ "version": 3, "jobs": [...], "projects": [...] }`, plus
feature-owned sections (`vast`, `targetSlots`). Older ledgers are migrated in place on
first load, with the original copied to `state.json.v<n>.bak` first:

- **v1 → v2** — `{ "runs": [...] }`, `parentRunId`, `params.meshRunId`, job dirs under
  `data/runs/`; `data/runs/` is renamed to `data/jobs/` and artifact URLs are untouched.
- **v2 → v3** — projects, mesh lineage and run order. A v2 *mesh batch* was already a
  family of variants (one generator, one base params, N overrides), so each becomes a
  project: its oldest mesh is the lineage root and the rest become that root's variants.
  Solves inherit their mesh's project. Nothing beyond that is invented — meshes created
  one at a time stay unassigned rather than each becoming a single-mesh project.

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
  "projects": [Project, ...],               // oldest first
  "queue": { "lanes": [
    { "key": "local:solve", "kind": "solve", "targetId": "local",
      "label": "local solve", "concurrency": 2, "devices": ["0", "1"],
      "slots": [{ "jobId": "ab12cd", "slot": 0, "device": "0" }],
      "active": ["ab12cd"], "queued": ["ef34gh"],
      "forecast": { "entries": [{ "jobId", "startsInSeconds", "finishesInSeconds",
                                  "remainingSeconds", "basis" }],
                    "clearInSeconds": 419, "backlogSeconds": 567 } }
  ]},
  "targets": [ComputeTarget & { throughput: {finished, medianSeconds} }, ...],
  "estimates": { "ef34gh": { "remainingSeconds": 303, "totalSeconds": 303,
                             "basis": "history", "weak": false } },
  "batches": [BatchSummary, ...],
  "t3": { "configured": false },
  "publicUrl": "http://127.0.0.1:4821"
}
```
`basis` is `"measured"` (running, from its own counters) | `"history"` | `"cross-target"`
| `"elapsed"` | `"none"`. `Project` is
`{ id, name, createdAt, updatedAt?, goal?, color?, archived? }`.

### `GET /api/targets`
`{ "targets": [ { "id", "type": "local"|"remote", "label", "serverUrl"?, "concurrency", "devices"?, "slotsOverridden"?, "slotsLocked"?, "slotLockReason"?, "status"?, "info"? } ] }`
Always contains `local`. Remote entries come from the instance registry.

### `PATCH /api/targets/:id` — slots and GPU pinning
Body: `{ slots?: number|null, devices?: string[]|null }` (`null` clears the override).
→ `{ target: ComputeTarget, warning: string|null }`. `warning` is set when more solves
than pinned devices will share a card's VRAM. `slots` is capped at 16.

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

### `POST /api/jobs/hold` — queued → draft
Body: `{ jobIds?: string[], batchId?: string }`
→ `{ held: [{ jobId, name }], skipped: [{ jobId, reason }] }`. The undo for a launch: a
job that has not started yet goes back to being an editable draft with its configuration
intact, instead of being cancelled and rebuilt. Running jobs are *skipped* with a reason.

### `POST /api/jobs/:id/variant` — derive a mesh from this mesh
Body: `{ params?: object, name?: string, project?: string, launch?: boolean }`
→ the new mesh `Job`, with `variantOf` set and the parent's project inherited.
`params` is a **patch** over the parent's params; the name defaults to the parent's
plus what changed.

---

## Projects

### `GET /api/projects` → `{ "projects": [Project, ...] }`
### `POST /api/projects` — `{ name, goal?, color? }` → `Project`
### `PATCH /api/projects/:id` — `{ name?, goal?, color?, archived? }` → `Project`
### `DELETE /api/projects/:id`
→ `{ unassigned: number }`. The project is forgotten; **its jobs are not deleted**,
only unassigned.

### `POST /api/projects/assign`
Body: `{ jobIds: string[], projectId: string|null }` (`null` unassigns).
→ `{ moved: string[] }`. Moving a **mesh** takes its solves and its variants with it.

---

## The schedule board

### `POST /api/schedule` — drag-and-drop moves
```jsonc
{ "moves": [ { "jobId": "ab12cd", "column": "local",   "position": 0 },
             { "jobId": "ef34gh", "column": "planned" } ] }
```
`column` is a compute target id (run it there, launching it if it was a draft) or
`"planned"` (hold it back as a draft). `position` is the 0-based place in that column's
waiting line; omit to append. One card per entry, deliberately — two clients
rearranging at once merge instead of clobbering.

→ `{ moved: [{ jobId, column, lane, queuePosition }], skipped: [{ jobId, reason }] }`

Nothing here destroys work. A **running** job refuses to move (it is already on a
machine) and is reported under `skipped`; a mesh aimed at a remote column is refused
too, since meshing never leaves the bridge host.

### `POST /api/schedule/lane` — rewrite one lane's whole waiting order
Body: `{ laneKey: "local:solve", jobIds: [...] }` → `{ order: string[] }`.
Ids not waiting in that lane are ignored; waiting jobs the caller omitted keep their
relative place at the end rather than falling out of the queue.

---

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

---

# MCP tools

Every tool takes an optional `workspace` (your absolute cwd) so jobs are linked to
your t3 thread and solve completions wake you up.

| tool | arguments |
| --- | --- |
| `list_generators` | `workspace?` |
| `list_targets` | `workspace?` |
| `list_projects` | `workspace?` — designs, with mesh/variant/solve counts and best score |
| `generate` | `generator`, `params?`, `name?`, `project?`, `variant_of?`, `workspace?` — creates **and runs** one mesh, waits up to 120 s |
| `create_mesh_variant` | `mesh_job_id`, `params?` (a **patch**), `name?`, `project?`, `launch?`, `workspace?` — the way a campaign should produce each trial |
| `solve` | `mesh_job_id`, `fmin?`, `fmax?`, `count?`, `backend?`, `symmetry?`, `target?`, `name?`, `batch_id?`, `workspace?` — creates **and queues** one solve, returns immediately |
| `create_mesh_jobs` | `generator`, `params?`, `variants?: [{name?, params?}]`, `name?`, `batch_id?`, `project?`, `launch?`, `workspace?` |
| `create_solve_jobs` | `mesh_job_ids: string[]`, `variants?: [{name?, target?, fmin?, fmax?, count?, backend?, symmetry?}]`, `fmin?`, `fmax?`, `count?`, `backend?`, `symmetry?`, `target?`, `name?`, `batch_id?`, `project?`, `launch?`, `workspace?` |
| `schedule_jobs` | `moves: [{job_id, column, position?}]` — `column` is a target id or `"planned"` |
| `set_target_slots` | `target_id`, `slots?` (0 clears), `devices?: string[]` (`[]` clears) |
| `update_job` | `job_id`, `name?`, `params?`, `mesh_job_id?`, `fmin?`, `fmax?`, `count?`, `backend?`, `symmetry?`, `target?`, `batch_id?` (empty string ungroups), `workspace?` |
| `launch_jobs` | `job_ids?: string[]`, `batch_id?`, `workspace?` |
| `cancel_jobs` | `job_ids?: string[]`, `batch_id?`, `workspace?` |
| `delete_job` | `job_id`, `workspace?` |
| `get_job` | `job_id`, `workspace?` — a mesh also reports its solves and variants |
| `list_jobs` | `kind?`, `status?`, `batch_id?`, `project_id?`, `mesh_job_id?`, `limit?`, `workspace?` |
| `spawn_thread` | `title`, `prompt`, `workspace?` |

`project` on any tool is a project id **or a name** — an unknown name creates one, a
known one resolves to it.

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
