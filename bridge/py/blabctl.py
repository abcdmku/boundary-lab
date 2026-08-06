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
# Iteration budget for this machine (RTX 5080): ~9k triangles solves in minutes;
# the documented 13.6k case already takes over an hour. Larger meshes are for
# final verification only — set allow_large: true in the params JSON.
TRIANGLE_GUARD = 9000

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

    triangles = int(result["triangles"])
    if triangles > TRIANGLE_GUARD and not raw_params.get("allow_large"):
        raise RuntimeError(
            f"Mesh has {triangles} triangles, over the {TRIANGLE_GUARD} guard. "
            "Coarsen the mesh parameters, or set allow_large: true in the params JSON to override."
        )

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

    backend_id = normalize_backend_id(args.backend)
    julia_exe = resolve_julia_exe(args.julia_exe)
    backend_kwargs = {}
    if backend_id.startswith("beat_"):
        backend_kwargs = {"julia_executable": julia_exe, "persistent_worker": False}
    backend = create_backend(backend_id, **backend_kwargs)

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
        "metrics": {
            "triangles": int(generate_result["triangles"]),
            "n_freqs": int(total),
            "solve_seconds": round(solve_seconds, 2),
            "backend": backend_id,
            "symmetry": symmetry,
            "freq_min_hz": float(args.fmin),
            "freq_max_hz": float(args.fmax),
        },
    }
    (out_dir / "result.json").write_text(json.dumps({"ok": True, **result}, indent=2), encoding="utf-8")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="blabctl", description="NDJSON bridge CLI for Boundary Lab.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list-generators", help="List available mesh generators with JSON Schema params.")

    p_generate = sub.add_parser("generate", help="Run a generator, clean the mesh, render a preview.")
    p_generate.add_argument("--generator", required=True)
    p_generate.add_argument("--params", default=None, help="Path to a params JSON file (defaults apply if omitted)")
    p_generate.add_argument("--out", required=True, help="Run directory for all outputs")
    p_generate.add_argument("--name", default="case", type=safe_name)

    p_solve = sub.add_parser("solve", help="Solve a generated mesh and produce plots.")
    p_solve.add_argument("--mesh-run", required=True, help="Directory containing result.json from generate")
    p_solve.add_argument("--out", required=True)
    p_solve.add_argument("--fmin", type=float, default=200.0)
    p_solve.add_argument("--fmax", type=float, default=20000.0)
    p_solve.add_argument("--count", type=int, default=24)
    p_solve.add_argument("--backend", default="beat_cuda")
    p_solve.add_argument("--symmetry", choices=("off", "x", "xy"), default="off")
    p_solve.add_argument(
        "--julia-exe", default=None, help="Julia executable (default: BLAB_JULIA_EXE env or known install)"
    )

    p_preview = sub.add_parser("preview", help="Render a standalone mesh preview PNG.")
    p_preview.add_argument("--mesh", required=True)
    p_preview.add_argument("--out", required=True)
    p_preview.add_argument("--driven-tag", action="append", default=None, help="Physical tag(s) to highlight")
    return parser


COMMANDS = {
    "list-generators": cmd_list_generators,
    "generate": cmd_generate,
    "solve": cmd_solve,
    "preview": cmd_preview,
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
