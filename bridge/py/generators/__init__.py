"""Generator discovery for blabctl."""

from __future__ import annotations

import importlib
from pathlib import Path
from types import ModuleType

import meshio
import numpy as np

GENERATOR_MODULES = ("ath_waveguide", "axisym_horn", "slot_cd_horn")


def load_generators() -> dict[str, ModuleType]:
    generators = {}
    for module_name in GENERATOR_MODULES:
        module = importlib.import_module(f"generators.{module_name}")
        generators[module.SCHEMA["id"]] = module
    return generators


def load_generator(generator_id: str) -> ModuleType:
    generators = load_generators()
    try:
        return generators[generator_id]
    except KeyError as exc:
        raise ValueError(f"Unknown generator: {generator_id}. Available: {', '.join(sorted(generators))}") from exc


def apply_defaults(params: dict, schema: dict) -> dict:
    """Fill missing params from JSON Schema defaults and reject unknown keys."""
    properties = schema["params"]["properties"]
    unknown = set(params) - set(properties) - {"allow_large"}
    if unknown:
        raise ValueError(f"Unknown params for {schema['id']}: {sorted(unknown)}")
    merged = {name: spec["default"] for name, spec in properties.items() if "default" in spec}
    merged.update(params)
    return merged


def mesh_stats(msh_path: Path) -> tuple[int, list[float]]:
    """Return (triangle_count, bbox_mm[x, y, z]) for a triangle .msh file."""
    mesh = meshio.read(msh_path)
    cells = mesh.cells_dict
    triangles = cells.get("triangle", cells.get("triangle3"))
    if triangles is None:
        raise ValueError(f"No triangles in {msh_path}")
    points = np.asarray(mesh.points, dtype=float)
    span = points.max(axis=0) - points.min(axis=0)
    return int(len(triangles)), [float(v) for v in span]


def export_viewer_stls(msh_path: Path, out_dir: Path, name: str, driven_tags: tuple[int, ...]) -> dict:
    """Split a cleaned mesh into walls/driven binary STLs for the three.js viewer (mm coordinates as-is)."""
    mesh = meshio.read(msh_path)
    cells = mesh.cells_dict
    tri_key = "triangle" if "triangle" in cells else "triangle3"
    triangles = np.asarray(cells[tri_key])

    tags = None
    for key, block in mesh.cell_data_dict.items():
        if "gmsh:physical" in key and tri_key in block:
            tags = np.asarray(block[tri_key])
            break
    driven_mask = np.zeros(len(triangles), dtype=bool)
    if tags is not None and driven_tags:
        driven_mask = np.isin(tags, np.asarray(driven_tags))

    paths: dict[str, str | None] = {}
    for label, mask in (("walls", ~driven_mask), ("driven", driven_mask)):
        if not mask.any():
            paths[label] = None
            continue
        stl_path = out_dir / f"{name}_{label}.stl"
        meshio.write(
            stl_path,
            meshio.Mesh(mesh.points, [("triangle", triangles[mask])]),
            file_format="stl",
            binary=True,
        )
        paths[label] = str(stl_path)
    return paths


def quality_warning_text(warning) -> str | None:
    """Compact one-line summary of a blab MeshQualityWarning, or None."""
    if warning is None or not warning.has_warnings:
        return None
    return (
        f"{warning.sliver_triangles} sliver / {warning.float32_singular_triangles} float32-singular triangles "
        f"(worst altitude/edge ratio {warning.worst_altitude_edge_ratio:.2e})"
    )
