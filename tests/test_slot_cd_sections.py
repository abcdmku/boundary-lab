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

    def test_mouth_outline_must_contain_slot_outline(self):
        # Codex review case: mouth dims equal the slot, but a low superellipse
        # exponent rounds the mouth corners inside the slot's arc.
        with pytest.raises(ValueError, match="mouth outline does not contain the slot outline"):
            horn.build_quadrant({"mouth_width": 20, "mouth_height": 160, "mouth_superellipse_n": 2})
        # A slightly larger squarer mouth contains the slot and builds fine.
        horn.build_quadrant({"mouth_width": 40, "mouth_height": 180, "mouth_superellipse_n": 8})

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


# ---------------------------------------------------------------------------
# Outer bounding-box estimate
#
# mouth_width/mouth_height are the AIR aperture; the shell's rolled mouth lip
# adds material on every side. A campaign trial was rejected by the size gate
# because the designer budgeted 380 mm of mouth against a 450 mm limit and got a
# 470 mm shell, so the relationship is pinned here (and documented in the schema
# and in agents/horn-optimization/designer.md).
# ---------------------------------------------------------------------------


def built_bbox(params: dict) -> list[float]:
    """[x, y, z] span of the mirrored mesh — what generators.mesh_stats reports."""
    points, _triangles = build_full(params)
    span = points.max(axis=0) - points.min(axis=0)
    return [float(v) for v in span]


class TestBboxEstimate:
    @pytest.mark.parametrize(
        "params",
        [
            {},
            {"plug": False},
            {"mouth_roundover": 0},
            {"roundover_sweep_deg": 30, "mouth_roundover": 30},
            {"roundover_sweep_deg": 180, "mouth_roundover": 30},
            {"pinch": 0.4, "flare_exp": 1.6, "mouth_superellipse_n": 6},
            {"back": "enclosure"},
            {"back": "enclosure", "enclosure_depth": 40},
            {"wall_angle_deg": 30, "plug_angle_deg": 30, "slot_length": 80, "plug_tip_length": 18},
        ],
    )
    def test_estimate_matches_built_mesh(self, params):
        assert horn.estimate_bbox_mm(params) == pytest.approx(built_bbox(params), abs=1e-6)

    @pytest.mark.parametrize("sweep", [30.0, 45.0, 89.0, 90.0, 95.0, 100.0, 110.0, 120.0, 150.0, 179.0, 180.0])
    @pytest.mark.parametrize("segments", [2, 3, 4, 5, 7])
    def test_lip_depth_follows_the_sampled_arc(self, sweep, segments):
        # The rolled lip is a sampled arc: past 90 deg it only reaches the full
        # mouth_roundover when 90 deg happens to be one of the stations (sweep 120
        # with 4 segments does; sweep 100 with 4 segments stops 1.5% short).
        # Assuming the continuous maximum overstated depth by up to ~1.3 mm and
        # could reject a valid near-limit proposal.
        params = {"roundover_sweep_deg": sweep, "roundover_segments": segments, "mouth_roundover": 30}
        assert horn.estimate_bbox_mm(params)[2] == pytest.approx(built_bbox(params)[2], abs=1e-6)

    def test_lip_depth_is_short_of_the_radius_when_90_deg_is_not_sampled(self):
        # Stations 0/25/50/75/100 deg: the deepest is the one nearest 90, here 100
        # (sin 100 deg > sin 75 deg), so the lip stops 1.5% short of the radius.
        stations = {"roundover_sweep_deg": 100.0, "roundover_segments": 4, "mouth_roundover": 30}
        assert horn.mouth_lip_depth_mm(stations) == pytest.approx(30.0 * np.sin(np.radians(100.0)))
        assert horn.mouth_lip_depth_mm(stations) < 30.0
        # A sweep that does sample 90 deg reaches the full radius.
        sampled = {"roundover_sweep_deg": 120.0, "roundover_segments": 4, "mouth_roundover": 30}
        assert horn.mouth_lip_depth_mm(sampled) == pytest.approx(30.0)
        # Worst case in the schema's legal range: 110 deg over 3 segments samples
        # 0/36.7/73.3/110, straddling 90 without hitting it. Here the winner is
        # 73.3 deg, not the endpoint — so take the max over the stations rather
        # than assuming which one is deepest.
        worst = {"roundover_sweep_deg": 110.0, "roundover_segments": 3, "mouth_roundover": 30}
        assert horn.mouth_lip_depth_mm(worst) == pytest.approx(30.0 * np.sin(np.radians(110.0 * 2 / 3)))
        assert 30.0 - horn.mouth_lip_depth_mm(worst) == pytest.approx(1.26, abs=0.01)

    def test_lip_depth_is_plain_sine_up_to_quarter_round(self):
        for sweep in (30.0, 60.0, 90.0):
            params = {"roundover_sweep_deg": sweep, "roundover_segments": 4, "mouth_roundover": 30}
            assert horn.mouth_lip_depth_mm(params) == pytest.approx(30.0 * np.sin(np.radians(sweep)))

    def test_margin_is_unaffected_by_arc_sampling(self):
        # 1 - cos increases monotonically, so the outermost station is always the
        # last one, which the loft samples exactly whatever roundover_segments is.
        base = horn.mouth_to_outer_margin_mm({"roundover_sweep_deg": 100.0, "mouth_roundover": 30})
        for segments in (2, 3, 5, 9):
            params = {"roundover_sweep_deg": 100.0, "roundover_segments": segments, "mouth_roundover": 30}
            assert horn.mouth_to_outer_margin_mm(params) == pytest.approx(base)
            assert horn.estimate_bbox_mm(params)[0] == pytest.approx(built_bbox(params)[0], abs=1e-6)

    def test_rejected_campaign_trial_is_predicted_exactly(self):
        # runs/campaigns/smoke02 trial 3: generated 470.0 x 320.0 x 218.1 mm and
        # was rejected against a 450 mm width limit.
        params = {
            "throat_diameter": 36,
            "wall_angle_deg": 30,
            "slot_width": 20,
            "slot_length": 80,
            "plug_angle_deg": 30,
            "plug_tip_length": 18,
            "mouth_width": 380,
            "mouth_height": 230,
            "flare_depth": 150,
            "mouth_roundover": 30,
            "roundover_sweep_deg": 120,
            "wall_thickness": 6,
        }
        assert horn.estimate_bbox_mm(params) == pytest.approx([470.0, 320.0, 218.105], abs=1e-3)

    def test_margin_is_roundover_at_quarter_round(self):
        params = {"mouth_roundover": 25, "roundover_sweep_deg": 90, "wall_thickness": 6}
        assert horn.mouth_to_outer_margin_mm(params) == pytest.approx(25.0)

    def test_margin_is_twice_roundover_at_full_rollback(self):
        params = {"mouth_roundover": 25, "roundover_sweep_deg": 180, "wall_thickness": 6}
        assert horn.mouth_to_outer_margin_mm(params) == pytest.approx(50.0)

    def test_margin_is_wall_thickness_without_roundover(self):
        assert horn.mouth_to_outer_margin_mm({"mouth_roundover": 0, "wall_thickness": 6}) == pytest.approx(6.0)

    def test_margin_never_below_wall_thickness(self):
        for sweep in (30.0, 60.0, 90.0, 135.0, 180.0):
            margin = horn.mouth_to_outer_margin_mm({"mouth_roundover": 8, "roundover_sweep_deg": sweep})
            assert margin >= 6.0  # default wall_thickness

    def test_enclosure_margin_used_for_box_back(self):
        assert horn.mouth_to_outer_margin_mm({"back": "enclosure", "enclosure_margin": 30}) == pytest.approx(30.0)

    def test_invalid_params_raise_before_meshing(self):
        with pytest.raises(ValueError, match="slot_length must exceed throat_diameter"):
            horn.estimate_bbox_mm({"slot_length": 40, "throat_diameter": 60})
