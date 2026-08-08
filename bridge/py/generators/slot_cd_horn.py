"""slot_cd_horn: circular-to-slot adapter feeding a constant-directivity flare.

Geometry (mm; fires +z; throat plane z=0; x = slot narrow axis, y = slot long axis):

- Outer adapter cone r(z) = r_t + z*tan(wall_angle), clipped by two slice planes
  that each contain a slot long edge (x = +/- slot_width/2 at z_e) and tilt at
  slice_angle opening toward the throat: clip half-width
  w(z) = slot_width/2 + (z_e - z)*tan(slice_angle). The adapter depth is derived:
  z_e = (slot_length/2 - r_t) / tan(wall_angle).
- Phase plug = suspended sliced wedge: inner cone r_p(z) from plug_base_diameter/2 clipped
  by planes parallel to the slice planes inset plug_gap perpendicular, closing
  to a ridge over plug_tip_length and stopping plug_tip_margin short of the slot
  exit. Its capped base is suspended plug_base_clearance in front of the driver.
- Driven surface (tag 2, "SD1D1001"): the full compression-driver exit disc at
  z=0, with or without the plug. Everything else is tag 1 "walls" (the plug is
  a separate closed rigid body).
- CD flare: the slot outline morphs to a superellipse mouth over flare_depth
  (flare_exp=1 -> straight conical walls, true CD), with an optional mid-flare
  pinch waist and an ATH-Term-style mouth roundover (radius + sweep).
- back="shell": free-standing horn, in-plane offset outer skin (wall_thickness)
  with a rolled mouth lip and a throat back ring. back="enclosure": box behind
  the mouth baffle (mouth_roundover is ignored in enclosure mode).

Construction: direct feature-patch loft (numpy + meshio), not OCC booleans.
Every surface is an analytic family of quadrant outlines (slot_cd_sections);
variable-count strips keep sharp rails explicit as their patch arclength changes.
Only the +x/+y quadrant is generated with nodes exactly
on x=0/y=0; the blab mesh cleaner mirrors it into the full mesh (ATH pattern)
and the unmirrored quadrant is written as reduced_msh_path for --symmetry x|xy.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Callable

import numpy as np

from generators import mesh_stats, quality_warning_text
from generators import slot_cd_sections as sections

DRIVEN_TAG = 2
WALL_TAG = 1

_DISC_RADIAL_STRIPS = 3  # driven disc strips (innermost collapses)
_PLUG_CAP_RADIAL_STRIPS = 2  # rigid cap below the suspended phase plug
_BAFFLE_STRIPS = 2  # enclosure front baffle strips (mouth outline -> box outline)
_ENCLOSURE_SIDE_SEGMENTS = 4  # enclosure side-wall strips
_BACK_CAP_STRIPS = 3  # enclosure back-cap strips (last collapses to the axis)

SCHEMA = {
    "id": "slot_cd_horn",
    "title": "Circular-to-Slot + CD Flare Horn",
    "description": (
        "Compression-driver horn: conical circular-to-slot adapter (two slice planes cut the cone into a "
        "slot exit, with an optional suspended sliced-wedge phase plug) feeding a constant-directivity flare that "
        "morphs the slot into a superellipse mouth. The full circular driver exit at the throat plane is physical tag 2 "
        "'SD1D1001'; walls are tag 1. Fires along +z, throat at z=0, x = slot narrow axis, y = slot long "
        "axis (vertical slot: mouth_width sets horizontal coverage). Mesh units are mm. Built as a direct "
        "feature-patch loft in the +x/+y quadrant and mirrored, so solves can use --symmetry x or xy "
        "via reduced_msh_path. Adapter depth is derived: z_e = (slot_length/2 - throat_diameter/2) / "
        "tan(wall_angle_deg). mouth_roundover is ignored when back='enclosure'. "
        "OUTER BOUNDING BOX (mouth_width/mouth_height are the air aperture, the shell can be larger): "
        "the x span is the larger of the mouth/lip and the circular-to-slot adapter bulge; mouth margin = "
        "max(mouth_roundover*c, wall_thickness + (mouth_roundover - wall_thickness)*c) per side, "
        "c = 1 - cos(roundover_sweep_deg); height = mouth_height + 2*margin; depth = "
        "z_e + flare_depth + mouth_roundover*max(sin(phi)) over the sampled roundover stations. "
        "`blabctl estimate --generator slot_cd_horn --params p.json` returns it exactly without meshing."
    ),
    "params": {
        "type": "object",
        "properties": {
            "throat_diameter": {
                "type": "number",
                "default": 36,
                "minimum": 10,
                "maximum": 80,
                "description": "Compression-driver exit diameter in mm (1.4in convention -> 36).",
            },
            "wall_angle_deg": {
                "type": "number",
                "default": 45,
                "minimum": 10,
                "maximum": 70,
                "description": "Adapter cone half wall angle in degrees; sets the derived adapter depth.",
            },
            "slot_width": {
                "type": "number",
                "default": 20,
                "minimum": 4,
                "maximum": 80,
                "description": "Slot exit width in mm (narrow axis, x).",
            },
            "slot_length": {
                "type": "number",
                "default": 160,
                "minimum": 40,
                "maximum": 400,
                "description": "Slot exit length in mm (long axis, y). Must exceed throat_diameter.",
            },
            "slice_angle_deg": {
                "type": "number",
                "default": 45,
                "minimum": 10,
                "maximum": 70,
                "description": "Tilt of the two slice planes (opening toward the throat) in degrees.",
            },
            "plug": {
                "type": "boolean",
                "default": True,
                "description": "Include the sliced-wedge cone phase plug (rigid wall).",
            },
            "plug_base_diameter": {
                "type": "number",
                "default": 18,
                "minimum": 4,
                "maximum": 60,
                "description": "Diameter of the capped phase-plug base in mm (must be < throat_diameter).",
            },
            "plug_base_clearance": {
                "type": "number",
                "default": 3,
                "minimum": 0.5,
                "maximum": 30,
                "description": (
                    "Axial air gap in mm from the circular compression-driver exit to the rigid phase-plug cap. "
                    "Keeping the plug in front of the source preserves a full driven disc instead of an annulus."
                ),
            },
            "plug_angle_deg": {
                "type": "number",
                "default": 45,
                "minimum": 10,
                "maximum": 70,
                "description": "Plug cone half wall angle in degrees.",
            },
            "plug_gap": {
                "type": "number",
                "default": 6.4,
                "minimum": 1,
                "maximum": 30,
                "description": "Perpendicular gap between slice planes and plug clip planes in mm (channel thickness).",
            },
            "plug_tip_margin": {
                "type": "number",
                "default": 15,
                "minimum": 1,
                "maximum": 100,
                "description": "Axial distance the plug ridge stops short of the slot exit in mm.",
            },
            "plug_tip_length": {
                "type": "number",
                "default": 20,
                "minimum": 2,
                "maximum": 100,
                "description": "Axial length over which the wedge closes to its ridge in mm.",
            },
            "mouth_width": {
                "type": "number",
                "default": 360,
                "minimum": 40,
                "maximum": 1000,
                "description": (
                    "Mouth width in mm (x, horizontal coverage plane) — the AIR aperture, NOT the outer "
                    "envelope. At the mouth the shell adds a margin on every side: mouth/lip width = "
                    "mouth_width + 2*margin, but the adapter bulge can set a larger total outer width. "
                    "margin = max(mouth_roundover*c, wall_thickness + (mouth_roundover - wall_thickness)*c) "
                    "with c = 1 - cos(roundover_sweep_deg) (margin = wall_thickness when mouth_roundover is "
                    "0, = enclosure_margin when back='enclosure'). Budget for it against any size limit. "
                    "Must be >= slot_width."
                ),
            },
            "mouth_height": {
                "type": "number",
                "default": 240,
                "minimum": 40,
                "maximum": 800,
                "description": (
                    "Mouth height in mm (y, vertical coverage plane) — the AIR aperture, NOT the outer "
                    "envelope: outer_height = mouth_height + 2*margin, same margin as mouth_width. "
                    "Must be >= slot_length."
                ),
            },
            "flare_depth": {
                "type": "number",
                "default": 120,
                "minimum": 10,
                "maximum": 500,
                "description": (
                    "Axial depth of the CD flare in mm. Outer depth = z_e + flare_depth + lip_depth, where "
                    "lip_depth = mouth_roundover * max(sin(phi)) over the roundover_segments+1 arc stations "
                    "evenly spaced from 0 to roundover_sweep_deg (so mouth_roundover*sin(sweep) for a sweep "
                    "up to 90 deg), and the derived adapter depth z_e = (slot_length/2 - "
                    "throat_diameter/2)/tan(wall_angle_deg)."
                ),
            },
            "mouth_superellipse_n": {
                "type": "number",
                "default": 8,
                "minimum": 2,
                "maximum": 12,
                "description": "Mouth superellipse exponent (2 = ellipse, 8 = the squarer default, higher = tighter corners).",
            },
            "flare_exp": {
                "type": "number",
                "default": 1.0,
                "minimum": 0.3,
                "maximum": 3,
                "description": "Slot-to-mouth morph exponent along the flare (1 = straight conical CD walls).",
            },
            "pinch": {
                "type": "number",
                "default": 0,
                "minimum": 0,
                "maximum": 0.8,
                "description": "Mid-flare waist amount (0 = none; fraction of outline scale removed at the waist).",
            },
            "pinch_pos": {
                "type": "number",
                "default": 0.5,
                "minimum": 0.1,
                "maximum": 0.9,
                "description": "Normalized axial position of the pinch waist along the flare.",
            },
            "mouth_roundover": {
                "type": "number",
                "default": 15,
                "minimum": 0,
                "maximum": 80,
                "description": (
                    "Mouth roundover radius in mm (0 = sharp mouth; shell back needs 0 or > wall_thickness). "
                    "The rolled lip is what pushes the outer envelope past the mouth aperture — it dominates "
                    "the per-side margin in the mouth_width formula, so raising it costs outer width AND "
                    "height AND depth."
                ),
            },
            "roundover_sweep_deg": {
                "type": "number",
                "default": 90,
                "minimum": 30,
                "maximum": 180,
                "description": (
                    "Roundover sweep angle in degrees (90 = quarter round, 180 = full rollback). Sets "
                    "c = 1 - cos(sweep) in the outer-margin formula: the per-side margin is ~mouth_roundover "
                    "at 90 deg and 2*mouth_roundover at 180 deg."
                ),
            },
            "back": {
                "type": "string",
                "enum": ["shell", "enclosure"],
                "default": "shell",
                "description": "Back treatment: free-standing offset shell, or box enclosure behind the mouth baffle.",
            },
            "wall_thickness": {
                "type": "number",
                "default": 6,
                "minimum": 2,
                "maximum": 20,
                "description": "Shell wall thickness in mm (back='shell', in-plane offset).",
            },
            "enclosure_depth": {
                "type": "number",
                "default": 220,
                "minimum": 30,
                "maximum": 800,
                "description": "Enclosure depth behind the mouth baffle in mm (clamped to enclose the horn).",
            },
            "enclosure_margin": {
                "type": "number",
                "default": 30,
                "minimum": 5,
                "maximum": 200,
                "description": "In-plane margin of the enclosure beyond the mouth in mm.",
            },
            "angular_segments": {
                "type": "integer",
                "default": 64,
                "minimum": 16,
                "maximum": 256,
                "multipleOf": 4,
                "description": (
                    "Full-circumference segment count; must be a multiple of 4 (the mesh is built per "
                    "quadrant with angular_segments/4 segments)."
                ),
            },
            "adapter_segments": {
                "type": "integer",
                "default": 12,
                "minimum": 4,
                "maximum": 60,
                "description": "Axial strips along the circular-to-slot adapter (cosine-clustered at throat and slot).",
            },
            "flare_segments": {
                "type": "integer",
                "default": 13,
                "minimum": 4,
                "maximum": 60,
                "description": "Axial strips along the CD flare (cosine-clustered at slot exit and mouth).",
            },
            "plug_segments": {
                "type": "integer",
                "default": 16,
                "minimum": 4,
                "maximum": 40,
                "description": "Axial strips along the phase plug (16 by default to keep the taper and feature rail smooth).",
            },
            "roundover_segments": {
                "type": "integer",
                "default": 4,
                "minimum": 2,
                "maximum": 16,
                "description": "Strips along the mouth roundover arc.",
            },
            "outer_coarsen": {
                "type": "integer",
                "default": 2,
                "minimum": 1,
                "maximum": 6,
                "description": "Shell outer skin uses every Nth inner axial station (1 = same resolution).",
            },
        },
    },
}


def _with_defaults(params: dict) -> dict:
    merged = {name: spec["default"] for name, spec in SCHEMA["params"]["properties"].items() if "default" in spec}
    merged.update(params or {})
    return merged


def _derive(p: dict) -> dict:
    """Validate parameters and compute derived geometry. Raises ValueError on impossible combos."""
    positive = (
        "throat_diameter",
        "slot_width",
        "slot_length",
        "mouth_width",
        "mouth_height",
        "flare_depth",
        "wall_thickness",
        "enclosure_depth",
        "enclosure_margin",
        "plug_base_diameter",
        "plug_base_clearance",
        "plug_gap",
        "plug_tip_margin",
        "plug_tip_length",
    )
    for name in positive:
        if float(p[name]) <= 0.0:
            raise ValueError(f"{name} must be positive, got {p[name]!r}")
    for name in ("wall_angle_deg", "slice_angle_deg", "plug_angle_deg"):
        if not 5.0 <= float(p[name]) <= 80.0:
            raise ValueError(f"{name} must be between 5 and 80 degrees, got {p[name]!r}")
    if not 0.0 <= float(p["pinch"]) < 1.0:
        raise ValueError(f"pinch must be in [0, 1), got {p['pinch']!r}")
    if not 0.0 < float(p["pinch_pos"]) < 1.0:
        raise ValueError(f"pinch_pos must be in (0, 1), got {p['pinch_pos']!r}")
    if not 0.0 < float(p["roundover_sweep_deg"]) <= 180.0:
        raise ValueError(f"roundover_sweep_deg must be in (0, 180], got {p['roundover_sweep_deg']!r}")
    if float(p["mouth_superellipse_n"]) < 1.0:
        raise ValueError(f"mouth_superellipse_n must be >= 1, got {p['mouth_superellipse_n']!r}")
    if float(p["flare_exp"]) <= 0.0:
        raise ValueError(f"flare_exp must be positive, got {p['flare_exp']!r}")
    back = str(p["back"])
    if back not in ("shell", "enclosure"):
        raise ValueError(f"back must be 'shell' or 'enclosure', got {p['back']!r}")
    if int(p["angular_segments"]) < 8:
        raise ValueError(f"angular_segments must be >= 8, got {p['angular_segments']!r}")
    if int(p["angular_segments"]) % 4 != 0:
        raise ValueError(
            f"angular_segments must be a multiple of 4 (the mesh is built per quadrant), got {p['angular_segments']!r}"
        )
    for name in ("adapter_segments", "flare_segments", "plug_segments", "roundover_segments"):
        if int(p[name]) < 2:
            raise ValueError(f"{name} must be >= 2, got {p[name]!r}")
    if int(p["outer_coarsen"]) < 1:
        raise ValueError(f"outer_coarsen must be >= 1, got {p['outer_coarsen']!r}")

    d: dict = {}
    d["r_t"] = float(p["throat_diameter"]) / 2.0
    d["w_slot"] = float(p["slot_width"]) / 2.0
    half_slot_len = float(p["slot_length"]) / 2.0
    d["tan_wall"] = math.tan(math.radians(float(p["wall_angle_deg"])))
    slice_rad = math.radians(float(p["slice_angle_deg"]))
    d["tan_slice"] = math.tan(slice_rad)

    if half_slot_len <= d["r_t"]:
        raise ValueError(
            "slot_length must exceed throat_diameter: the circular-to-slot adapter needs positive depth "
            f"(slot_length/2 = {half_slot_len:g} mm <= throat radius {d['r_t']:g} mm)."
        )
    d["z_e"] = (half_slot_len - d["r_t"]) / d["tan_wall"]
    d["w_throat"] = d["w_slot"] + d["z_e"] * d["tan_slice"]
    if d["w_throat"] < d["r_t"]:
        raise ValueError(
            f"slice planes cut into the throat rim: clip half-width at z=0 is {d['w_throat']:.2f} mm "
            f"< throat radius {d['r_t']:.2f} mm. Increase slot_width or slice_angle_deg, or reduce throat_diameter."
        )
    # x(z) is the lesser of the expanding cone radius and the inward-moving
    # slice plane. Its maximum is their intersection, which can be much wider
    # than both the throat and a narrow slot/mouth.
    d["z_adapter_peak"] = (d["w_throat"] - d["r_t"]) / (d["tan_wall"] + d["tan_slice"])
    d["r_adapter_peak"] = d["r_t"] + d["z_adapter_peak"] * d["tan_wall"]
    d["n_pts"] = int(p["angular_segments"]) // 4 + 1
    if float(p["mouth_width"]) < float(p["slot_width"]):
        raise ValueError("mouth_width must be at least slot_width: the CD flare cannot contract.")
    if float(p["mouth_height"]) < float(p["slot_length"]):
        raise ValueError("mouth_height must be at least slot_length: the CD flare cannot contract.")
    # Bounding dimensions are not enough: with a mouth barely larger than the slot and a low
    # superellipse exponent, the rounded mouth corners can cut inside the slot's arc, making
    # the flare contract locally. Check analytic containment of the slot outline in the mouth.
    slot_check = sections.clipped_circle_quadrant(half_slot_len, d["w_slot"], 129)
    exponent = float(p["mouth_superellipse_n"])
    containment = (slot_check[:, 0] / (float(p["mouth_width"]) / 2.0)) ** exponent + (
        slot_check[:, 1] / (float(p["mouth_height"]) / 2.0)
    ) ** exponent
    if float(containment.max()) > 1.0 + 1e-9:
        raise ValueError(
            "mouth outline does not contain the slot outline: the CD flare would contract locally near the "
            "slot corners. Increase mouth_width, mouth_height, or mouth_superellipse_n."
        )
    # The actual flare loft connects equal-index boundary vertices. Analytic
    # containment alone does not guarantee that two independently arclength-
    # sampled outlines have a non-contracting point correspondence (extreme
    # tall/narrow mouths can otherwise pull a few rails inward in x).
    slot_mesh = sections.clipped_circle_quadrant(half_slot_len, d["w_slot"], d["n_pts"])
    mouth_mesh = sections.superellipse_quadrant(
        float(p["mouth_width"]) / 2.0,
        float(p["mouth_height"]) / 2.0,
        exponent,
        d["n_pts"],
    )
    if np.any(mouth_mesh + 1e-9 < slot_mesh):
        raise ValueError(
            "mouth-to-slot mesh correspondence would contract the flare locally. Increase mouth_width, "
            "mouth_height, or mouth_superellipse_n."
        )
    d["z_m"] = d["z_e"] + float(p["flare_depth"])

    roundover = float(p["mouth_roundover"])
    thickness = float(p["wall_thickness"])
    if back == "shell" and 0.0 < roundover <= thickness:
        raise ValueError(
            f"mouth_roundover ({roundover:g} mm) must be 0 or greater than wall_thickness ({thickness:g} mm) "
            "for back='shell': the rolled mouth lip needs a positive outer radius."
        )
    if back == "enclosure":
        box_half_width = float(p["mouth_width"]) / 2.0 + float(p["enclosure_margin"])
        if box_half_width <= d["r_adapter_peak"]:
            raise ValueError(
                "enclosure is narrower than the circular-to-slot adapter bulge and would intersect it: "
                f"box half-width {box_half_width:.2f} mm <= adapter half-width {d['r_adapter_peak']:.2f} mm. "
                "Increase mouth_width or enclosure_margin."
            )

    if bool(p["plug"]):
        r_pb = float(p["plug_base_diameter"]) / 2.0
        if r_pb >= d["r_t"]:
            raise ValueError(
                "plug_base_diameter must be smaller than throat_diameter so the suspended plug fits over the source."
            )
        z_base = float(p["plug_base_clearance"])
        z_tip = d["z_e"] - float(p["plug_tip_margin"])
        if z_tip <= 0.0:
            raise ValueError(
                f"plug_tip_margin leaves no room for the phase plug (adapter depth z_e = {d['z_e']:.1f} mm)."
            )
        if z_tip <= z_base:
            raise ValueError(
                "plug_base_clearance and plug_tip_margin leave no room for the phase plug "
                f"(base z = {z_base:.1f} mm, tip z = {z_tip:.1f} mm)."
            )
        plug_length = z_tip - z_base
        if float(p["plug_tip_length"]) > plug_length:
            raise ValueError(
                f"plug_tip_length ({p['plug_tip_length']:g} mm) exceeds the plug length ({plug_length:.1f} mm); "
                "reduce plug_tip_length, plug_base_clearance, or plug_tip_margin."
            )
        w_p_base = (
            d["w_throat"] - z_base * d["tan_slice"] - float(p["plug_gap"]) / math.cos(slice_rad)
        )
        w_p_tip = (
            d["w_throat"] - z_tip * d["tan_slice"] - float(p["plug_gap"]) / math.cos(slice_rad)
        )
        if w_p_tip <= 0.0:
            raise ValueError(
                "plug_gap seals the plug channels: the inset slice planes cross before the plug tip. "
                "Reduce plug_gap or plug_tip_margin."
            )
        if w_p_base < r_pb:
            raise ValueError("the inset slice planes cut the plug base circle; reduce plug_gap or plug_base_diameter.")
        tan_plug = math.tan(math.radians(float(p["plug_angle_deg"])))
        gap_y_base = d["r_t"] + z_base * d["tan_wall"] - r_pb
        gap_y_tip = d["r_t"] + z_tip * d["tan_wall"] - (r_pb + plug_length * tan_plug)
        if min(gap_y_base, gap_y_tip) < 0.5:
            raise ValueError(
                "phase plug seals against the outer cone wall along y "
                f"(clearance {min(gap_y_base, gap_y_tip):.2f} mm < 0.5 mm); "
                "reduce plug_angle_deg or plug_base_diameter."
            )
        d["r_pb"] = r_pb
        d["z_base"] = z_base
        d["z_tip"] = z_tip
        d["w_p_base"] = w_p_base
        d["tan_plug"] = tan_plug

    d["depth_eff"] = max(float(p["enclosure_depth"]), d["z_m"] + 15.0)
    return d


def _outer_skin_indices(inner_station_count: int, coarsen: int) -> list[int]:
    """Inner-station indices reused by the shell outer skin, from the mouth (last) down to 0."""
    idx = list(range(inner_station_count - 1, -1, -coarsen))
    if idx[-1] != 0:
        idx.append(0)
    return idx


def _cosine_stations_with_feature(start: float, end: float, feature: float, segments: int) -> np.ndarray:
    """Cosine stations with an exact interior feature while preserving the requested strip count."""
    if feature <= start + 1e-12 or feature >= end - 1e-12 or segments < 2:
        return sections.cosine_stations(start, end, segments)
    left = int(np.floor(segments * (feature - start) / (end - start) + 0.5))
    left = min(max(left, 1), segments - 1)
    right = segments - left
    return np.concatenate(
        (
            sections.cosine_stations(start, feature, left),
            sections.cosine_stations(feature, end, right)[1:],
        )
    )


def _with_required_indices(indices: list[int], required: tuple[int, ...]) -> list[int]:
    """Insert required stations into a descending outer-skin index list."""
    return sorted(set(indices).union(required), reverse=True)


def _combine_patches(chord: np.ndarray, arc: np.ndarray) -> np.ndarray:
    """Join feature patches without duplicating their shared corner."""
    return np.vstack((chord[:-1], arc))


def _quadrant_chains(p: dict, d: dict) -> list[tuple[list[np.ndarray], bool, int]]:
    """Assemble independent surface-patch chains as ``(stations, flip, physical_tag)``."""
    n = d["n_pts"]
    n_segments = n - 1
    r_t, z_e, z_m = d["r_t"], d["z_e"], d["z_m"]
    plug = bool(p["plug"])
    back = str(p["back"])
    thickness = float(p["wall_thickness"])
    roundover = float(p["mouth_roundover"])
    z_hat = np.array([0.0, 0.0, 1.0])

    def arc(radius: float) -> np.ndarray:
        return sections.clipped_circle_quadrant(radius, radius, n)

    def adapter_patches(z: float, offset: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
        radius = r_t + z * d["tan_wall"]
        clip = d["w_slot"] + (z_e - z) * d["tan_slice"]
        return sections.clipped_circle_quadrant_patches(radius + offset, clip + offset, n_segments)

    # The compression-driver boundary is always the complete circular exit.
    source_stations = [np.array([[0.0, 0.0, 0.0]])]
    for radius in np.linspace(0.0, r_t, _DISC_RADIAL_STRIPS + 1)[1:]:
        source_stations.append(sections.as_station(arc(radius), 0.0))
    chains: list[tuple[list[np.ndarray], bool, int]] = [(source_stations, True, DRIVEN_TAG)]

    # The adapter's cone/slice intersection is an explicit mesh rail. Chord and
    # arc point counts adapt by arclength, while the variable-count loft keeps
    # that rail continuous instead of letting it zigzag between vertex indices.
    z_adapter = _cosine_stations_with_feature(
        0.0,
        z_e,
        d["z_adapter_peak"],
        int(p["adapter_segments"]),
    )
    adapter_chords: list[np.ndarray] = []
    adapter_arcs: list[np.ndarray] = []
    adapter_outlines: list[np.ndarray] = []
    for z in z_adapter:
        chord, curved = adapter_patches(float(z))
        adapter_chords.append(sections.as_station(chord, float(z)))
        adapter_arcs.append(sections.as_station(curved, float(z)))
        adapter_outlines.append(_combine_patches(chord, curved))
    chains.extend(
        (
            (adapter_chords, True, WALL_TAG),
            (adapter_arcs, True, WALL_TAG),
        )
    )

    # CD flare: the exact feature-preserving slot outline morphs into the mouth.
    z_flare = sections.cosine_stations(z_e, z_m, int(p["flare_segments"]))
    slot_outline = adapter_outlines[-1]
    mouth_outline = sections.superellipse_quadrant(
        float(p["mouth_width"]) / 2.0,
        float(p["mouth_height"]) / 2.0,
        float(p["mouth_superellipse_n"]),
        n,
    )
    flare_depth = float(p["flare_depth"])
    flare_outlines = [slot_outline]
    for station_index, z in enumerate(z_flare[1:], start=1):
        if station_index == len(z_flare) - 1:
            # Preserve the analytic mouth bit-for-bit.  Recomputing ``u`` from
            # two independently rounded z values can land one ulp below 1.0;
            # that tiny blend error gives the outer flare a slightly different
            # normal than the rolled lip and leaves an unfused mouth seam.
            flare_outlines.append(mouth_outline.copy())
            continue
        u = (z - z_e) / flare_depth
        blend = sections.blend_outlines(slot_outline, mouth_outline, u ** float(p["flare_exp"]))
        flare_outlines.append(blend * sections.pinch_scale(u, float(p["pinch"]), float(p["pinch_pos"])))
    flare_stations = [sections.as_station(outline, float(z)) for outline, z in zip(flare_outlines, z_flare)]
    chains.append((flare_stations, True, WALL_TAG))

    if back == "shell":
        rim = flare_stations[-1]
        normals3 = np.column_stack((sections.outline_normals(mouth_outline), np.zeros(n)))
        lip = [rim]
        if roundover > 0.0:
            sweep = math.radians(float(p["roundover_sweep_deg"]))
            phis = np.linspace(0.0, sweep, int(p["roundover_segments"]) + 1)
            for phi in phis[1:]:  # inner roundover arc
                lip.append(rim + roundover * ((1.0 - math.cos(phi)) * normals3 + math.sin(phi) * z_hat))
            outer_r = roundover - thickness
            for phi in phis[::-1]:  # lip end cap, then outer roundover arc back to the mouth plane
                lip.append(
                    rim + thickness * normals3 + outer_r * ((1.0 - math.cos(phi)) * normals3 + math.sin(phi) * z_hat)
                )
        else:
            lip.append(sections.as_station(sections.offset_outline(mouth_outline, thickness), z_m))
        chains.append((lip, True, WALL_TAG))

        # Outer flare, back from the mouth to an analytic offset of the slot.
        slot_outer_chord, slot_outer_arc = adapter_patches(z_e, thickness)
        slot_outer = _combine_patches(slot_outer_chord, slot_outer_arc)
        outer_flare_outlines = [slot_outer]
        outer_flare_outlines.extend(
            sections.offset_outline(outline, thickness) for outline in flare_outlines[1:]
        )
        flare_skin_idx = _outer_skin_indices(len(z_flare), int(p["outer_coarsen"]))
        outer_flare = [
            sections.as_station(outer_flare_outlines[i], float(z_flare[i])) for i in flare_skin_idx
        ]
        chains.append((outer_flare, True, WALL_TAG))

        # Analytic offset adapter patches preserve the same sharp rail outside.
        adapter_skin_idx = _outer_skin_indices(len(z_adapter), int(p["outer_coarsen"]))
        peak_index = int(np.argmin(np.abs(z_adapter - d["z_adapter_peak"])))
        adapter_skin_idx = _with_required_indices(adapter_skin_idx, (peak_index,))
        outer_adapter_chords: list[np.ndarray] = []
        outer_adapter_arcs: list[np.ndarray] = []
        for i in adapter_skin_idx:
            chord, curved = adapter_patches(float(z_adapter[i]), thickness)
            outer_adapter_chords.append(sections.as_station(chord, float(z_adapter[i])))
            outer_adapter_arcs.append(sections.as_station(curved, float(z_adapter[i])))
        chains.extend(
            (
                (outer_adapter_chords, True, WALL_TAG),
                (outer_adapter_arcs, True, WALL_TAG),
            )
        )

        # Rigid material behind the throat; it intentionally meets the source
        # and inner wall on the existing throat T-ring used by shell generators.
        back_ring = [
            sections.as_station(arc(r_t + thickness), 0.0),
            sections.as_station(arc(r_t), 0.0),
        ]
        chains.append((back_ring, True, WALL_TAG))
    else:  # enclosure
        box_outline = sections.superellipse_quadrant(
            float(p["mouth_width"]) / 2.0 + float(p["enclosure_margin"]),
            float(p["mouth_height"]) / 2.0 + float(p["enclosure_margin"]),
            float(p["mouth_superellipse_n"]),
            n,
        )
        rim = flare_stations[-1]
        enclosure = [rim]
        for k in range(1, _BAFFLE_STRIPS + 1):  # front baffle
            frac = k / _BAFFLE_STRIPS
            enclosure.append(sections.as_station(sections.blend_outlines(mouth_outline, box_outline, frac), z_m))
        z_back = z_m - d["depth_eff"]
        for z in np.linspace(z_m, z_back, _ENCLOSURE_SIDE_SEGMENTS + 1)[1:]:  # side walls
            enclosure.append(sections.as_station(box_outline, z))
        for k in range(1, _BACK_CAP_STRIPS + 1):  # back cap collapsing to the axis
            scale = 1.0 - k / _BACK_CAP_STRIPS
            if scale <= 0.0:
                enclosure.append(np.array([[0.0, 0.0, z_back]]))
            else:
                enclosure.append(sections.as_station(box_outline * scale, z_back))
        chains.append((enclosure, True, WALL_TAG))

    if plug:
        z_base = d["z_base"]
        z_taper = d["z_tip"] - float(p["plug_tip_length"])
        z_plug = _cosine_stations_with_feature(
            z_base,
            d["z_tip"],
            z_taper,
            int(p["plug_segments"]),
        )
        taper_span = d["z_tip"] - z_taper
        plug_cap = [np.array([[0.0, 0.0, z_base]])]
        for radius in np.linspace(0.0, d["r_pb"], _PLUG_CAP_RADIAL_STRIPS + 1)[1:]:
            plug_cap.append(sections.as_station(arc(float(radius)), z_base))
        chains.append((plug_cap, False, WALL_TAG))

        plug_chords: list[np.ndarray] = []
        plug_arcs: list[np.ndarray] = []
        for z in z_plug:
            r_pz = d["r_pb"] + (z - z_base) * d["tan_plug"]
            w_pz = d["w_p_base"] - (z - z_base) * d["tan_slice"]
            s = min(max((z - z_taper) / taper_span, 0.0), 1.0)
            taper = math.sqrt(max(0.0, 1.0 - s * s))
            clip = min(r_pz, w_pz) * taper
            chord, curved = sections.clipped_circle_quadrant_patches(r_pz, clip, n_segments)
            plug_chords.append(sections.as_station(chord, float(z)))
            plug_arcs.append(sections.as_station(curved, float(z)))
        chains.extend(
            (
                (plug_chords, False, WALL_TAG),
                (plug_arcs, False, WALL_TAG),
            )
        )

    return chains


def build_quadrant(params: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Build the +x/+y quadrant mesh. Returns (points (V,3) mm, triangles (T,3), physical tags (T,))."""
    p = _with_defaults(params)
    d = _derive(p)
    all_points: list[np.ndarray] = []
    all_triangles: list[np.ndarray] = []
    all_tags: list[np.ndarray] = []
    offset = 0
    for stations, flip, physical_tag in _quadrant_chains(p, d):
        points, triangles, _strips = sections.loft_chain(stations, flip=flip)
        all_points.append(points)
        all_triangles.append(triangles + offset)
        all_tags.append(np.full(len(triangles), physical_tag, dtype=np.int32))
        offset += len(points)
    return (
        np.vstack(all_points),
        np.vstack(all_triangles),
        np.concatenate(all_tags).astype(np.int32),
    )


def estimate_triangles(params: dict) -> int:
    """Exact topology-only full-mesh count (no mirroring, mesh files, or gmsh work)."""
    p = _with_defaults(params)
    d = _derive(p)
    quadrant = 0
    for stations, flip, _physical_tag in _quadrant_chains(p, d):
        _points, triangles, _strips = sections.loft_chain(stations, flip=flip)
        quadrant += len(triangles)
    return 4 * quadrant


def mouth_to_outer_margin_mm(params: dict) -> float:
    """Per-side mm the shell adds outside the mouth aperture (back='shell').

    ``mouth_width``/``mouth_height`` are the AIR aperture. The rolled mouth lip
    reaches further out than either the bare mouth or the plain wall offset, so
    the physical envelope is always larger than the mouth by this margin on every
    side. Closed form (c = 1 - cos(roundover_sweep)):

        margin = max(mouth_roundover * c, wall_thickness + (mouth_roundover - wall_thickness) * c)

    which is ``mouth_roundover`` exactly at the default 90 deg sweep, grows to
    ``2 * mouth_roundover`` at a 180 deg rollback, and collapses to
    ``wall_thickness`` when ``mouth_roundover`` is 0.

    Unlike the lip *depth* (see :func:`mouth_lip_depth_mm`), the sampling of the
    arc does not matter here: ``1 - cos`` increases monotonically over the whole
    legal sweep range, so the outermost station is always the last one, which the
    loft samples exactly.
    """
    p = _with_defaults(params)
    if str(p["back"]) != "shell":
        return float(p["enclosure_margin"])
    thickness = float(p["wall_thickness"])
    roundover = float(p["mouth_roundover"])
    if roundover <= 0.0:
        return thickness
    c = 1.0 - math.cos(math.radians(float(p["roundover_sweep_deg"])))
    return max(roundover * c, thickness + (roundover - thickness) * c)


def _roundover_station_angles(params: dict) -> np.ndarray:
    """The roundover arc angles the loft actually samples (see _quadrant_chains)."""
    return np.linspace(0.0, math.radians(float(params["roundover_sweep_deg"])), int(params["roundover_segments"]) + 1)


def mouth_lip_depth_mm(params: dict) -> float:
    """How far past the mouth plane the rolled lip reaches, in mm (back='shell').

    The lip is a *sampled* arc, not a continuous one: ``_quadrant_chains`` places
    ``roundover_segments + 1`` stations evenly from 0 to ``roundover_sweep_deg``,
    and the deepest station is whichever lies nearest 90 deg. So a sweep past
    90 deg only reaches the full ``mouth_roundover`` when 90 deg happens to be
    sampled — e.g. sweep 120 over 4 segments samples 0/30/60/90/120 and does,
    but sweep 100 over 4 segments samples 0/25/50/75/100 and stops 1.5% short
    (worst case in the legal range, sweep 110 over 3 segments, is 4.2% short).
    Assuming the continuous maximum would overstate the depth by up to ~1.3 mm
    and could reject a valid near-limit proposal.
    """
    return float(params["mouth_roundover"]) * float(np.max(np.sin(_roundover_station_angles(params))))


def estimate_bbox_mm(params: dict) -> list[float]:
    """Closed-form outer bounding box [x, y, z] in mm, without building the mesh.

    Exact (matches ``mesh_stats`` on the cleaned mesh to floating-point noise), so
    a designer can check the size envelope before spending a trial. Validation is
    the same as ``build_quadrant``: impossible parameter combinations raise here
    too.

        x = 2 * max(mouth_width/2 + margin, adapter_peak + shell_offset)
        y = mouth_height + 2 * margin
        z = z_e + flare_depth + lip_depth    (see mouth_lip_depth_mm)

    with the derived adapter depth z_e = (slot_length/2 - throat_diameter/2) /
    tan(wall_angle_deg). For back='enclosure' the margin is ``enclosure_margin``,
    the roundover is ignored, and z is the clamped ``enclosure_depth``.
    """
    p = _with_defaults(params)
    d = _derive(p)
    margin = mouth_to_outer_margin_mm(p)
    mouth_half_width = float(p["mouth_width"]) / 2.0 + margin
    adapter_half_width = d["r_adapter_peak"]
    if str(p["back"]) == "shell":
        adapter_half_width += float(p["wall_thickness"])
    width = 2.0 * max(mouth_half_width, adapter_half_width)
    height = float(p["mouth_height"]) + 2.0 * margin
    if str(p["back"]) != "shell":
        return [width, height, float(d["depth_eff"])]
    return [width, height, d["z_m"] + mouth_lip_depth_mm(p)]


def generate(params: dict, out_dir: Path, name: str, emit: Callable[[dict], None]) -> dict:
    import meshio

    from blab.config import RadiatorConfig
    from blab.mesh_clean import clean_mesh_file, triangle_quality_warning
    from blab.protocol import radiator_to_dict

    p = _with_defaults(params)
    estimate = estimate_triangles(p)
    bbox_estimate = estimate_bbox_mm(p)
    emit(
        {
            "event": "progress",
            "stage": "sections",
            "message": (
                f"Assembling section loft (exact topology estimate: {estimate} triangles after mirroring, "
                f"outer bbox {bbox_estimate[0]:.1f}x{bbox_estimate[1]:.1f}x{bbox_estimate[2]:.1f} mm)"
            ),
        }
    )
    points, triangles, tags = build_quadrant(p)

    out_dir.mkdir(parents=True, exist_ok=True)
    raw_msh = out_dir / f"{name}.msh"
    quadrant_mesh = meshio.Mesh(
        points=points,
        cells=[("triangle", triangles)],
        cell_data={"gmsh:physical": [tags], "gmsh:geometrical": [tags]},
        field_data={
            "SD1D1001": np.array([DRIVEN_TAG, 2], dtype=np.int32),
            "walls": np.array([WALL_TAG, 2], dtype=np.int32),
        },
    )
    meshio.write(raw_msh, quadrant_mesh, file_format="gmsh22", binary=False)

    emit({"event": "progress", "stage": "clean", "message": "Mirroring quadrant across x/y and cleaning"})
    cleaned_msh = out_dir / f"{name}_clean.msh"
    clean_mesh_file(str(raw_msh), str(cleaned_msh), mirror_x=False, mirror_axes=("x", "y"))
    reduced_msh = out_dir / f"{name}_clean_reduced.msh"
    clean_mesh_file(str(raw_msh), str(reduced_msh), mirror_x=False, mirror_axes=())

    warning = triangle_quality_warning(meshio.read(cleaned_msh))
    triangle_count, bbox_mm = mesh_stats(cleaned_msh)
    radiators = (RadiatorConfig(name="throat", tag=DRIVEN_TAG, level_db=0.0),)

    config_used = out_dir / f"{name}_params.json"
    config_used.write_text(json.dumps(p, indent=2), encoding="utf-8")
    return {
        "mesh_path": str(raw_msh),
        "cleaned_msh_path": str(cleaned_msh),
        "reduced_msh_path": str(reduced_msh),
        "mirror_axes": ["x", "y"],  # the quadrant is mirrored across x and y -> symmetry="xy" only
        "stl_path": None,
        "triangles": triangle_count,
        "estimated_triangles": estimate,
        "bbox_mm": bbox_mm,
        "estimated_bbox_mm": bbox_estimate,
        "driven_tag": DRIVEN_TAG,
        "radiators": [radiator_to_dict(radiator) for radiator in radiators],
        "quality_warning": quality_warning_text(warning if warning.has_warnings else None),
        "config_used": str(config_used),
    }
