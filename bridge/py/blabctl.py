"""blabctl: NDJSON command-line bridge to Boundary Lab (blab).

Every invocation writes one JSON object per line to stdout. Progress lines are
{"event": "progress", "stage": ..., "message": ..., "done": N, "total": M} and the
final line is always {"event": "result", "ok": true/false, ...}.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BRIDGE_DIR.parents[1]
DEFAULT_JULIA_EXE = Path("C:/Users/Borg/AppData/Local/Programs/Julia-1.12.6/bin/julia.exe")

# --name becomes filename stems like <name>.msh / <name>.cfg inside the run
# directory. Restrict it to a safe basename: no path separators, no leading
# dot (rules out "." / ".."), no absolute paths.
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$")


def safe_name(value: str) -> str:
    if not SAFE_NAME_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(
            f"invalid --name {value!r}: use letters, digits, '.', '_' or '-' only "
            "(no path separators, must not start with '.', max 80 chars)"
        )
    return value


sys.path.insert(0, str(BRIDGE_DIR))

# Stray prints from blab/gmsh/matplotlib go to stderr; stdout stays strict NDJSON.
_NDJSON_OUT = sys.stdout
sys.stdout = sys.stderr


def emit(obj: dict) -> None:
    _NDJSON_OUT.write(json.dumps(obj) + "\n")
    _NDJSON_OUT.flush()


def progress(stage: str, message: str, done: int | None = None, total: int | None = None) -> None:
    event = {"event": "progress", "stage": stage, "message": message}
    if done is not None:
        event["done"] = done
    if total is not None:
        event["total"] = total
    emit(event)


def server_url_arg(value: str) -> str:
    """argparse type for --server-url: reject a bad URL before any work starts."""
    from blab.solvers.http_server import normalize_server_url

    try:
        return normalize_server_url(value, default=None)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def resolve_server_url(cli_value: str | None) -> str:
    """The solve server to talk to: --server-url, else BLAB_SERVER_URL, else localhost."""
    from blab.solvers.http_server import DEFAULT_SERVER_URL, normalize_server_url

    if cli_value:
        return normalize_server_url(cli_value, default=None)
    env_value = os.environ.get("BLAB_SERVER_URL", "").strip()
    if env_value:
        return normalize_server_url(env_value, default=None)
    return DEFAULT_SERVER_URL


def resolve_server_token(cli_value: str | None) -> str | None:
    return (cli_value or os.environ.get("BLAB_SERVER_TOKEN", "")).strip() or None


def probe_server_health(server_url: str, *, timeout_s: float, auth_token: str | None) -> dict:
    """GET /health, or raise with a message that names the URL that failed."""
    from blab.solvers.http_server import query_server_health

    try:
        return query_server_health(server_url, timeout_s=timeout_s, auth_token=auth_token)
    except Exception as exc:
        raise RuntimeError(f"Solve server at {server_url} is not reachable: {type(exc).__name__}: {exc}") from exc


def resolve_julia_exe(cli_value: str | None) -> str:
    if cli_value:
        return cli_value
    env_value = os.environ.get("BLAB_JULIA_EXE", "").strip()
    if env_value:
        return env_value
    if DEFAULT_JULIA_EXE.exists():
        return str(DEFAULT_JULIA_EXE)
    return "julia"


def cmd_list_generators(_args: argparse.Namespace) -> dict:
    from generators import load_generators

    return {
        "generators": [
            {
                "id": module.SCHEMA["id"],
                "title": module.SCHEMA["title"],
                "description": module.SCHEMA["description"],
                "params": module.SCHEMA["params"],
            }
            for module in load_generators().values()
        ]
    }


def _generate_vram_estimates(result: dict) -> dict:
    """Informational peak-VRAM estimates for the meshes this generate produced.

    Generation never refuses a mesh for its size: a big mesh is a hardware
    capacity question, answered at solve time against the machine that will
    actually run it. These numbers let callers (and the solve tool, before the
    solve is dequeued) see what they are about to ask for.
    """
    import vram
    from generators import mesh_dof_counts

    estimates: dict[str, int] = {}
    counts: dict[str, dict] = {}
    candidates = [("off", result.get("cleaned_msh_path"))]
    mirror_axes = [str(axis).lower() for axis in (result.get("mirror_axes") or [])]
    if result.get("reduced_msh_path") and mirror_axes:
        candidates.append(("".join(sorted(mirror_axes)), result["reduced_msh_path"]))
    for symmetry, path in candidates:
        if not path or not Path(path).exists():
            continue
        try:
            vertices, triangles = mesh_dof_counts(Path(path))
        except (OSError, ValueError):
            continue
        estimates[symmetry] = vram.estimate_solve_vram_bytes(triangles=triangles, vertices=vertices)
        counts[symmetry] = {"vertices": vertices, "triangles": triangles}

    gpu = vram.detect_gpu_memory()
    return {
        "estimate_bytes": estimates,
        "estimate_human": {key: vram.format_bytes(value) for key, value in estimates.items()},
        "mesh_counts": counts,
        "gpu": gpu,
    }


def cmd_generate(args: argparse.Namespace) -> dict:
    from generators import apply_defaults, export_viewer_stls, load_generator
    from preview import render_mesh_preview

    generator = load_generator(args.generator)
    raw_params = json.loads(Path(args.params).read_text(encoding="utf-8")) if args.params else {}
    params = apply_defaults(raw_params, generator.SCHEMA)
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    result = generator.generate(params, out_dir, args.name, emit)
    result["generator"] = args.generator
    result["name"] = args.name

    result["vram"] = _generate_vram_estimates(result)

    driven_tags = tuple(sorted({int(radiator["tag"]) for radiator in result["radiators"]})) or (
        int(result["driven_tag"]),
    )
    cleaned_msh = Path(result["cleaned_msh_path"])
    progress("plot", "Exporting viewer STLs")
    result["viewer_stl"] = export_viewer_stls(cleaned_msh, out_dir, args.name, driven_tags)

    progress("plot", "Rendering 3D preview")
    preview_png = out_dir / f"{args.name}_preview.png"
    render_mesh_preview(cleaned_msh, preview_png, driven_tags=driven_tags)
    result["preview_png"] = str(preview_png)

    (out_dir / "result.json").write_text(json.dumps({"ok": True, **result}, indent=2), encoding="utf-8")
    return result


def cmd_estimate(args: argparse.Namespace) -> dict:
    """Closed-form dry run: triangle count and outer bbox without building a mesh.

    Lets a designer check a proposal against a campaign's triangle and
    size_limit_mm gates before spending a trial on it. Parameter validation is
    the generator's own, so an impossible combination fails here exactly as it
    would in `generate` — just in milliseconds and with no job.
    """
    from generators import apply_defaults, load_generator

    generator = load_generator(args.generator)
    raw_params = json.loads(Path(args.params).read_text(encoding="utf-8")) if args.params else {}
    params = apply_defaults(raw_params, generator.SCHEMA)
    result: dict = {"generator": args.generator, "params": params}
    for key, func in (("estimated_triangles", "estimate_triangles"), ("estimated_bbox_mm", "estimate_bbox_mm")):
        estimator = getattr(generator, func, None)
        result[key] = estimator(params) if estimator is not None else None
    if result["estimated_bbox_mm"] is None:
        progress("estimate", f"{args.generator} has no closed-form bbox estimator; generate to learn its size")
    return result


def cmd_preview(args: argparse.Namespace) -> dict:
    from generators import mesh_stats
    from preview import render_mesh_preview

    msh_path = Path(args.mesh).resolve()
    out_png = Path(args.out).resolve()
    driven_tags = tuple(int(tag) for tag in args.driven_tag) if args.driven_tag else ()
    progress("plot", f"Rendering {msh_path.name}")
    render_mesh_preview(msh_path, out_png, driven_tags=driven_tags)
    triangles, bbox_mm = mesh_stats(msh_path)
    return {"preview_png": str(out_png), "triangles": triangles, "bbox_mm": bbox_mm}


def _write_solve_toml(config_path: Path, mesh_file: Path, radiators: list[dict]) -> None:
    lines = [
        "# generated by blabctl solve (meshes/radiators consumed by `blab solve --config`;",
        "# frequency range etc. are CLI flags there and stored in result.json here)",
        "",
        "[[meshes]]",
        'name = "mesh"',
        f'file = "{mesh_file.as_posix()}"',
        "scale_factor = 0.001  # generated meshes are in mm",
        "",
    ]
    for radiator in radiators:
        lines += [
            "[[radiators]]",
            f'name = "{radiator["name"]}"',
            f"tag = {int(radiator['tag'])}",
            f"level_db = {float(radiator.get('level_db', 0.0))}",
            f"polarity = {int(radiator.get('polarity', 1))}",
            f"delay_ms = {float(radiator.get('delay_ms', 0.0))}",
            "",
        ]
    config_path.write_text("\n".join(lines), encoding="utf-8")


def cmd_solve(args: argparse.Namespace) -> dict:
    import numpy as np

    from blab.config import SimulationConfig
    from blab.postprocess import PrepConfig, prepare_visualization_data
    from blab.protocol import radiator_from_dict
    from blab.solvers.base import SolveRequest
    from blab.solvers.registry import create_backend, normalize_backend_id

    backend_id = normalize_backend_id(args.backend)
    if args.server_url and backend_id != "server":
        # Silently solving locally when the caller named a remote machine is the
        # kind of thing that only shows up in the timings.
        raise RuntimeError(
            f"--server-url {args.server_url} only applies to --backend server, but --backend is "
            f"'{args.backend}' (backend '{backend_id}' runs locally). Add --backend server, or drop --server-url."
        )

    mesh_run = Path(args.mesh_run).resolve()
    generate_result = json.loads((mesh_run / "result.json").read_text(encoding="utf-8"))
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    symmetry = args.symmetry
    mesh_file = Path(generate_result["cleaned_msh_path"])
    if symmetry != "off":
        reduced = generate_result.get("reduced_msh_path")
        if not reduced:
            raise RuntimeError(
                "symmetry requires the unmirrored reduced mesh, but the generate result has no reduced_msh_path."
            )
        # The reduced mesh is only valid for the symmetry it was reduced with:
        # a quadrants=1 quarter mesh (mirror axes xy) solved with symmetry="x"
        # passes BEAT's positive-X check but reconstructs only the X reflection,
        # silently producing wrong pressures. Require an exact match with the
        # mirror axes the generator detected from Ath's solving file.
        mirror_axes = generate_result.get("mirror_axes")
        if mirror_axes is None:
            raise RuntimeError(
                "This generate result does not record mirror_axes (produced by an older bridge). "
                "Re-generate the mesh, or solve with symmetry=off on the full cleaned mesh."
            )
        detected = {str(axis).lower() for axis in mirror_axes}
        requested = set(symmetry)  # "x" -> {"x"}, "xy" -> {"x","y"}
        if requested != detected:
            detected_label = "".join(sorted(detected)) or "none"
            raise RuntimeError(
                f"symmetry='{symmetry}' does not match the reduced mesh, which was reduced with "
                f"mirror axes '{detected_label}'. "
                + (
                    f"Use symmetry='{detected_label}', or symmetry=off for the full mesh."
                    if detected
                    else "This mesh was not mirrored; use symmetry=off."
                )
            )
        mesh_file = Path(reduced)
    if not mesh_file.exists():
        raise RuntimeError(f"Mesh file from generate result not found: {mesh_file}")

    radiators_raw = generate_result["radiators"]
    radiators = tuple(radiator_from_dict(radiator) for radiator in radiators_raw)
    raw_npz = out_dir / "pressure_data_raw.npz"
    config = SimulationConfig(
        mesh_file=str(mesh_file),
        scale_factor=0.001,  # generated meshes are in mm
        freq_min=args.fmin,
        freq_max=args.fmax,
        freq_count=args.count,
        tag_throat=int(generate_result["driven_tag"]),
        radiators=radiators,
        symmetry=symmetry,
        output_npz=str(raw_npz),
    )
    config_path = out_dir / "config.toml"
    _write_solve_toml(config_path, mesh_file, radiators_raw)

    julia_exe = resolve_julia_exe(args.julia_exe)
    backend_kwargs = {}
    server_url = None
    server_health = None
    if backend_id.startswith("beat_"):
        backend_kwargs = {"julia_executable": julia_exe, "persistent_worker": False}
    elif backend_id == "server":
        server_url = resolve_server_url(args.server_url)
        server_token = resolve_server_token(args.server_token)
        backend_kwargs = {
            "server_url": server_url,
            "server_auth_token": server_token,
            "server_health_timeout_s": args.server_timeout,
            "server_request_timeout_s": max(args.server_timeout, 30.0),
        }
        # Probe once, up front. The far end's /health is the only authority on
        # what it can do: whether a symmetry-reduced mesh is safe to send, and
        # how much VRAM the box that will actually run this has. Failing here
        # beats failing after uploading a 200 MB mesh.
        server_health = probe_server_health(server_url, timeout_s=args.server_timeout, auth_token=server_token)
        from blab.solvers.http_server import server_health_summary, server_health_supports_symmetry

        progress("solve", f"Solve server {server_url}: {server_health_summary(server_health)}")
        if symmetry != "off" and not server_health_supports_symmetry(server_health):
            raise RuntimeError(
                f"symmetry='{symmetry}' needs a solve server that reconstructs the mirrored domain, but "
                f"{server_url} does not advertise symmetry support ({server_health_summary(server_health)}). "
                "Sending it the reduced mesh would produce wrong pressures. Use --symmetry off, or point "
                "--server-url at a server started with --solver beat_cuda / beat_cpu."
            )
    backend = create_backend(backend_id, **backend_kwargs)

    # Capacity check, never a gate: estimate peak VRAM for the mesh actually
    # handed to the solver (post symmetry reduction) and warn if the GPU that
    # will run it cannot hold it -- the local card for beat_*, the server's card
    # (from /health) for `server`. CPU backends and unknown GPUs never block.
    import vram as vram_mod
    from generators import mesh_dof_counts

    try:
        solver_vertices, solver_triangles = mesh_dof_counts(mesh_file)
    except (OSError, ValueError):
        solver_vertices, solver_triangles = None, int(generate_result["triangles"])
    vram_report = vram_mod.vram_report(
        triangles=solver_triangles,
        vertices=solver_vertices,
        backend_id=backend_id,
        symmetry=symmetry,
        remote_health=server_health,
    )
    progress(
        "solve",
        f"Estimated peak GPU memory {vram_report['estimate_human']} "
        f"({vram_report['solver_triangles']} triangles / {vram_report['solver_vertices']} nodes, symmetry={symmetry})",
    )
    if vram_report["warning"]:
        emit({"event": "warning", "stage": "solve", "message": vram_report["warning"]})
        progress("solve", f"WARNING: {vram_report['warning']}")

    frequencies = np.logspace(np.log10(args.fmin), np.log10(args.fmax), args.count)
    total = len(frequencies)
    progress("solve", f"Starting {backend_id} solve: {total} frequencies {args.fmin:g}-{args.fmax:g} Hz", 0, total)

    request = SolveRequest(
        config=config,
        frequencies_hz=np.asarray(frequencies, dtype=np.float32),
        status_callback=lambda message: progress("solve", message),
    )
    solve_start = time.perf_counter()
    session = backend.create_session(request)
    metadata = session.metadata

    results = []
    for result in session.solve_stream():
        results.append(result)
        progress("solve", f"{result.freq_hz:.1f} Hz solved", len(results), total)
    solve_seconds = time.perf_counter() - solve_start
    if not results:
        raise RuntimeError("Solver produced no frequency results.")
    results.sort(key=lambda item: item.freq_hz)

    freqs = np.asarray([item.freq_hz for item in results], dtype=np.float32)
    imp_matrix = np.stack([item.impedance for item in results], axis=1).astype(np.float32)
    bundle = {
        "freq_hz": freqs,
        "polar_angle_deg": np.asarray(metadata.polar_angle_deg, dtype=np.float32),
        "horizontal_spl_db": np.vstack(
            [
                item.horizontal_spl_db if item.horizontal_spl_db is not None else item.horizontal_spl_norm_db
                for item in results
            ]
        ).astype(np.float32),
        "vertical_spl_db": np.vstack(
            [
                item.vertical_spl_db if item.vertical_spl_db is not None else item.vertical_spl_norm_db
                for item in results
            ]
        ).astype(np.float32),
        "horizontal_spl_norm_db": np.vstack([item.horizontal_spl_norm_db for item in results]).astype(np.float32),
        "vertical_spl_norm_db": np.vstack([item.vertical_spl_norm_db for item in results]).astype(np.float32),
        "impedance_freq_hz": freqs,
        "impedance_radiator_names": np.asarray(metadata.radiator_names),
        "impedance_real": imp_matrix[:, :, 0],
        "impedance_imag": imp_matrix[:, :, 1],
        "observation_axial_offset_m": np.float32(config.axial_offset),
    }
    np.savez_compressed(raw_npz, **bundle)

    progress("prepare", "Preparing visualization data")
    formatted_npz = out_dir / "pressure_data_formatted.npz"
    prepare_visualization_data(PrepConfig(input_polar_npz=raw_npz, output_npz=formatted_npz))

    progress("plot", "Generating plots")
    from blab.plotting import VisualizerConfig, generate_plots, load_data

    plots_dir = out_dir / "plots"
    plots_dir.mkdir(exist_ok=True)
    plot_outputs = generate_plots(
        load_data(formatted_npz), VisualizerConfig(input_npz=formatted_npz, output_dir=plots_dir)
    )

    result = {
        "config_path": str(config_path),
        "pressure_npz": [str(raw_npz), str(formatted_npz)],
        "plots": [{"name": name, "path": path} for name, path in plot_outputs.items()],
        # Top-level scalar so it survives the bridge's compact summary and shows
        # up verbatim in the MCP get_run report.
        "vram_warning": vram_report["warning"],
        "vram": vram_report,
        "metrics": {
            "triangles": int(generate_result["triangles"]),
            "solver_triangles": vram_report["solver_triangles"],
            "vram_estimate_bytes": vram_report["estimate_bytes"],
            "n_freqs": int(total),
            "solve_seconds": round(solve_seconds, 2),
            "backend": backend_id,
            "symmetry": symmetry,
            "freq_min_hz": float(args.fmin),
            "freq_max_hz": float(args.fmax),
            "server_url": server_url,
            "server_solver": (server_health or {}).get("backend"),
        },
    }
    (out_dir / "result.json").write_text(json.dumps({"ok": True, **result}, indent=2), encoding="utf-8")
    return result


def cmd_remote_check(args: argparse.Namespace) -> dict:
    """Preflight a solve server: reachability, solver, capabilities, GPU.

    This is the command to run before pointing a campaign at a remote box. It
    answers the two questions that decide whether a solve will work there --
    "will it accept a symmetry-reduced mesh" and "will the mesh fit in its
    VRAM" -- without submitting anything.
    """
    import vram as vram_mod

    from blab.solvers.http_server import (
        server_health_backend_id,
        server_health_capabilities,
        server_health_supports_symmetry,
    )

    server_url = resolve_server_url(args.server_url)
    auth_token = resolve_server_token(args.server_token)
    progress("remote-check", f"Probing {server_url}/health")

    started = time.perf_counter()
    health = probe_server_health(server_url, timeout_s=args.server_timeout, auth_token=auth_token)
    latency_ms = round((time.perf_counter() - started) * 1000.0, 1)

    capabilities = server_health_capabilities(health)
    backend = server_health_backend_id(health)
    supports_symmetry = server_health_supports_symmetry(health)
    uses_gpu = vram_mod.remote_health_uses_gpu(health)
    gpu = vram_mod.remote_gpu_from_health(health)

    progress(
        "remote-check",
        f"{server_url} reachable in {latency_ms:.1f} ms: solver={backend or 'unknown'}, "
        f"symmetry={'yes' if supports_symmetry else 'no'}, "
        f"gpu={gpu['name'] if gpu else ('not reported' if uses_gpu else 'not used')}",
    )
    if uses_gpu and gpu is None:
        emit(
            {
                "event": "warning",
                "stage": "remote-check",
                "message": (
                    f"{server_url} runs a GPU solver ({backend or 'unknown'}) but does not report GPU details, "
                    "so solve-time VRAM estimates cannot be checked against it. Upgrade the server to a build "
                    "that reports `gpu` in /health."
                ),
            }
        )

    return {
        "server_url": server_url,
        "reachable": True,
        "latency_ms": latency_ms,
        "status": str(health.get("status") or ""),
        "solver": str(health.get("solver") or ""),
        "backend": backend,
        "solver_label": str(health.get("solver_label") or ""),
        "supports_symmetry": supports_symmetry,
        "solver_uses_gpu": uses_gpu,
        "capabilities": capabilities,
        "gpu": gpu,
        "gpu_human": {
            "name": gpu.get("name"),
            "total": vram_mod.format_bytes(gpu.get("total_bytes")),
            "free": vram_mod.format_bytes(gpu.get("free_bytes")),
        }
        if gpu
        else None,
        "health": health,
    }


def _derive_mesh_result(solve_run: Path) -> dict | None:
    """Locate the mesh run's result.json from the solve run's config.toml.

    Generators may nest the mesh file several directories below the mesh run dir
    (e.g. ATH's ``<run>/<name>/ABEC_FreeStanding/*.msh``), so walk up the mesh
    file's ancestors until a directory containing result.json is found.
    """
    import tomllib

    config_path = solve_run / "config.toml"
    if not config_path.exists():
        return None
    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
        mesh_file = Path(config["meshes"][0]["file"])
    except (tomllib.TOMLDecodeError, KeyError, IndexError, TypeError):
        return None
    for ancestor in mesh_file.parents:
        candidate = ancestor / "result.json"
        if candidate.exists():
            return json.loads(candidate.read_text(encoding="utf-8"))
    return None


def cmd_score(args: argparse.Namespace) -> dict:
    import metrics as metrics_mod

    solve_run = Path(args.solve_run).resolve()
    solve_result = json.loads((solve_run / "result.json").read_text(encoding="utf-8"))
    raw_npz = solve_run / "pressure_data_raw.npz"
    if not raw_npz.exists():
        pressure_npz = solve_result.get("pressure_npz") or []
        if pressure_npz:
            raw_npz = Path(pressure_npz[0])
    if not raw_npz.exists():
        raise RuntimeError(f"Raw pressure NPZ not found in solve run: {raw_npz}")
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))

    if args.mesh_run:
        mesh_result = json.loads((Path(args.mesh_run).resolve() / "result.json").read_text(encoding="utf-8"))
    else:
        mesh_result = _derive_mesh_result(solve_run)
        if mesh_result is None:
            progress("score", "Mesh run result.json not found from config.toml; size subscore uses defaults")

    progress("score", f"Scoring {raw_npz.name}")
    result = metrics_mod.compute_metrics(raw_npz, spec, mesh_result=mesh_result, solve_result=solve_result)
    # Unmeasurable subscores are null and drop out of the weighted score; say so
    # here so a campaign never silently optimizes against fewer terms than asked.
    for warning in result.get("warnings") or []:
        progress("score", warning)

    out_dirs = [solve_run]
    if args.out:
        out_dir = Path(args.out).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        out_dirs.append(out_dir)
    for out_dir in out_dirs:
        (out_dir / "metrics.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        plots_dir = out_dir / "plots"
        plots_dir.mkdir(exist_ok=True)
        progress("plot", f"Writing scoring plots to {plots_dir}")
        metrics_mod.plot_beamwidth_vs_freq(result, plots_dir / "beamwidth_vs_freq.png")
        metrics_mod.plot_di_curves(result, plots_dir / "di_curves.png")
    return result


def _add_server_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--server-url",
        type=server_url_arg,
        default=None,
        help=(
            "Boundary Lab solve server, e.g. http://10.0.0.5:8765 for a remote box. "
            "Only used with --backend server. Defaults to the BLAB_SERVER_URL env var, "
            "or http://127.0.0.1:8765 (a server on this machine) when neither is set."
        ),
    )
    parser.add_argument(
        "--server-token",
        default=None,
        help=(
            "Bearer token sent as an Authorization header (default: BLAB_SERVER_TOKEN env). "
            "For a reverse proxy or tunnel fronting the server; blab server itself does not authenticate."
        ),
    )
    parser.add_argument(
        "--server-timeout",
        type=float,
        default=10.0,
        help="Seconds to wait for the server's /health probe (default: 10).",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="blabctl", description="NDJSON bridge CLI for Boundary Lab.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list-generators", help="List available mesh generators with JSON Schema params.")

    p_generate = sub.add_parser("generate", help="Run a generator, clean the mesh, render a preview.")
    p_generate.add_argument("--generator", required=True)
    p_generate.add_argument("--params", default=None, help="Path to a params JSON file (defaults apply if omitted)")
    p_generate.add_argument("--out", required=True, help="Run directory for all outputs")
    p_generate.add_argument("--name", default="case", type=safe_name)

    p_estimate = sub.add_parser(
        "estimate",
        help="Closed-form triangle count and outer bounding box for a params set, without meshing.",
    )
    p_estimate.add_argument("--generator", required=True)
    p_estimate.add_argument("--params", default=None, help="Path to a params JSON file (defaults apply if omitted)")

    p_solve = sub.add_parser("solve", help="Solve a generated mesh and produce plots.")
    p_solve.add_argument("--mesh-run", required=True, help="Directory containing result.json from generate")
    p_solve.add_argument("--out", required=True)
    p_solve.add_argument("--fmin", type=float, default=200.0)
    p_solve.add_argument("--fmax", type=float, default=20000.0)
    p_solve.add_argument("--count", type=int, default=24)
    p_solve.add_argument(
        "--backend",
        default="beat_cuda",
        help="Solver backend: beat_cuda, beat_cpu, beat_rocm, local, or server (remote HTTP solve server)",
    )
    p_solve.add_argument("--symmetry", choices=("off", "x", "xy"), default="off")
    p_solve.add_argument(
        "--julia-exe", default=None, help="Julia executable (default: BLAB_JULIA_EXE env or known install)"
    )
    _add_server_arguments(p_solve)

    p_remote_check = sub.add_parser(
        "remote-check",
        help="Probe a solve server's /health and report solver, capabilities and GPU.",
    )
    _add_server_arguments(p_remote_check)

    p_score = sub.add_parser("score", help="Score a completed solve run against a campaign spec.")
    p_score.add_argument("--solve-run", required=True, help="Directory containing result.json from solve")
    p_score.add_argument(
        "--spec",
        required=True,
        help=(
            "Path to the campaign spec JSON (runs/campaigns/<name>/spec.json, passed through unchanged). "
            'Only its "objective" object is read: {"band_hz": [lo, hi], "coverage": '
            '{horizontal_target_deg, vertical_target_deg, tolerance_deg}, "weights": {coverage, '
            'di_smoothness, on_axis_ripple, size}, "size_limit_mm": {width, height, depth}}'
        ),
    )
    p_score.add_argument(
        "--mesh-run", default=None, help="Mesh run directory (default: derived from the solve config.toml)"
    )
    p_score.add_argument("--out", default=None, help="Extra directory to copy metrics.json and plots into")

    p_preview = sub.add_parser("preview", help="Render a standalone mesh preview PNG.")
    p_preview.add_argument("--mesh", required=True)
    p_preview.add_argument("--out", required=True)
    p_preview.add_argument("--driven-tag", action="append", default=None, help="Physical tag(s) to highlight")
    return parser


COMMANDS = {
    "list-generators": cmd_list_generators,
    "generate": cmd_generate,
    "estimate": cmd_estimate,
    "solve": cmd_solve,
    "score": cmd_score,
    "preview": cmd_preview,
    "remote-check": cmd_remote_check,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = COMMANDS[args.command](args)
    except Exception as exc:  # noqa: BLE001 - the result line is the error contract
        emit({"event": "result", "ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1
    emit({"event": "result", "ok": True, **result})
    return 0


if __name__ == "__main__":
    sys.exit(main())
