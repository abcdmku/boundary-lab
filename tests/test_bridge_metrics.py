"""Tests for bridge/py/metrics.py (scoring library, no GPU required)."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.append(str(Path(__file__).resolve().parents[1] / "bridge" / "py"))

import metrics  # noqa: E402

ANGLES = np.arange(-180.0, 181.0, 5.0)


def tent(width_deg: float, angles: np.ndarray = ANGLES) -> np.ndarray:
    """Piecewise-linear polar response crossing -6 dB at exactly +/- width/2."""
    return -(12.0 / width_deg) * np.abs(angles)


def write_npz(
    tmp_path: Path,
    freq_hz,
    h_norm,
    v_norm=None,
    h_raw=None,
    v_raw=None,
    angles: np.ndarray = ANGLES,
) -> Path:
    """Write a synthetic NPZ with the exact key set blabctl's cmd_solve produces."""
    freq_hz = np.asarray(freq_hz, dtype=np.float32)
    h_norm = np.asarray(h_norm, dtype=np.float32)
    v_norm = h_norm if v_norm is None else np.asarray(v_norm, dtype=np.float32)
    h_raw = h_norm + 90.0 if h_raw is None else np.asarray(h_raw, dtype=np.float32)
    v_raw = v_norm + 90.0 if v_raw is None else np.asarray(v_raw, dtype=np.float32)
    tmp_path.mkdir(parents=True, exist_ok=True)
    path = tmp_path / "pressure_data_raw.npz"
    np.savez_compressed(
        path,
        freq_hz=freq_hz,
        polar_angle_deg=np.asarray(angles, dtype=np.float32),
        horizontal_spl_db=h_raw,
        vertical_spl_db=v_raw,
        horizontal_spl_norm_db=h_norm,
        vertical_spl_norm_db=v_norm,
        impedance_freq_hz=freq_hz,
        impedance_radiator_names=np.asarray(["throat"]),
        impedance_real=np.ones((1, freq_hz.size), dtype=np.float32),
        impedance_imag=np.zeros((1, freq_hz.size), dtype=np.float32),
        observation_axial_offset_m=np.float32(2.0),
    )
    return path


def make_spec(
    band_hz=(500.0, 8000.0),
    horizontal_target_deg=None,
    vertical_target_deg=None,
    tolerance_deg=None,
    weights=None,
    size_limit_mm=None,
) -> dict:
    coverage = {}
    if horizontal_target_deg is not None:
        coverage["horizontal_target_deg"] = horizontal_target_deg
    if vertical_target_deg is not None:
        coverage["vertical_target_deg"] = vertical_target_deg
    if tolerance_deg is not None:
        coverage["tolerance_deg"] = tolerance_deg
    objective = {"band_hz": list(band_hz)}
    if coverage:
        objective["coverage"] = coverage
    if weights is not None:
        objective["weights"] = weights
    if size_limit_mm is not None:
        objective["size_limit_mm"] = size_limit_mm
    return {"objective": objective}


# --- connected_beamwidth --------------------------------------------------


def test_beamwidth_symmetric_tent_interpolates_between_samples():
    angles = np.arange(-20.0, 21.0, 5.0)
    response = -0.8 * np.abs(angles)  # -6 dB at +/-7.5, between the 5 and 10 deg samples
    assert metrics.connected_beamwidth(angles, response) == pytest.approx(15.0)


def test_beamwidth_asymmetric():
    angles = np.arange(-30.0, 31.0, 5.0)
    response = np.where(angles >= 0, -0.8 * angles, 0.4 * angles)  # +7.5 right, -15 left
    assert metrics.connected_beamwidth(angles, response) == pytest.approx(22.5)


def test_beamwidth_never_crossing_is_nan():
    angles = np.arange(-30.0, 31.0, 5.0)
    assert math.isnan(metrics.connected_beamwidth(angles, np.zeros_like(angles)))


def test_beamwidth_one_side_never_crossing_is_nan():
    angles = np.arange(-30.0, 31.0, 5.0)
    response = np.where(angles >= 0, -0.8 * angles, 0.0)
    assert math.isnan(metrics.connected_beamwidth(angles, response))


def test_beamwidth_on_axis_below_level_is_nan():
    angles = np.arange(-30.0, 31.0, 5.0)
    assert math.isnan(metrics.connected_beamwidth(angles, np.full_like(angles, -20.0)))


def test_beamwidth_detached_island_does_not_extend_width():
    angles = np.arange(-60.0, 61.0, 5.0)
    response = -0.8 * np.abs(angles)  # main lobe crosses at +/-7.5
    island = (np.abs(angles) >= 40.0) & (np.abs(angles) <= 50.0)
    response[island] = 0.0  # side lobe back above -6 dB
    assert metrics.connected_beamwidth(angles, response) == pytest.approx(15.0)


def test_beamwidth_unsorted_angles():
    angles = np.arange(-20.0, 21.0, 5.0)
    response = -0.8 * np.abs(angles)
    order = np.random.default_rng(0).permutation(angles.size)
    assert metrics.connected_beamwidth(angles[order], response[order]) == pytest.approx(15.0)


# --- compute_metrics: coverage --------------------------------------------


def test_coverage_stats_match_analytic_tents(tmp_path):
    freqs = [1000.0, 2000.0, 4000.0]
    widths = [100.0, 90.0, 80.0]
    h_norm = np.vstack([tent(w) for w in widths])
    npz = write_npz(tmp_path, freqs, h_norm)
    spec = make_spec(horizontal_target_deg=90.0, vertical_target_deg=90.0, tolerance_deg=10.0)
    result = metrics.compute_metrics(npz, spec)

    horizontal = result["coverage"]["horizontal"]
    assert horizontal["beamwidth_deg"] == pytest.approx(widths, rel=1e-4)
    assert horizontal["mean_dev_deg"] == pytest.approx(0.0, abs=1e-3)
    rms = math.sqrt((10.0**2 + 0.0 + 10.0**2) / 3.0)
    assert horizontal["rms_dev_deg"] == pytest.approx(rms, rel=1e-3)
    assert horizontal["within_tolerance_fraction"] == pytest.approx(1.0)
    assert horizontal["subscore"] == pytest.approx(1.0 / (1.0 + (rms / 10.0) ** 2), rel=1e-3)
    # v_norm defaults to h_norm, so the combined coverage subscore is the same mean
    assert result["subscores"]["coverage"] == pytest.approx(horizontal["subscore"], rel=1e-6)


def test_coverage_exact_target_scores_one(tmp_path):
    freqs = [1000.0, 2000.0, 4000.0]
    npz = write_npz(tmp_path, freqs, np.vstack([tent(90.0)] * 3))
    result = metrics.compute_metrics(npz, make_spec(horizontal_target_deg=90.0, vertical_target_deg=90.0))
    assert result["subscores"]["coverage"] == pytest.approx(1.0, abs=1e-4)


def test_coverage_without_target_is_permissive(tmp_path):
    npz = write_npz(tmp_path, [1000.0, 2000.0, 4000.0], np.vstack([tent(90.0)] * 3))
    result = metrics.compute_metrics(npz, make_spec())
    horizontal = result["coverage"]["horizontal"]
    assert horizontal["target_deg"] is None
    assert horizontal["mean_dev_deg"] is None
    assert horizontal["subscore"] == 1.0
    assert len(horizontal["beamwidth_deg"]) == 3


def test_coverage_target_with_no_valid_beamwidth_fails(tmp_path):
    # Response never drops below -6 dB: beamwidth unmeasurable everywhere in band.
    npz = write_npz(tmp_path, [1000.0, 2000.0, 4000.0], np.zeros((3, ANGLES.size)))
    result = metrics.compute_metrics(npz, make_spec(horizontal_target_deg=90.0))
    horizontal = result["coverage"]["horizontal"]
    assert horizontal["n_valid"] == 0
    assert horizontal["subscore"] == 0.0
    assert horizontal["rms_dev_deg"] is None
    assert all(width is None for width in horizontal["beamwidth_deg"])


def test_coverage_partially_unresolved_beamwidths_cost_score(tmp_path):
    # One of three in-band frequencies never crosses -6 dB: stats cover the
    # resolved subset, but the subscore is scaled by the resolved fraction and
    # within_tolerance_fraction counts all in-band frequencies.
    h_norm = np.vstack([tent(90.0), tent(90.0), np.zeros(ANGLES.size)])
    npz = write_npz(tmp_path, [1000.0, 2000.0, 4000.0], h_norm)
    horizontal = metrics.compute_metrics(npz, make_spec(horizontal_target_deg=90.0))["coverage"]["horizontal"]
    assert horizontal["n_valid"] == 2
    assert horizontal["rms_dev_deg"] == pytest.approx(0.0, abs=1e-3)
    assert horizontal["within_tolerance_fraction"] == pytest.approx(2.0 / 3.0)
    assert horizontal["subscore"] == pytest.approx(2.0 / 3.0, rel=1e-4)


def test_beamwidth_arrays_match_in_band_freqs(tmp_path):
    freqs = [500.0, 1000.0, 2000.0, 4000.0, 8000.0]
    npz = write_npz(tmp_path, freqs, np.vstack([tent(90.0)] * 5))
    result = metrics.compute_metrics(npz, make_spec(band_hz=(900.0, 4100.0)))
    for axis in ("horizontal", "vertical"):
        section = result["coverage"][axis]
        assert section["freq_hz"] == pytest.approx([1000.0, 2000.0, 4000.0])
        assert len(section["beamwidth_deg"]) == 3
    assert result["di_smoothness"]["freq_hz"] == pytest.approx([1000.0, 2000.0, 4000.0])


def test_empty_band_raises(tmp_path):
    npz = write_npz(tmp_path, [1000.0], tent(90.0)[np.newaxis, :])
    with pytest.raises(ValueError, match="band_hz"):
        metrics.compute_metrics(npz, make_spec(band_hz=(10.0, 20.0)))


# --- compute_metrics: DI smoothness ---------------------------------------


def test_flat_di_scores_one(tmp_path):
    freqs = [1000.0, 2000.0, 4000.0, 8000.0]
    h_norm = np.vstack([tent(90.0)] * 4)
    npz = write_npz(tmp_path, freqs, h_norm)
    result = metrics.compute_metrics(npz, make_spec())
    di = result["di_smoothness"]
    assert di["spdi_rms_d2_db"] == pytest.approx(0.0, abs=1e-3)
    assert di["erdi_rms_d2_db"] == pytest.approx(0.0, abs=1e-3)
    assert di["subscore"] == pytest.approx(1.0, abs=1e-4)
    assert len(di["spdi_db"]) == 4
    assert len(di["erdi_db"]) == 4


def test_alternating_directivity_lowers_di_subscore(tmp_path):
    freqs = [1000.0, 2000.0, 4000.0, 8000.0]
    smooth = np.vstack([tent(w) for w in (120.0, 100.0, 80.0, 60.0)])
    zigzag = np.vstack([tent(60.0 if i % 2 else 120.0) for i in range(4)])
    smooth_di = metrics.compute_metrics(write_npz(tmp_path / "a", freqs, smooth), make_spec())["di_smoothness"]
    zigzag_di = metrics.compute_metrics(write_npz(tmp_path / "b", freqs, zigzag), make_spec())["di_smoothness"]
    assert zigzag_di["spdi_rms_d2_db"] > 2.0 * smooth_di["spdi_rms_d2_db"]
    assert zigzag_di["subscore"] < smooth_di["subscore"]


def test_log_curvature_rms_is_grid_density_invariant():
    # Quadratic in log10(f) has constant curvature; the non-uniform second
    # derivative recovers it exactly, so density must not change the result.
    curvature = 6.0  # dB / decade^2

    def sample(n):
        freqs = np.logspace(3.0, 4.0, n)
        y = 0.5 * curvature * (np.log10(freqs) - 3.0) ** 2
        return metrics.log_curvature_rms_db(freqs, y)

    expected = curvature / metrics.REFERENCE_POINTS_PER_DECADE**2
    assert sample(4) == pytest.approx(expected, rel=1e-9)
    assert sample(9) == pytest.approx(expected, rel=1e-9)
    assert sample(33) == pytest.approx(expected, rel=1e-9)


def test_log_curvature_rms_needs_three_points():
    with pytest.raises(ValueError, match="3"):
        metrics.log_curvature_rms_db(np.asarray([1000.0, 2000.0]), np.asarray([0.0, 1.0]))


def test_di_needs_three_freqs(tmp_path):
    npz = write_npz(tmp_path, [1000.0, 2000.0], np.vstack([tent(90.0)] * 2))
    result = metrics.compute_metrics(npz, make_spec())
    di = result["di_smoothness"]
    assert di["spdi_rms_d2_db"] is None
    assert di["subscore"] == 1.0


# --- compute_metrics: on-axis ripple --------------------------------------


def test_ripple_removes_linear_trend_in_log_f(tmp_path):
    freqs = [1000.0, 2000.0, 4000.0, 8000.0]
    h_norm = np.vstack([tent(90.0)] * 4)
    trend = 3.0 + 5.0 * np.log10(freqs)
    h_raw = h_norm + trend[:, np.newaxis]
    npz = write_npz(tmp_path, freqs, h_norm, h_raw=h_raw)
    result = metrics.compute_metrics(npz, make_spec())
    ripple = result["on_axis_ripple"]
    assert ripple["peak_to_peak_db"] == pytest.approx(0.0, abs=1e-3)
    assert ripple["rms_db"] == pytest.approx(0.0, abs=1e-3)
    assert ripple["subscore"] == pytest.approx(1.0, abs=1e-4)


def test_ripple_orthogonal_residual_measured_exactly(tmp_path):
    # freqs equally spaced in log10; [d, -d, -d, d] is orthogonal to {1, log f},
    # so the detrended residual is exactly that vector: rms = d, p-p = 2d.
    freqs = [1000.0, 2000.0, 4000.0, 8000.0]
    d = 1.5
    residual = np.asarray([d, -d, -d, d])
    h_norm = np.vstack([tent(90.0)] * 4)
    trend = 3.0 + 5.0 * np.log10(freqs)
    h_raw = h_norm + (trend + residual)[:, np.newaxis]
    npz = write_npz(tmp_path, freqs, h_norm, h_raw=h_raw)
    result = metrics.compute_metrics(npz, make_spec())
    ripple = result["on_axis_ripple"]
    assert ripple["rms_db"] == pytest.approx(d, rel=1e-3)
    assert ripple["peak_to_peak_db"] == pytest.approx(2 * d, rel=1e-3)
    assert ripple["subscore"] == pytest.approx(1.0 / (1.0 + d**2), rel=1e-3)


def test_ripple_needs_three_freqs(tmp_path):
    npz = write_npz(tmp_path, [1000.0, 2000.0], np.vstack([tent(90.0)] * 2))
    ripple = metrics.compute_metrics(npz, make_spec())["on_axis_ripple"]
    assert ripple["rms_db"] is None
    assert ripple["subscore"] == 1.0


# --- compute_metrics: size ------------------------------------------------


def _simple_npz(tmp_path):
    return write_npz(tmp_path, [1000.0, 2000.0, 4000.0], np.vstack([tent(90.0)] * 3))


def test_size_inside_limits_scores_one(tmp_path):
    npz = _simple_npz(tmp_path)
    mesh_result = {"bbox_mm": [200.0, 150.0, 100.0], "triangles": 5000}
    spec = make_spec(size_limit_mm={"width": 250.0, "height": 200.0, "depth": 150.0})
    size = metrics.compute_metrics(npz, spec, mesh_result=mesh_result)["size"]
    assert size["penalty"] == 0.0
    assert size["subscore"] == 1.0
    assert size["dimensions"] == {"width_mm": 200.0, "height_mm": 150.0, "depth_mm": 100.0}


def test_size_ten_percent_over_one_axis(tmp_path):
    npz = _simple_npz(tmp_path)
    mesh_result = {"bbox_mm": [110.0, 100.0, 100.0], "triangles": 5000}
    spec = make_spec(size_limit_mm={"width": 100.0, "height": 200.0, "depth": 200.0})
    size = metrics.compute_metrics(npz, spec, mesh_result=mesh_result)["size"]
    assert size["penalty"] == pytest.approx(0.1)
    assert size["subscore"] == pytest.approx(1.0 / 1.1)


def test_size_without_limits_or_mesh_is_permissive(tmp_path):
    npz = _simple_npz(tmp_path)
    size = metrics.compute_metrics(npz, make_spec())["size"]
    assert size["penalty"] == 0.0
    assert size["subscore"] == 1.0
    assert size["dimensions"] is None


# --- weights and score ----------------------------------------------------


def test_weights_are_normalized(tmp_path):
    npz = _simple_npz(tmp_path)
    default = metrics.compute_metrics(npz, make_spec(horizontal_target_deg=70.0))
    scaled = metrics.compute_metrics(
        npz,
        make_spec(
            horizontal_target_deg=70.0,
            weights={"coverage": 4.0, "di_smoothness": 3.0, "on_axis_ripple": 2.0, "size": 1.0},
        ),
    )
    assert scaled["score"] == pytest.approx(default["score"], rel=1e-9)
    assert sum(scaled["weights"].values()) == pytest.approx(1.0)


def test_single_weight_selects_subscore(tmp_path):
    npz = _simple_npz(tmp_path)
    spec = make_spec(
        horizontal_target_deg=70.0,
        weights={"coverage": 1.0, "di_smoothness": 0.0, "on_axis_ripple": 0.0, "size": 0.0},
    )
    result = metrics.compute_metrics(npz, spec)
    assert result["score"] == pytest.approx(result["subscores"]["coverage"], rel=1e-9)


def test_negative_weight_rejected(tmp_path):
    npz = _simple_npz(tmp_path)
    spec = make_spec(weights={"coverage": -0.5, "di_smoothness": 2.0})
    with pytest.raises(ValueError, match="nonnegative"):
        metrics.compute_metrics(npz, spec)


def test_non_finite_weight_rejected(tmp_path):
    npz = _simple_npz(tmp_path)
    with pytest.raises(ValueError, match="finite"):
        metrics.compute_metrics(npz, make_spec(weights={"coverage": float("nan")}))


def test_unknown_weight_keys_ignored(tmp_path):
    npz = _simple_npz(tmp_path)
    spec = make_spec(weights={"edge_match": 100.0})
    result = metrics.compute_metrics(npz, spec)
    assert set(result["weights"]) == {"coverage", "di_smoothness", "on_axis_ripple", "size"}
    assert sum(result["weights"].values()) == pytest.approx(1.0)


# --- permissiveness and serialization -------------------------------------


def test_minimal_spec_runs_and_serializes(tmp_path):
    npz = _simple_npz(tmp_path)
    result = metrics.compute_metrics(npz, {"objective": {}})
    assert result["schema_version"] == 2
    # allow_nan=False proves the sanitizer replaced every NaN with null
    round_tripped = json.loads(json.dumps(result, allow_nan=False))
    assert round_tripped["score"] == pytest.approx(result["score"])


def test_spec_without_objective_raises(tmp_path):
    npz = _simple_npz(tmp_path)
    with pytest.raises(ValueError, match="objective"):
        metrics.compute_metrics(npz, {})


def test_provenance_prefers_solve_metrics(tmp_path):
    npz = _simple_npz(tmp_path)
    solve_result = {
        "metrics": {
            "triangles": 2228,
            "n_freqs": 3,
            "backend": "beat_cuda",
            "symmetry": "off",
            "freq_min_hz": 500.0,
            "freq_max_hz": 5000.0,
        }
    }
    mesh_result = {"bbox_mm": [100.0, 100.0, 100.0], "triangles": 9999}
    result = metrics.compute_metrics(npz, make_spec(), mesh_result=mesh_result, solve_result=solve_result)
    provenance = result["provenance"]
    assert provenance["triangles"] == 2228
    assert provenance["solve_settings"]["backend"] == "beat_cuda"
    assert provenance["solve_settings"]["n_freqs"] == 3


def test_provenance_falls_back_to_mesh_triangles(tmp_path):
    npz = _simple_npz(tmp_path)
    result = metrics.compute_metrics(npz, make_spec(), mesh_result={"bbox_mm": [1, 1, 1], "triangles": 4321})
    assert result["provenance"]["triangles"] == 4321
    assert result["provenance"]["solve_settings"]["backend"] is None


# --- plot helpers ---------------------------------------------------------


def test_plot_helpers_write_pngs(tmp_path):
    npz = write_npz(
        tmp_path,
        [1000.0, 2000.0, 4000.0],
        np.vstack([tent(w) for w in (100.0, 90.0, 80.0)]),
    )
    result = metrics.compute_metrics(npz, make_spec(horizontal_target_deg=90.0, vertical_target_deg=60.0))
    beamwidth_png = tmp_path / "beamwidth_vs_freq.png"
    di_png = tmp_path / "di_curves.png"
    metrics.plot_beamwidth_vs_freq(result, beamwidth_png)
    metrics.plot_di_curves(result, di_png)
    assert beamwidth_png.stat().st_size > 0
    assert di_png.stat().st_size > 0
