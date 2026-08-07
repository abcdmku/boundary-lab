# Boundary Lab Server

Boundary Lab can run a local or LAN-accessible solve server. The GUI submits a complete solve request over HTTP, uploads the required mesh assets with the job, and streams per-frequency results back as newline-delimited JSON events.

## Starting The Server

Run the server with an explicit solver selector:

```bash
blab server --host 127.0.0.1 --port 8765 --solver bempp_cpu
blab server --host 127.0.0.1 --port 8765 --solver beat_cpu --julia-threads auto
blab server --host 127.0.0.1 --port 8765 --solver beat_cuda --julia-threads auto
```

For LAN use, bind to the machine's LAN address or to all interfaces:

```bash
blab server --host 0.0.0.0 --port 8765 --solver beat_cuda
```

Then use `http://<server-ip>:8765` as the GUI's Solve Server URL.

## Solver Selectors

Supported `--solver` values:

- `bempp_cpu`: Bempp OpenCL CPU backend.
- `beat_cpu`: BEAT Engine CPU backend through Julia.
- `beat_cuda`: BEAT Engine CUDA backend through Julia.
- `beat_rocm`: BEAT Engine ROCm selector. This is accepted by the server CLI, but the ROCm implementation is currently a placeholder and reports not implemented.

BEAT Engine server options are intentionally narrow:

- `--julia-executable`: Julia executable path. Defaults to `julia`.
- `--julia-threads`: Julia thread count. Defaults to `auto`.

The server defaults to `--solver bempp_cpu` when no solver is specified.

## GUI Workflow

In the Boundary Lab GUI:

1. Open `Edit > Preferences`.
2. Set `BEM Solver` to `Server`.
3. Set `Solve Server URL` to the server address, such as `http://127.0.0.1:8765`.
4. Click `Check Server`.
5. Confirm the server info dialog, then accept Preferences.

`Check Server` calls `GET /health` and updates the application's view of server-advertised capabilities. This matters for features such as BEAT Engine server-side X/XY symmetry. If Boundary Lab starts with `BEM Solver` already set to `Server`, it also runs a silent startup `GET /health` probe with a 5 second timeout. Failed startup probes do not interrupt application launch; the GUI simply falls back to the conservative unavailable state until a later successful check.

## Remote Solves From The Bridge CLI

`bridge/py/blabctl.py` can send a solve to a server on another machine. Point it
at the server and the rest of the workflow is unchanged:

```bash
python bridge/py/blabctl.py remote-check --server-url http://10.0.0.5:8765
python bridge/py/blabctl.py solve --mesh-run runs/mesh --out runs/solve \
  --backend server --server-url http://10.0.0.5:8765
```

- `--server-url` accepts `http://` or `https://` with an optional port and base
  path. It is validated at argument-parse time, so a typo fails immediately
  rather than after a mesh upload. Credentials embedded in the URL are rejected.
- Without `--server-url`, the `BLAB_SERVER_URL` environment variable is used,
  and failing that `http://127.0.0.1:8765` — a server on this machine.
- `--server-token` (or `BLAB_SERVER_TOKEN`) sends an `Authorization: Bearer`
  header on every request. `blab server` itself does not authenticate; this is
  for a reverse proxy or tunnel fronting it, which is the usual arrangement for
  a rented GPU box.
- `--server-timeout` bounds the `/health` probe (default 10 s).

`remote-check` probes `GET /health` and emits one NDJSON result line with the
server's solver, capability flags, `supports_symmetry`, and GPU name plus
total/free VRAM when the server reports one. Run it before pointing a campaign
at a new machine. An unreachable server produces `{"event":"result","ok":false,
"error":"... is not reachable: ..."}` and exit code 1.

`solve --backend server` probes `/health` once up front and uses it for two
decisions: whether a symmetry-reduced mesh may be submitted (see below), and
which GPU the solve's estimated peak VRAM is compared against. For a remote
solve that comparison is made against the *server's* card, not the client's;
as everywhere else in Boundary Lab, an over-capacity estimate warns and the
solve proceeds.

## Long-Running And Interrupted Solves

The event stream is designed to survive a broken link, which matters once the
server is a machine on the other side of the internet:

- The server writes a `heartbeat` event roughly every 15 seconds while a job is
  idle. Heartbeats are not stored events and carry no index, so they never
  affect a client's resume point. Clients that do not recognise the type ignore
  it.
- The client reads with a 120 second idle timeout. On a timeout, reset, or early
  close it reconnects with `GET /jobs/{id}/events?since=<next index>`, which
  replays the stored event log from exactly where it left off — no results are
  lost and the job is never resubmitted. It gives up after 5 fruitless attempts,
  reporting the job id so the job can be inspected or cancelled by hand. A
  reconnect that does deliver events resets the budget.
- Cancellation works the same locally and remotely: `POST /jobs/{id}/cancel` is
  sent once per stop request, and retried on the next pass if that POST failed.

## Symmetry Support

Symmetry is negotiated with the server, not assumed from the client's backend
table. The `server` backend's static registry entry reports no symmetry support
because it describes the protocol, not the far end; what a particular server can
compute is read from its `/health` payload at session-creation time and that
probe is authoritative.

A symmetry-reduced mesh is the fundamental domain, not the whole radiator, so
sending one to a server that will not reconstruct the reflections produces
plausible-looking but wrong pressures. Boundary Lab therefore submits a reduced
mesh only after `/health` affirmatively advertises
`capabilities.supports_symmetry` in that probe. An unreachable or silent server
is treated as "no", and the solve fails with an explanatory error rather than
proceeding.

Server-side symmetry depends on the configured server solver:

- `beat_cpu` and `beat_cuda` advertise symmetry support and can solve `off`, `x`, and `xy` symmetry requests.
- `bempp_cpu` does not support symmetry acceleration.
- `beat_rocm` advertises the BEAT Engine shape but is not numerically implemented yet.

The GUI uses the checked server health payload to decide whether the Mesh Config symmetry control is enabled while the selected BEM Solver is `Server`.

For symmetry solves, the GUI still prepares and uploads the reduced-domain mesh files. The server does not need access to the client's original local paths.

## Job API

The server exposes a small HTTP API:

- `GET /health`: returns status, configured solver, backing backend ID, capability flags, whether that solver uses the GPU (`solver_uses_gpu`), and the serving machine's GPU as `{"name", "total_bytes", "free_bytes"}` (`null` when nvidia-smi is unavailable). The GPU block is briefly cached, so `/health` stays cheap to poll.
- `POST /jobs`: submits a solve request with `SimulationConfig`, `frequencies_hz`, and optional uploaded assets.
- `GET /jobs/{job_id}`: returns job status and artifact links.
- `GET /jobs/{job_id}/events?since=0`: streams job events as newline-delimited JSON.
- `POST /jobs/{job_id}/cancel`: requests cancellation.
- `GET /jobs/{job_id}/artifacts/result.npz`: downloads the completed result bundle.

Typical event flow:

```text
queued
started
initialized
result
heartbeat        (idle keepalive; no index, not stored)
result
...
completed
```

Failures are emitted as `failed` events with an error message. Cancellation is cooperative and may wait for the current in-flight frequency solve to finish.

## Artifacts

Completed jobs write a compressed `result.npz` under the configured artifact directory. By default this is:

```text
runs/server_jobs
```

Override it with:

```bash
blab server --artifact-dir runs/my_server_jobs --solver beat_cpu
```

## Operational Notes

- Keep `--max-running-jobs 1` unless you have intentionally tested concurrent jobs for the selected backend and hardware.
- BEAT Engine CUDA jobs should usually be run one at a time per GPU.
- Use `--log-level INFO` for normal pod logs, or `--log-level DEBUG` when diagnosing request and job flow.
- The GUI uploads mesh assets with every server job, so the server can run on another machine without shared filesystem paths.
- If a BEAT Engine server fails during startup, check that the matching Julia environment has been instantiated.

Install examples:

```bash
julia --project=src/blab/solvers/julia_local -e "using Pkg; Pkg.instantiate()"
julia --project=src/blab/solvers/julia_cuda -e "using Pkg; Pkg.instantiate()"
```
