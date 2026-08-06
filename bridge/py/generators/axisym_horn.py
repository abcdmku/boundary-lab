"""Procedural axisymmetric horn generator using the gmsh Python API."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Callable

import numpy as np

from blab.config import RadiatorConfig
from blab.mesh_clean import clean_mesh_file, triangle_quality_warning
from blab.protocol import radiator_to_dict
from generators import mesh_stats, quality_warning_text

DRIVEN_TAG = 2
WALL_TAG = 1

SCHEMA = {
    "id": "axisym_horn",
    "title": "Axisymmetric Horn (procedural)",
    "description": (
        "Watertight axisymmetric horn built directly with the gmsh API: driven throat disc (physical tag 2), "
        "rigid walls (tag 1), firing along +z with the throat at z=0. Back options: 'shell' wraps a thin wall "
        "around the flare for a free-standing horn; 'enclosure' closes the horn into a cylindrical box behind "
        "the mouth baffle. Mesh units are mm. Tractrix profiles derive their natural length from the mouth "
        "radius and are rescaled to the requested length."
    ),
    "params": {
        "type": "object",
        "properties": {
            "profile": {
                "type": "string",
                "enum": ["conical", "exponential", "tractrix"],
                "default": "exponential",
                "description": "Horn flare profile from throat to mouth.",
            },
            "throat_diameter": {
                "type": "number",
                "default": 25.4,
                "minimum": 5,
                "maximum": 150,
                "description": "Throat diameter in mm (driven disc).",
            },
            "mouth_diameter": {
                "type": "number",
                "default": 200,
                "minimum": 40,
                "maximum": 800,
                "description": "Mouth diameter in mm.",
            },
            "length": {
                "type": "number",
                "default": 140,
                "minimum": 20,
                "maximum": 600,
                "description": "Axial horn length in mm.",
            },
            "profile_segments": {
                "type": "integer",
                "default": 24,
                "minimum": 4,
                "maximum": 120,
                "description": "Number of straight segments approximating the flare profile.",
            },
            "element_size": {
                "type": "number",
                "default": 10,
                "minimum": 2,
                "maximum": 40,
                "description": "Target mesh element size in mm (Mesh.MeshSizeMax; throat is refined finer).",
            },
            "back": {
                "type": "string",
                "enum": ["shell", "enclosure"],
                "default": "shell",
                "description": "Back treatment: thin-walled free-standing shell, or cylindrical back enclosure.",
            },
            "wall_thickness": {
                "type": "number",
                "default": 6,
                "minimum": 1,
                "maximum": 30,
                "description": "Shell wall thickness in mm (back='shell').",
            },
            "enclosure_depth": {
                "type": "number",
                "default": 120,
                "minimum": 20,
                "maximum": 600,
                "description": "Cylindrical enclosure depth behind the mouth baffle in mm (back='enclosure').",
            },
            "enclosure_margin": {
                "type": "number",
                "default": 30,
                "minimum": 5,
                "maximum": 200,
                "description": "Radial margin of the enclosure beyond the mouth radius in mm (back='enclosure').",
            },
        },
    },
}


def _profile_radii(profile: str, r_throat: float, r_mouth: float, length: float, segments: int) -> np.ndarray:
    """Return (n, 2) array of (z, r) points from throat (z=0) to mouth (z=length), in mm."""
    t = np.linspace(0.0, 1.0, segments + 1)
    if profile == "conical":
        r = r_throat + (r_mouth - r_throat) * t
        z = length * t
    elif profile == "exponential":
        r = r_throat * (r_mouth / r_throat) ** t
        z = length * t
    elif profile == "tractrix":
        a = r_mouth
        r = r_throat + (r_mouth - r_throat) * t
        r_clamped = np.clip(r, 1e-9, a * (1.0 - 1e-9))
        with np.errstate(invalid="ignore"):
            z_from_mouth = a * np.log((a + np.sqrt(a**2 - r_clamped**2)) / r_clamped) - np.sqrt(a**2 - r_clamped**2)
        z = z_from_mouth[0] - z_from_mouth  # 0 at throat, natural length at mouth
        z = z * (length / z[-1])  # rescale to requested length
    else:
        raise ValueError(f"Unknown profile: {profile}")
    return np.column_stack([z, r])


def _build_generatrix(p: dict) -> tuple[np.ndarray, int]:
    """Closed (z, r) polyline from the axis at the throat around the body and back to the axis.

    Returns (points, n_throat_segments): the first n_throat_segments polyline segments form the driven throat disc.
    """
    r_throat = float(p["throat_diameter"]) / 2.0
    r_mouth = float(p["mouth_diameter"]) / 2.0
    length = float(p["length"])
    flare = _profile_radii(str(p["profile"]), r_throat, r_mouth, length, int(p["profile_segments"]))

    points = [(0.0, 0.0), (0.0, r_throat)]  # throat disc: axis -> rim (1 segment)
    points.extend((float(z), float(r)) for z, r in flare[1:])

    if str(p["back"]) == "enclosure":
        depth = float(p["enclosure_depth"])
        r_outer = r_mouth + float(p["enclosure_margin"])
        points += [
            (length, r_outer),  # front baffle annulus
            (length - depth, r_outer),  # enclosure side wall (backwards)
            (length - depth, 0.0),  # back disc to the axis
        ]
    else:
        thickness = float(p["wall_thickness"])
        points.append((length, r_mouth + thickness))  # mouth rim
        points.extend((float(z), float(r) + thickness) for z, r in flare[::-1][1:])  # outer wall back to throat
        points.append((0.0, r_throat))  # back annulus closes onto the throat rim
    return np.asarray(points, dtype=float), 1


def generate(params: dict, out_dir: Path, name: str, emit: Callable[[dict], None]) -> dict:
    import gmsh

    generatrix, n_throat_segments = _build_generatrix(params)
    element_size = float(params["element_size"])
    throat_size = min(element_size, max(2.0, float(params["throat_diameter"]) / 6.0))

    out_dir.mkdir(parents=True, exist_ok=True)
    raw_msh = out_dir / f"{name}.msh"
    emit({"event": "progress", "stage": "gmsh", "message": f"Meshing {params['profile']} horn with gmsh"})

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add(name)
        occ = gmsh.model.occ

        point_tags = [occ.addPoint(0.0, r, z) for z, r in generatrix]  # revolve about z; r along +y
        line_tags = [occ.addLine(point_tags[i], point_tags[i + 1]) for i in range(len(point_tags) - 1)]
        occ.revolve([(1, tag) for tag in line_tags], 0, 0, 0, 0, 0, 1, 2.0 * math.pi)
        occ.removeAllDuplicates()
        occ.synchronize()

        all_surfaces = [tag for dim, tag in gmsh.model.getEntities(2)]
        r_throat = float(params["throat_diameter"]) / 2.0
        throat_surfaces = []
        for tag in all_surfaces:
            xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(2, tag)
            radial_extent = max(abs(xmin), abs(xmax), abs(ymin), abs(ymax))
            if abs(zmin) < 1e-6 and abs(zmax) < 1e-6 and radial_extent <= r_throat + 1e-6:
                throat_surfaces.append(tag)
        if not throat_surfaces:
            raise RuntimeError("Could not identify the throat disc surface after revolve.")
        wall_surfaces = [tag for tag in all_surfaces if tag not in throat_surfaces]

        gmsh.model.addPhysicalGroup(2, throat_surfaces, DRIVEN_TAG, name="SD1D1001")
        gmsh.model.addPhysicalGroup(2, wall_surfaces, WALL_TAG, name="walls")

        gmsh.option.setNumber("Mesh.MeshSizeMax", element_size)
        gmsh.option.setNumber("Mesh.MeshSizeMin", min(throat_size, element_size) * 0.5)
        field = gmsh.model.mesh.field.add("Distance")
        gmsh.model.mesh.field.setNumbers(field, "SurfacesList", throat_surfaces)
        threshold = gmsh.model.mesh.field.add("Threshold")
        gmsh.model.mesh.field.setNumber(threshold, "InField", field)
        gmsh.model.mesh.field.setNumber(threshold, "SizeMin", throat_size)
        gmsh.model.mesh.field.setNumber(threshold, "SizeMax", element_size)
        gmsh.model.mesh.field.setNumber(threshold, "DistMin", r_throat)
        gmsh.model.mesh.field.setNumber(threshold, "DistMax", r_throat * 6.0)
        gmsh.model.mesh.field.setAsBackgroundMesh(threshold)

        gmsh.model.mesh.generate(2)
        gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
        gmsh.write(str(raw_msh))
    finally:
        gmsh.finalize()

    emit({"event": "progress", "stage": "clean", "message": "Cleaning gmsh output"})
    cleaned_msh = out_dir / f"{name}_clean.msh"
    clean_mesh_file(str(raw_msh), str(cleaned_msh), mirror_x=False, mirror_axes=())

    import meshio

    warning = triangle_quality_warning(meshio.read(cleaned_msh))
    triangles, bbox_mm = mesh_stats(cleaned_msh)
    radiators = (RadiatorConfig(name="throat", tag=DRIVEN_TAG, level_db=0.0),)

    config_used = out_dir / f"{name}_params.json"
    import json

    config_used.write_text(json.dumps(params, indent=2), encoding="utf-8")
    return {
        "mesh_path": str(raw_msh),
        "cleaned_msh_path": str(cleaned_msh),
        "stl_path": None,
        "mirror_axes": [],  # full mesh, never mirrored — symmetry solves are invalid
        "triangles": triangles,
        "bbox_mm": bbox_mm,
        "driven_tag": DRIVEN_TAG,
        "radiators": [radiator_to_dict(radiator) for radiator in radiators],
        "quality_warning": quality_warning_text(warning if warning.has_warnings else None),
        "config_used": str(config_used),
    }
