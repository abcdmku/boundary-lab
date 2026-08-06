"""slot_cd_horn: circular-to-slot adapter feeding a constant-directivity flare.

Geometry (mm; fires +z; throat plane z=0; x = slot narrow axis, y = slot long axis):

- Outer adapter cone r(z) = r_t + z*tan(wall_angle), clipped by two slice planes
  that each contain a slot long edge (x = +/- slot_width/2 at z_e) and tilt at
  slice_angle opening toward the throat: clip half-width
  w(z) = slot_width/2 + (z_e - z)*tan(slice_angle). The adapter depth is derived:
  z_e = (slot_length/2 - r_t) / tan(wall_angle).
- Phase plug = sliced wedge: inner cone r_p(z) from plug_base_diameter/2 clipped
  by planes parallel to the slice planes inset plug_gap perpendicular, closing
  to a ridge over plug_tip_length and stopping plug_tip_margin short of the slot
  exit. The plug base circle is fused with the driven annulus inner rim.
- Driven surface (tag 2, "SD1D1001"): the annulus at z=0 between the plug base
  and the driver exit (full disc when plug=false). Everything else is tag 1
  "walls" (the plug is a rigid wall).
- CD flare: the slot outline morphs to a superellipse mouth over flare_depth
  (flare_exp=1 -> straight conical walls, true CD), with an optional mid-flare
  pinch waist and an ATH-Term-style mouth roundover (radius + sweep).
- back="shell": free-standing horn, in-plane offset outer skin (wall_thickness)
  with a rolled mouth lip and a throat back ring. back="enclosure": box behind
  the mouth baffle (mouth_roundover is ignored in enclosure mode).

Construction: direct structured section loft (numpy + meshio), not OCC booleans.
Every surface is a closed-form family of quadrant outlines (slot_cd_sections)
lofted into quad strips. Only the +x/+y quadrant is generated with nodes exactly
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

_ANNULUS_RADIAL_STRIPS = 2  # driven annulus strips when the plug is present
_DISC_RADIAL_STRIPS = 3  # driven disc strips when plug=false (innermost collapses)
_BAFFLE_STRIPS = 2  # enclosure front baffle strips (mouth outline -> box outline)
_ENCLOSURE_SIDE_SEGMENTS = 4  # enclosure side-wall strips
_BACK_CAP_STRIPS = 3  # enclosure back-cap strips (last collapses to the axis)

SCHEMA = {
    "id": "slot_cd_horn",
    "title": "Circular-to-Slot + CD Flare Horn",
    "description": (
        "Compression-driver horn: conical circular-to-slot adapter (two slice planes cut the cone into a "
        "slot exit, with an optional sliced-wedge phase plug) feeding a constant-directivity flare that "
        "morphs the slot into a superellipse mouth. Driven annulus at the throat plane is physical tag 2 "
        "'SD1D1001'; walls are tag 1. Fires along +z, throat at z=0, x = slot narrow axis, y = slot long "
        "axis (vertical slot: mouth_width sets horizontal coverage). Mesh units are mm. Built as a direct "
        "structured section loft in the +x/+y quadrant and mirrored, so solves can use --symmetry x or xy "
        "via reduced_msh_path. Adapter depth is derived: z_e = (slot_length/2 - throat_diameter/2) / "
        "tan(wall_angle_deg). mouth_roundover is ignored when back='enclosure'."
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
                "description": "Plug base diameter at the throat plane in mm (must be < throat_diameter).",
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
                "description": "Mouth width in mm (x, horizontal coverage plane). Must be >= slot_width.",
            },
            "mouth_height": {
                "type": "number",
                "default": 240,
                "minimum": 40,
                "maximum": 800,
                "description": "Mouth height in mm (y, vertical coverage plane). Must be >= slot_length.",
            },
            "flare_depth": {
                "type": "number",
                "default": 120,
                "minimum": 10,
                "maximum": 500,
                "description": "Axial depth of the CD flare in mm.",
            },
            "mouth_superellipse_n": {
                "type": "number",
                "default": 4,
                "minimum": 2,
                "maximum": 12,
                "description": "Mouth superellipse exponent (2 = ellipse, higher = squarer corners).",
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
                "description": "Mouth roundover radius in mm (0 = sharp mouth; shell back needs 0 or > wall_thickness).",
            },
            "roundover_sweep_deg": {
                "type": "number",
                "default": 90,
                "minimum": 30,
                "maximum": 180,
                "description": "Roundover sweep angle in degrees (90 = quarter round, 180 = full rollback).",
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
                "default": 10,
                "minimum": 4,
                "maximum": 40,
                "description": "Axial strips along the phase plug.",
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
    d["z_m"] = d["z_e"] + float(p["flare_depth"])

    roundover = float(p["mouth_roundover"])
    thickness = float(p["wall_thickness"])
    if back == "shell" and 0.0 < roundover <= thickness:
        raise ValueError(
            f"mouth_roundover ({roundover:g} mm) must be 0 or greater than wall_thickness ({thickness:g} mm) "
            "for back='shell': the rolled mouth lip needs a positive outer radius."
        )

    if bool(p["plug"]):
        r_pb = float(p["plug_base_diameter"]) / 2.0
        if r_pb >= d["r_t"]:
            raise ValueError(
                "plug_base_diameter must be smaller than throat_diameter so the driven annulus has positive width."
            )
        z_tip = d["z_e"] - float(p["plug_tip_margin"])
        if z_tip <= 0.0:
            raise ValueError(
                f"plug_tip_margin leaves no room for the phase plug (adapter depth z_e = {d['z_e']:.1f} mm)."
            )
        if float(p["plug_tip_length"]) > z_tip:
            raise ValueError(
                f"plug_tip_length ({p['plug_tip_length']:g} mm) exceeds the plug depth ({z_tip:.1f} mm); "
                "reduce plug_tip_length or plug_tip_margin."
            )
        w_p0 = d["w_throat"] - float(p["plug_gap"]) / math.cos(slice_rad)
        w_p_tip = w_p0 - z_tip * d["tan_slice"]
        if w_p_tip <= 0.0:
            raise ValueError(
                "plug_gap seals the plug channels: the inset slice planes cross before the plug tip. "
                "Reduce plug_gap or plug_tip_margin."
            )
        if w_p0 < r_pb:
            raise ValueError("the inset slice planes cut the plug base circle; reduce plug_gap or plug_base_diameter.")
        tan_plug = math.tan(math.radians(float(p["plug_angle_deg"])))
        gap_y_tip = (d["r_t"] - r_pb) + z_tip * (d["tan_wall"] - tan_plug)
        if min(d["r_t"] - r_pb, gap_y_tip) < 0.5:
            raise ValueError(
                "phase plug seals against the outer cone wall along y "
                f"(clearance {min(d['r_t'] - r_pb, gap_y_tip):.2f} mm < 0.5 mm); "
                "reduce plug_angle_deg or plug_base_diameter."
            )
        d["r_pb"] = r_pb
        d["z_tip"] = z_tip
        d["w_p0"] = w_p0
        d["tan_plug"] = tan_plug

    d["n_pts"] = int(p["angular_segments"]) // 4 + 1
    d["depth_eff"] = max(float(p["enclosure_depth"]), d["z_m"] + 15.0)
    return d


def _outer_skin_indices(inner_station_count: int, coarsen: int) -> list[int]:
    """Inner-station indices reused by the shell outer skin, from the mouth (last) down to 0."""
    idx = list(range(inner_station_count - 1, -1, -coarsen))
    if idx[-1] != 0:
        idx.append(0)
    return idx


def _quadrant_chains(p: dict, d: dict) -> list[tuple[list[np.ndarray], bool, int]]:
    """Assemble the station chains. Returns [(stations, flip, driven_strip_count), ...]."""
    n = d["n_pts"]
    r_t, z_e, z_m = d["r_t"], d["z_e"], d["z_m"]
    plug = bool(p["plug"])
    back = str(p["back"])
    thickness = float(p["wall_thickness"])
    roundover = float(p["mouth_roundover"])
    z_hat = np.array([0.0, 0.0, 1.0])

    def arc(radius: float) -> np.ndarray:
        if radius <= 0.0:
            return np.zeros((n, 2))
        return sections.clipped_circle_quadrant(radius, radius, n)

    def adapter_outline(z: float) -> np.ndarray:
        radius = r_t + z * d["tan_wall"]
        clip = d["w_slot"] + (z_e - z) * d["tan_slice"]
        return sections.clipped_circle_quadrant(radius, clip, n)

    # Driven surface stations at z=0 (annulus around the plug base, or full disc).
    if plug:
        radii = np.linspace(d["r_pb"], r_t, _ANNULUS_RADIAL_STRIPS + 1)
    else:
        radii = np.linspace(0.0, r_t, _DISC_RADIAL_STRIPS + 1)
    annulus_stations = [sections.as_station(arc(r), 0.0) for r in radii]
    driven_strips = len(annulus_stations) - 1

    # Inner wall outlines: adapter (clipped circles) then CD flare (slot -> mouth blend).
    z_adapter = sections.cosine_stations(0.0, z_e, int(p["adapter_segments"]))
    z_flare = sections.cosine_stations(z_e, z_m, int(p["flare_segments"]))
    inner_z = np.concatenate((z_adapter, z_flare[1:]))
    outlines = [adapter_outline(z) for z in z_adapter]
    slot_outline = outlines[-1]
    mouth_outline = sections.superellipse_quadrant(
        float(p["mouth_width"]) / 2.0,
        float(p["mouth_height"]) / 2.0,
        float(p["mouth_superellipse_n"]),
        n,
    )
    flare_depth = float(p["flare_depth"])
    for z in z_flare[1:]:
        u = (z - z_e) / flare_depth
        blend = sections.blend_outlines(slot_outline, mouth_outline, u ** float(p["flare_exp"]))
        outlines.append(blend * sections.pinch_scale(u, float(p["pinch"]), float(p["pinch_pos"])))

    main = list(annulus_stations)
    inner_stations = [sections.as_station(outlines[i], inner_z[i]) for i in range(len(inner_z))]
    main.extend(inner_stations[1:])  # inner_stations[0] is bitwise-equal to annulus_stations[-1]

    if back == "shell":
        rim = inner_stations[-1]
        normals3 = np.column_stack((sections.outline_normals(mouth_outline), np.zeros(n)))
        skin_idx = _outer_skin_indices(len(inner_z), int(p["outer_coarsen"]))
        if roundover > 0.0:
            sweep = math.radians(float(p["roundover_sweep_deg"]))
            phis = np.linspace(0.0, sweep, int(p["roundover_segments"]) + 1)
            for phi in phis[1:]:  # inner roundover arc
                main.append(rim + roundover * ((1.0 - math.cos(phi)) * normals3 + math.sin(phi) * z_hat))
            outer_r = roundover - thickness
            for phi in phis[::-1]:  # lip end cap, then outer roundover arc back to the mouth plane
                main.append(
                    rim + thickness * normals3 + outer_r * ((1.0 - math.cos(phi)) * normals3 + math.sin(phi) * z_hat)
                )
            skin_idx = skin_idx[1:]  # the mouth-plane offset station is the arc's phi=0 station
        for i in skin_idx:  # outer skin back down to the throat plane
            main.append(sections.as_station(sections.offset_outline(outlines[i], thickness), inner_z[i]))
        main.append(inner_stations[0])  # throat back ring closes onto the throat rim circle
    else:  # enclosure
        box_outline = sections.superellipse_quadrant(
            float(p["mouth_width"]) / 2.0 + float(p["enclosure_margin"]),
            float(p["mouth_height"]) / 2.0 + float(p["enclosure_margin"]),
            float(p["mouth_superellipse_n"]),
            n,
        )
        for k in range(1, _BAFFLE_STRIPS + 1):  # front baffle
            frac = k / _BAFFLE_STRIPS
            main.append(sections.as_station(sections.blend_outlines(mouth_outline, box_outline, frac), z_m))
        z_back = z_m - d["depth_eff"]
        for z in np.linspace(z_m, z_back, _ENCLOSURE_SIDE_SEGMENTS + 1)[1:]:  # side walls
            main.append(sections.as_station(box_outline, z))
        for k in range(1, _BACK_CAP_STRIPS + 1):  # back cap collapsing to the axis
            scale = 1.0 - k / _BACK_CAP_STRIPS
            main.append(sections.as_station(box_outline * scale, z_back))

    chains = [(main, True, driven_strips)]

    if plug:
        z_plug = sections.cosine_stations(0.0, d["z_tip"], int(p["plug_segments"]))
        z_taper = d["z_tip"] - float(p["plug_tip_length"])
        taper_span = d["z_tip"] - z_taper
        plug_stations = [annulus_stations[0]]  # base circle fused with the annulus inner rim
        for z in z_plug[1:]:
            r_pz = d["r_pb"] + z * d["tan_plug"]
            w_pz = d["w_p0"] - z * d["tan_slice"]
            s = min(max((z - z_taper) / taper_span, 0.0), 1.0)
            taper = math.sqrt(max(0.0, 1.0 - s * s))
            clip = min(r_pz, w_pz) * taper
            plug_stations.append(sections.as_station(sections.clipped_circle_quadrant(r_pz, clip, n), z))
        chains.append((plug_stations, False, 0))

    return chains


def build_quadrant(params: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Build the +x/+y quadrant mesh. Returns (points (V,3) mm, triangles (T,3), physical tags (T,))."""
    p = _with_defaults(params)
    d = _derive(p)
    all_points: list[np.ndarray] = []
    all_triangles: list[np.ndarray] = []
    all_tags: list[np.ndarray] = []
    offset = 0
    for stations, flip, driven_strips in _quadrant_chains(p, d):
        points, triangles, strips = sections.loft_chain(stations, flip=flip)
        all_points.append(points)
        all_triangles.append(triangles + offset)
        all_tags.append(np.where(strips < driven_strips, DRIVEN_TAG, WALL_TAG))
        offset += len(points)
    return (
        np.vstack(all_points),
        np.vstack(all_triangles),
        np.concatenate(all_tags).astype(np.int32),
    )


def estimate_triangles(params: dict) -> int:
    """Closed-form full-mesh triangle count (exactly matches build_quadrant + x/y mirroring)."""
    p = _with_defaults(params)
    d = _derive(p)
    n_seg = d["n_pts"] - 1
    plug = bool(p["plug"])
    inner_count = int(p["adapter_segments"]) + int(p["flare_segments"]) + 1

    stations = (_ANNULUS_RADIAL_STRIPS + 1 if plug else _DISC_RADIAL_STRIPS + 1) + (inner_count - 1)
    collapsed_strips = 0 if plug else 1
    if str(p["back"]) == "shell":
        skin = len(_outer_skin_indices(inner_count, int(p["outer_coarsen"])))
        if float(p["mouth_roundover"]) > 0.0:
            stations += 2 * int(p["roundover_segments"]) + skin  # arcs + cap share the mouth-plane station
        else:
            stations += skin
        stations += 1  # throat back ring
    else:
        stations += _BAFFLE_STRIPS + _ENCLOSURE_SIDE_SEGMENTS + _BACK_CAP_STRIPS
        collapsed_strips += 1
    quadrant = 2 * n_seg * (stations - 1) - n_seg * collapsed_strips
    if plug:
        quadrant += 2 * n_seg * int(p["plug_segments"])
    return 4 * quadrant


def generate(params: dict, out_dir: Path, name: str, emit: Callable[[dict], None]) -> dict:
    import meshio

    from blab.config import RadiatorConfig
    from blab.mesh_clean import clean_mesh_file, triangle_quality_warning
    from blab.protocol import radiator_to_dict

    p = _with_defaults(params)
    estimate = estimate_triangles(p)
    emit(
        {
            "event": "progress",
            "stage": "sections",
            "message": f"Assembling section loft (closed-form estimate: {estimate} triangles after mirroring)",
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
        "driven_tag": DRIVEN_TAG,
        "radiators": [radiator_to_dict(radiator) for radiator in radiators],
        "quality_warning": quality_warning_text(warning if warning.has_warnings else None),
        "config_used": str(config_used),
    }
