"""Persistent mesh-preview worker for the live mesh editor.

The editor regenerates geometry on every parameter edit, so the cost that
matters is not the mesh — it is the imports. A cold `blabctl generate` spends
~0.4 s importing gmsh/meshio/numpy before it touches geometry; the geometry
itself takes 0.15-0.45 s. Keeping one process warm therefore turns a ~1 s
round trip into a ~0.2 s one, which is the difference between "click to
re-render" and dragging a slider and watching the horn move.

Protocol: NDJSON on stdin/stdout, one JSON object per line, correlated by `id`.

  ready    <- {"event": "ready"}                       once, after imports warm
  request  -> {"id": 7, "generator": "slot_cd_horn", "params": {...},
               "out": "<absolute scratch dir>"}
  response <- {"id": 7, "ok": true, "walls": "<path>|null", "driven": "<path>|null",
               "triangles": N, "bbox_mm": [x, y, z], "vertices": N,
               "vram_bytes": N|null, "quality_warning": "..."|null,
               "mirror_axes": [...], "elapsed_ms": 123.4}
  response <- {"id": 7, "ok": false, "error": "ValueError: ..."}

A failing request is a normal outcome — the editor sends half-typed and
out-of-range parameters constantly — so an exception is reported and the
process stays warm. Only an unreadable stdin ends the worker.

The caller (bridge/src/preview.ts) owns the scratch directories, sends one
request at a time, and recycles this process periodically so a long editing
session cannot accumulate gmsh state.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BRIDGE_DIR))

# Same discipline as blabctl: gmsh, meshio and the generators print to stdout
# unbidden, and one stray line would corrupt the NDJSON stream.
_NDJSON_OUT = sys.stdout
sys.stdout = sys.stderr

# Files the editor fetches. Fixed stem so the HTTP layer can allowlist names
# instead of trusting a path from this process.
NAME = "preview"


def emit(obj: dict) -> None:
    _NDJSON_OUT.write(json.dumps(obj) + "\n")
    _NDJSON_OUT.flush()


def build_preview(generator_id: str, raw_params: dict, out_dir: Path) -> dict:
    """Generate one mesh and export the viewer STLs. Everything else is skipped.

    Deliberately not `blabctl generate`: no preview PNG (matplotlib costs more
    than the mesh), no result.json, no job. The VRAM estimate stays, because
    "will this mesh actually fit on the card" is a question the designer wants
    answered while they are still moving the sliders, not after a solve fails.
    """
    from generators import apply_defaults, export_viewer_stls, load_generator, mesh_dof_counts

    generator = load_generator(generator_id)
    params = apply_defaults(raw_params, generator.SCHEMA)
    out_dir.mkdir(parents=True, exist_ok=True)

    result = generator.generate(params, out_dir, NAME, lambda _event: None)

    cleaned_msh = Path(result["cleaned_msh_path"])
    driven_tags = tuple(sorted({int(radiator["tag"]) for radiator in result["radiators"]})) or (
        int(result["driven_tag"]),
    )
    stls = export_viewer_stls(cleaned_msh, out_dir, NAME, driven_tags)

    vram_bytes = None
    vertices = None
    try:
        import vram

        vertices, triangles = mesh_dof_counts(cleaned_msh)
        vram_bytes = vram.estimate_solve_vram_bytes(triangles=triangles, vertices=vertices)
    except (OSError, ValueError, ImportError):
        pass  # informational only — never fail a preview over the estimate

    return {
        "walls": stls.get("walls"),
        "driven": stls.get("driven"),
        "triangles": int(result["triangles"]),
        "vertices": vertices,
        "bbox_mm": result.get("bbox_mm"),
        "mirror_axes": result.get("mirror_axes") or [],
        "quality_warning": result.get("quality_warning"),
        "vram_bytes": vram_bytes,
        "params": params,
    }


def handle(request: dict) -> dict:
    request_id = request.get("id")
    started = time.perf_counter()
    try:
        generator_id = request["generator"]
        out_dir = Path(request["out"]).resolve()
        params = request.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        payload = build_preview(str(generator_id), params, out_dir)
    except Exception as exc:  # noqa: BLE001 - the response line is the error contract
        return {"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    payload["elapsed_ms"] = round((time.perf_counter() - started) * 1000.0, 1)
    return {"id": request_id, "ok": True, **payload}


def main() -> int:
    # Pay the import cost before announcing readiness, so the first edit a user
    # makes is as fast as the hundredth.
    import gmsh  # noqa: F401
    import meshio  # noqa: F401
    import numpy  # noqa: F401

    from generators import load_generators

    load_generators()
    emit({"event": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"id": None, "ok": False, "error": f"malformed request line: {exc}"})
            continue
        emit(handle(request))
    return 0


if __name__ == "__main__":
    sys.exit(main())
