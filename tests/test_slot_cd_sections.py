"""Unit tests for the slot_cd_horn section family and quadrant loft.

Pure numpy: no gmsh/GPU. Covers clip widths, symmetry-plane pinning,
watertightness invariants of the mirrored mesh, and the closed-form
triangle-count estimate (~7.6k at defaults).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

BRIDGE_PY = Path(__file__).resolve().parents[1] / "bridge" / "py"
if str(BRIDGE_PY) not in sys.path:
    sys.path.insert(0, str(BRIDGE_PY))

from generators import slot_cd_horn as horn  # noqa: E402
from generators import slot_cd_sections as sections  # noqa: E402


def edge_use_counts(triangles: np.ndarray) -> dict[tuple[int, int], int]:
    counts: dict[tuple[int, int], int] = {}
    for a, b, c in np.asarray(triangles):
        for u, v in ((a, b), (b, c), (c, a)):
            key = (int(min(u, v)), int(max(u, v)))
            counts[key] = counts.get(key, 0) + 1
    return counts


def build_full(params: dict) -> tuple[np.ndarray, np.ndarray]:
    points, triangles, _tags = horn.build_quadrant(params)
    return sections.mirror_quadrant(points, triangles)


# ---------------------------------------------------------------------------
# Section outlines: clip widths
# ---------------------------------------------------------------------------


class TestClippedCircleQuadrant:
    def test_unclipped_is_quarter_arc(self):
        out = sections.clipped_circle_quadrant(5.0, 10.0, 17)
        radii = np.linalg.norm(out, axis=1)
        assert np.allclose(radii, 5.0)
        assert out[0, 0] == 5.0 and out[0, 1] == 0.0
        assert out[-1, 0] == 0.0 and out[-1, 1] == 5.0

    def test_clipped_respects_clip_width(self):
        out = sections.clipped_circle_quadrant(80.0, 10.0, 33)
        assert np.max(out[:, 0]) <= 10.0 + 1e-12
        chord = out[np.abs(out[:, 0] - 10.0) < 1e-12]
        assert len(chord) >= 2  # a real flat exists at x == clip_x
        radii = np.linalg.norm(out, axis=1)
        assert np.all(radii <= 80.0 + 1e-9)
        assert out[-1, 1] == 80.0

    def test_degenerate_clip_is_ridge_on_x0(self):
        out = sections.clipped_circle_quadrant(56.0, 0.0, 17)
        assert np.all(out[:, 0] == 0.0)
        assert out[0, 1] == 0.0 and out[-1, 1] == 56.0

    def test_adapter_clip_widths_at_defaults(self):
        # Defaults: r_t=18, z_e=62, w(z) = 10 + (62 - z); clipping starts at z=27.
        def r(z):
            return 18.0 + z

        def w(z):
            return 10.0 + (62.0 - z)

        unclipped = sections.clipped_circle_quadrant(r(20.0), w(20.0), 33)
        assert np.isclose(np.max(unclipped[:, 0]), r(20.0))  # w(20)=52 > r(20)=38
        clipped = sections.clipped_circle_quadrant(r(40.0), w(40.0), 33)
        assert np.isclose(np.max(clipped[:, 0]), w(40.0))  # w(40)=32 < r(40)=58
        slot = sections.clipped_circle_quadrant(r(62.0), w(62.0), 33)
        assert np.isclose(np.max(slot[:, 0]), 10.0)  # slot half-width
        assert np.isclose(slot[-1, 1], 80.0)  # slot half-length


class TestSuperellipse:
    def test_ellipse_case(self):
        out = sections.superellipse_quadrant(180.0, 120.0, 2.0, 33)
        vals = (out[:, 0] / 180.0) ** 2 + (out[:, 1] / 120.0) ** 2
        assert np.allclose(vals, 1.0, atol=5e-3)

    def test_endpoints_exact(self):
        out = sections.superellipse_quadrant(180.0, 120.0, 4.0, 17)
        assert tuple(out[0]) == (180.0, 0.0)
        assert tuple(out[-1]) == (0.0, 120.0)

    def test_arclength_uniform(self):
        out = sections.superellipse_quadrant(180.0, 120.0, 4.0, 65)
        seg = np.linalg.norm(np.diff(out, axis=0), axis=1)
        assert seg.max() / seg.min() < 1.1


class TestResample:
    def test_endpoints_and_uniformity(self):
        poly = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 3.0]])
        out = sections.resample_polyline(poly, 9)
        assert tuple(out[0]) == (0.0, 0.0)
        assert tuple(out[-1]) == (1.0, 3.0)
        seg = np.linalg.norm(np.diff(out, axis=0), axis=1)
        assert np.allclose(seg, 0.5)


class TestPinch:
    def test_endpoints_exactly_one(self):
        assert sections.pinch_scale(0.0, 0.4, 0.5) == 1.0
        assert sections.pinch_scale(1.0, 0.4, 0.5) == 1.0

    def test_waist_depth_at_pinch_pos(self):
        assert np.isclose(sections.pinch_scale(0.3, 0.4, 0.3), 0.6)


# ---------------------------------------------------------------------------
# Symmetry-plane pinning
# ---------------------------------------------------------------------------


class TestSymmetryPinning:
    @pytest.mark.parametrize(
        "outline",
        [
            sections.clipped_circle_quadrant(18.0, 72.0, 17),
            sections.clipped_circle_quadrant(80.0, 10.0, 17),
            sections.clipped_circle_quadrant(56.0, 0.0, 17),
            sections.superellipse_quadrant(180.0, 120.0, 4.0, 17),
            sections.offset_outline(sections.clipped_circle_quadrant(80.0, 10.0, 17), 6.0),
        ],
    )
    def test_outline_endpoints_pinned(self, outline):
        assert outline[0, 1] == 0.0  # first point exactly on y=0
        assert outline[-1, 0] == 0.0  # last point exactly on x=0

    def test_normals_pinned(self):
        normals = sections.outline_normals(sections.superellipse_quadrant(180.0, 120.0, 4.0, 17))
        assert tuple(normals[0]) == (1.0, 0.0)
        assert tuple(normals[-1]) == (0.0, 1.0)

    @pytest.mark.parametrize(
        "params",
        [
            {},
            {"plug": False},
            {"back": "enclosure"},
            {"mouth_roundover": 0},
            {"pinch": 0.4},
        ],
    )
    def test_quadrant_stays_in_fundamental_domain(self, params):
        points, _tris, _tags = horn.build_quadrant(params)
        assert np.isfinite(points).all()
        assert points[:, 0].min() >= 0.0
        assert points[:, 1].min() >= 0.0
        # Seam nodes exist exactly on both symmetry planes.
        assert np.any(points[:, 0] == 0.0)
        assert np.any(points[:, 1] == 0.0)


# ---------------------------------------------------------------------------
# Watertightness invariants of the mirrored full mesh
# ---------------------------------------------------------------------------


class TestWatertightness:
    @pytest.mark.parametrize(
        "params",
        [
            {},
            {"plug": False},
            {"pinch": 0.4},
            {"mouth_roundover": 0},
            {"back": "enclosure"},
            {"back": "enclosure", "plug": False, "mouth_roundover": 0},
        ],
    )
    def test_no_open_edges(self, params):
        points, triangles = build_full(params)
        counts = edge_use_counts(triangles)
        open_edges = [edge for edge, count in counts.items() if count == 1]
        assert open_edges == []

    def test_shell_nonmanifold_only_at_throat_ring(self):
        # The shell back closes onto the throat rim circle (axisym_horn precedent):
        # every over-shared edge must lie exactly on that circle, and nowhere else.
        points, triangles = build_full({})
        counts = edge_use_counts(triangles)
        overshared = [edge for edge, count in counts.items() if count > 2]
        assert overshared  # the T-ring exists
        for u, v in overshared:
            for vertex in (points[u], points[v]):
                assert abs(np.hypot(vertex[0], vertex[1]) - 18.0) < 1e-9
                assert vertex[2] == 0.0

    def test_enclosure_is_two_manifold(self):
        points, triangles = build_full({"back": "enclosure"})
        counts = edge_use_counts(triangles)
        assert all(count == 2 for count in counts.values())

    def test_no_degenerate_triangles(self):
        points, triangles = build_full({})
        v0, v1, v2 = (points[triangles[:, i]] for i in range(3))
        areas = 0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0), axis=1)
        assert areas.min() > 1e-9

    def test_driven_annulus_area(self):
        # Driven quadrant area ~ quarter annulus between plug base (r=9) and throat (r=18).
        points, triangles, tags = horn.build_quadrant({})
        driven = triangles[tags == horn.DRIVEN_TAG]
        v0, v1, v2 = (points[driven[:, i]] for i in range(3))
        area = float(np.sum(0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0), axis=1)))
        expected = np.pi * (18.0**2 - 9.0**2) / 4.0
        assert abs(area - expected) / expected < 0.02
        assert np.allclose(np.vstack((v0, v1, v2))[:, 2], 0.0)  # all on the throat plane


# ---------------------------------------------------------------------------
# Validation errors
# ---------------------------------------------------------------------------


class TestValidation:
    def test_slot_shorter_than_throat(self):
        with pytest.raises(ValueError, match="slot_length must exceed throat_diameter"):
            horn.build_quadrant({"slot_length": 30, "throat_diameter": 36})

    def test_mouth_smaller_than_slot(self):
        with pytest.raises(ValueError, match="mouth_width must be at least slot_width"):
            horn.build_quadrant({"mouth_width": 15, "slot_width": 20})
        with pytest.raises(ValueError, match="mouth_height must be at least slot_length"):
            horn.build_quadrant({"mouth_height": 100, "slot_length": 160})

    def test_plug_base_too_large(self):
        with pytest.raises(ValueError, match="plug_base_diameter must be smaller"):
            horn.build_quadrant({"plug_base_diameter": 36})

    def test_plug_tip_margin_too_large(self):
        with pytest.raises(ValueError, match="plug_tip_margin leaves no room"):
            horn.build_quadrant({"plug_tip_margin": 70})

    def test_plug_gap_seals_channels(self):
        with pytest.raises(ValueError, match="plug_gap seals the plug channels"):
            horn.build_quadrant({"plug_gap": 25, "plug_tip_margin": 2, "slot_width": 8})

    def test_roundover_thinner_than_wall(self):
        with pytest.raises(ValueError, match="mouth_roundover .* must be 0 or greater than wall_thickness"):
            horn.build_quadrant({"mouth_roundover": 4, "wall_thickness": 6})

    def test_enclosure_allows_small_roundover(self):
        # mouth_roundover is ignored for back='enclosure', so no error.
        horn.build_quadrant({"back": "enclosure", "mouth_roundover": 4})

    def test_angular_segments_must_be_multiple_of_four(self):
        with pytest.raises(ValueError, match="angular_segments must be a multiple of 4"):
            horn.build_quadrant({"angular_segments": 19})

    def test_slices_cutting_throat(self):
        with pytest.raises(ValueError, match="slice planes cut into the throat rim"):
            horn.build_quadrant({"slice_angle_deg": 10, "slot_width": 6, "slot_length": 80, "wall_angle_deg": 20})


# ---------------------------------------------------------------------------
# Triangle-count estimate
# ---------------------------------------------------------------------------


class TestTriangleEstimate:
    def test_default_estimate_near_7600(self):
        estimate = horn.estimate_triangles({})
        assert abs(estimate - 7600) <= 400  # ~7.6k at defaults, inside the 9k iteration rule

    @pytest.mark.parametrize(
        "params",
        [
            {},
            {"plug": False},
            {"back": "enclosure"},
            {"mouth_roundover": 0},
            {"outer_coarsen": 1},
            {"angular_segments": 32, "adapter_segments": 6, "flare_segments": 6},
        ],
    )
    def test_estimate_matches_built_mesh(self, params):
        _points, triangles = build_full(params)
        assert horn.estimate_triangles(params) == len(triangles)

    def test_segments_scale_count(self):
        base = horn.estimate_triangles({})
        finer = horn.estimate_triangles({"angular_segments": 128})
        assert finer > 1.8 * base
