"""Scoring metrics for horn solve runs (hornlab-style metrics.json, schema v2).

Pure numpy scoring library plus two matplotlib plot helpers. The entry point is
:func:`compute_metrics`, which loads a solve run's ``pressure_data_raw.npz`` and
a campaign spec and returns a JSON-serializable metrics dict:

- ``coverage``: per-frequency connected -6 dB beamwidth (horizontal/vertical)
  vs target, with mean/RMS deviation, within-tolerance fraction, and subscore.
- ``di_smoothness``: SPDI/ERDI second-difference RMS over the band.
- ``on_axis_ripple``: on-axis response detrended by a linear fit in log10(f).
- ``size``: bounding-box penalty against ``size_limit_mm``.
- ``score``: weighted sum of the subscores (weights normalized to 1).

Every subscore uses the same squashing ``1 / (1 + (x / scale) ** 2)`` so 1.0 is
perfect and 0.5 means "off by one scale unit" (scale = tolerance_deg for
coverage, 2.0 dB for DI smoothness, 1.0 dB for ripple).

The spec
--------

``spec`` is the campaign's own ``spec.json``, passed through unchanged — there is
no second, scorer-only document to keep in sync. Everything the scorer reads
lives under one key, ``objective`` (canonical shape, all members optional):

.. code-block:: json

    {"objective": {
       "band_hz": [1000, 8000],
       "coverage": {"horizontal_target_deg": 100, "vertical_target_deg": 40,
                    "tolerance_deg": 10},
       "weights": {"coverage": 1.0, "di_smoothness": 0.5,
                   "on_axis_ripple": 0.5, "size": 0.25},
       "size_limit_mm": {"width": 450, "height": 350, "depth": 350}}}

Weight names are exactly the subscore names, so a spec's ``weights`` and a
``metrics.json``'s ``subscores`` share one vocabulary. Human prose about the
campaign belongs in a top-level ``description`` — ``objective`` is an object.
Sibling keys (``generator``, ``mesh``, ``solve``, ``budget``, …) are ignored
here; see ``agents/horn-optimization/orchestrator.md`` for the full spec, whose
worked example is pinned to this module by ``tests/test_bridge_metrics.py``.

The objective block itself is permissive: missing targets, weights, tolerances,
or size limits fall back to defaults rather than failing, so old runs can be
re-scored with partial specs. A ``provenance`` block records solve settings and
triangle count so trials at different fidelity are never silently compared.

Unmeasurable subscores
----------------------

A subscore that cannot be measured from the data is reported as ``null`` (never
1.0 — a metric that always returns perfect is worse than no metric). Its weight
is dropped and the remaining weights renormalized, the term is listed in
``unmeasured_subscores``, and the reason is spelled out in ``warnings``. See
:func:`_on_axis_ripple`, which is unmeasurable whenever the solve emits
level-normalized on-axis SPL.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from blab.spinorama import compute_spinorama_from_planes

SCHEMA_VERSION = 2

DEFAULT_TOLERANCE_DEG = 10.0
DI_SMOOTHNESS_SCALE_DB = 2.0
# DI curvature is rescaled to this fixed log-frequency grid density so scores
# stay comparable across solves with different --count (see log_curvature_rms_db).
REFERENCE_POINTS_PER_DECADE = 32
RIPPLE_SCALE_DB = 1.0
# An on-axis cut whose in-band span is below this is level-normalized by
# construction, not a genuinely ruler-flat horn (see _on_axis_ripple).
FLAT_ON_AXIS_SPAN_DB = 1e-3
DEFAULT_WEIGHTS = {
    "coverage": 0.4,
    "di_smoothness": 0.3,
    "on_axis_ripple": 0.2,
    "size": 0.1,
}

# Flat campaign-spec keys from the pre-canonical playbook example, mapped to the
# canonical objective member they were trying to express. Used only to make the
# error message actionable when an old spec shows up.
_LEGACY_SPEC_KEYS = {
    "band_hz": 'objective.band_hz: [lo, hi] (not {"fmin": …, "fmax": …})',
    "coverage": 'objective.coverage: {"horizontal_target_deg": …, "vertical_target_deg": …, '
    '"tolerance_deg": …} (not {"h_deg": …, "v_deg": …})',
    "weights": 'objective.weights: {"coverage": …, "di_smoothness": …, "on_axis_ripple": …, '
    '"size": …} (not {"h_bw": …, "v_bw": …, "smoothness": …, "ripple": …})',
    "size_limit_mm": 'objective.size_limit_mm: {"width": …, "height": …, "depth": …} '
    '(not {"w": …, "h": …, "d": …})',
}

# Categorical series colors (CVD-safe blue/orange pair, >=3:1 on white).
_SERIES_COLORS = ("#1f77b4", "#c85200")
_GRID_KWARGS = {"which": "major", "color": "#808080", "linewidth": 0.8}


def connected_beamwidth(angle_deg: np.ndarray, response_db: np.ndarray, level: float = -6.0) -> float:
    """Width in degrees of the connected lobe around 0 deg at ``level`` dB.

    Starting from the sample closest to 0 deg, walk outward in each direction
    while the response stays at or above ``level`` and linearly interpolate the
    crossing. Detached lobes beyond the first crossing never extend the width.
    Returns NaN if the on-axis sample is already below ``level`` or if either
    side never crosses within the sampled span.
    """
    angles = np.asarray(angle_deg, dtype=float)
    response = np.asarray(response_db, dtype=float)
    if angles.ndim != 1 or angles.shape != response.shape:
        raise ValueError("angle_deg and response_db must be 1D arrays of the same length.")
    order = np.argsort(angles)
    angles = angles[order]
    response = response[order]

    center = int(np.argmin(np.abs(angles)))
    if not response[center] >= level:
        return float("nan")

    def crossing(step: int) -> float:
        index = center
        while True:
            nxt = index + step
            if nxt < 0 or nxt >= angles.size:
                return float("nan")
            if response[nxt] < level:
                x0, y0 = angles[index], response[index]
                x1, y1 = angles[nxt], response[nxt]
                return x0 + (level - y0) * (x1 - x0) / (y1 - y0)
            index = nxt

    left = crossing(-1)
    right = crossing(+1)
    return float(right - left)


def objective_of(spec: dict) -> dict:
    """Return the canonical ``objective`` block of a campaign spec.

    The campaign ``spec.json`` is passed to the scorer unchanged, so this is the
    one place where "which part of the spec is the objective" is decided. Raises
    a migration-shaped ValueError for the pre-canonical flat layout and for the
    prose-in-``objective`` mistake, because both used to fail with an error that
    did not say what to write instead.
    """
    objective = spec.get("objective")
    if isinstance(objective, dict):
        return objective

    lines = [
        'spec must contain an "objective" object. Canonical campaign-spec shape '
        "(see agents/horn-optimization/orchestrator.md):",
        '  "objective": {"band_hz": [lo, hi], '
        '"coverage": {"horizontal_target_deg": …, "vertical_target_deg": …, "tolerance_deg": …}, '
        '"weights": {"coverage": …, "di_smoothness": …, "on_axis_ripple": …, "size": …}, '
        '"size_limit_mm": {"width": …, "height": …, "depth": …}}',
    ]
    if isinstance(objective, str):
        excerpt = objective if len(objective) <= 60 else objective[:60] + "…"
        lines.append(
            f"Found a string at spec.objective ({excerpt!r}): prose describing the campaign belongs in a "
            'top-level "description" key; "objective" is the scored block.'
        )
    stale = [hint for key, hint in _LEGACY_SPEC_KEYS.items() if key in spec]
    if stale:
        lines.append("This spec uses the superseded flat layout. Move these into objective:")
        lines.extend(f"  - {hint}" for hint in stale)
    raise ValueError("\n".join(lines))


def compute_metrics(
    raw_npz_path: str | Path,
    spec: dict,
    mesh_result: dict | None = None,
    solve_result: dict | None = None,
) -> dict:
    """Score a solve run's raw NPZ against a campaign spec (metrics schema v2)."""
    objective = objective_of(spec)

    with np.load(Path(raw_npz_path)) as data:
        freq_hz = np.asarray(data["freq_hz"], dtype=float)
        polar_angle_deg = np.asarray(data["polar_angle_deg"], dtype=float)
        horizontal_spl_db = np.asarray(data["horizontal_spl_db"], dtype=float)
        vertical_spl_db = np.asarray(data["vertical_spl_db"], dtype=float)
        horizontal_norm_db = np.asarray(data["horizontal_spl_norm_db"], dtype=float)
        vertical_norm_db = np.asarray(data["vertical_spl_norm_db"], dtype=float)

    band = objective.get("band_hz")
    if band is None:
        band = [float(freq_hz.min()), float(freq_hz.max())]
    band_lo, band_hi = float(band[0]), float(band[1])
    band_mask = (freq_hz >= band_lo) & (freq_hz <= band_hi)
    if not band_mask.any():
        raise ValueError(
            f"No solved frequencies inside band_hz [{band_lo:g}, {band_hi:g}]; "
            f"solve covers {freq_hz.min():g}-{freq_hz.max():g} Hz."
        )
    if int(band_mask.sum()) < 3:
        # DI smoothness and ripple cannot be measured from fewer than 3 points;
        # scoring anyway would award unmeasured subscores. Fail loudly instead.
        raise ValueError(
            f"Only {int(band_mask.sum())} solved frequencies inside band_hz "
            f"[{band_lo:g}, {band_hi:g}]; at least 3 are required to score "
            "DI smoothness and on-axis ripple. Solve with a higher --count."
        )
    band_freqs = freq_hz[band_mask]

    coverage_spec = objective.get("coverage") or {}
    tolerance_deg = float(coverage_spec.get("tolerance_deg", DEFAULT_TOLERANCE_DEG))
    if not math.isfinite(tolerance_deg) or tolerance_deg <= 0:
        raise ValueError(f"objective.coverage.tolerance_deg must be a finite, positive number (got {tolerance_deg!r}).")
    for target_key in ("horizontal_target_deg", "vertical_target_deg"):
        target = coverage_spec.get(target_key)
        if target is not None and (not math.isfinite(float(target)) or float(target) <= 0):
            raise ValueError(f"objective.coverage.{target_key} must be a finite, positive beamwidth (got {target!r}).")
    coverage = {
        "horizontal": _coverage_axis(
            band_freqs,
            polar_angle_deg,
            horizontal_norm_db[band_mask],
            coverage_spec.get("horizontal_target_deg"),
            tolerance_deg,
        ),
        "vertical": _coverage_axis(
            band_freqs,
            polar_angle_deg,
            vertical_norm_db[band_mask],
            coverage_spec.get("vertical_target_deg"),
            tolerance_deg,
        ),
    }
    coverage_subscore = float(np.mean([coverage["horizontal"]["subscore"], coverage["vertical"]["subscore"]]))

    di_smoothness = _di_smoothness(freq_hz, polar_angle_deg, horizontal_spl_db, vertical_spl_db, band_mask)
    on_axis_ripple = _on_axis_ripple(band_freqs, polar_angle_deg, horizontal_spl_db[band_mask])
    size = _size_penalty(objective.get("size_limit_mm"), mesh_result)

    subscores = {
        "coverage": coverage_subscore,
        "di_smoothness": di_smoothness["subscore"],
        "on_axis_ripple": on_axis_ripple["subscore"],
        "size": size["subscore"],
    }
    # A subscore of None means "not measurable from this data". Such a term must
    # not be scored as 1.0, and its weight must not vanish silently either: it is
    # zeroed here, the remaining weights renormalize, and the reason is recorded.
    unmeasured = sorted(name for name, value in subscores.items() if value is None)
    warnings = [section["reason"] for section in (on_axis_ripple,) if section.get("reason")]
    weights = _normalized_weights(objective.get("weights"), unmeasured=unmeasured)
    score = float(sum(weights[name] * subscores[name] for name in weights if subscores[name] is not None))

    metrics = {
        "schema_version": SCHEMA_VERSION,
        "band_hz": [band_lo, band_hi],
        "coverage": coverage,
        "di_smoothness": di_smoothness,
        "on_axis_ripple": on_axis_ripple,
        "size": size,
        "subscores": subscores,
        "unmeasured_subscores": unmeasured,
        "weights": weights,
        "warnings": warnings,
        "score": score,
        "provenance": _provenance(mesh_result, solve_result),
    }
    return _to_plain(metrics)


def _subscore(rms: float, scale: float) -> float:
    return float(1.0 / (1.0 + (rms / scale) ** 2))


def _coverage_axis(
    band_freqs: np.ndarray,
    polar_angle_deg: np.ndarray,
    norm_spl_band: np.ndarray,
    target_deg: float | None,
    tolerance_deg: float,
) -> dict:
    beamwidths = np.asarray([connected_beamwidth(polar_angle_deg, row) for row in norm_spl_band], dtype=float)
    finite = np.isfinite(beamwidths)
    axis = {
        "target_deg": None if target_deg is None else float(target_deg),
        "tolerance_deg": float(tolerance_deg),
        "mean_dev_deg": None,
        "rms_dev_deg": None,
        "within_tolerance_fraction": None,
        "n_freqs": int(beamwidths.size),
        "n_valid": int(finite.sum()),
        "subscore": 1.0,
        "freq_hz": band_freqs,
        "beamwidth_deg": beamwidths,
    }
    if target_deg is None:
        return axis
    if not finite.any():
        # A target was requested but the -6 dB width never resolved in-band:
        # deviation is unmeasurable, treat as total coverage failure (not a free pass).
        axis["subscore"] = 0.0
        return axis
    # Frequencies whose -6 dB width never resolved are coverage failures, not
    # ignorable gaps: mean/rms describe the resolved subset, but the tolerance
    # fraction counts every in-band frequency and the subscore is scaled by the
    # resolved fraction so unresolved lobes always cost score.
    valid_fraction = float(finite.sum()) / float(beamwidths.size)
    dev = beamwidths[finite] - float(target_deg)
    rms_dev = float(np.sqrt(np.mean(dev**2)))
    axis["mean_dev_deg"] = float(np.mean(dev))
    axis["rms_dev_deg"] = rms_dev
    axis["within_tolerance_fraction"] = float(np.sum(np.abs(dev) <= tolerance_deg)) / float(beamwidths.size)
    axis["subscore"] = valid_fraction * _subscore(rms_dev, tolerance_deg)
    return axis


def log_curvature_rms_db(freq_hz: np.ndarray, curve_db: np.ndarray) -> float:
    """RMS curvature of a curve vs log10(frequency), at a reference grid spacing.

    The second derivative is estimated with non-uniform finite differences in
    log10(f) and rescaled to a fixed reference spacing of
    ``1 / REFERENCE_POINTS_PER_DECADE`` decades, so the result is expressed as a
    per-step second difference in dB and — for smooth curves — is independent of
    how densely the solve sampled the band. Requires at least 3 points.
    """
    x = np.log10(np.asarray(freq_hz, dtype=float))
    y = np.asarray(curve_db, dtype=float)
    if x.size < 3:
        raise ValueError("log_curvature_rms_db needs at least 3 frequency points.")
    h1 = x[1:-1] - x[:-2]
    h2 = x[2:] - x[1:-1]
    second_derivative = 2.0 * (h2 * y[:-2] - (h1 + h2) * y[1:-1] + h1 * y[2:]) / (h1 * h2 * (h1 + h2))
    step_ref = 1.0 / REFERENCE_POINTS_PER_DECADE
    return float(np.sqrt(np.mean((second_derivative * step_ref**2) ** 2)))


def _di_smoothness(
    freq_hz: np.ndarray,
    polar_angle_deg: np.ndarray,
    horizontal_spl_db: np.ndarray,
    vertical_spl_db: np.ndarray,
    band_mask: np.ndarray,
) -> dict:
    curves = compute_spinorama_from_planes(freq_hz, polar_angle_deg, horizontal_spl_db, vertical_spl_db)
    spdi = np.asarray(curves.sound_power_di_db, dtype=float)[band_mask]
    erdi = np.asarray(curves.early_reflections_di_db, dtype=float)[band_mask]
    band_freqs = freq_hz[band_mask]
    spdi_rms = log_curvature_rms_db(band_freqs, spdi)
    erdi_rms = log_curvature_rms_db(band_freqs, erdi)
    combined = math.sqrt((spdi_rms**2 + erdi_rms**2) / 2.0)
    return {
        "spdi_rms_d2_db": spdi_rms,
        "erdi_rms_d2_db": erdi_rms,
        "reference_points_per_decade": REFERENCE_POINTS_PER_DECADE,
        "subscore": _subscore(combined, DI_SMOOTHNESS_SCALE_DB),
        "freq_hz": band_freqs,
        "spdi_db": spdi,
        "erdi_db": erdi,
    }


def _on_axis_ripple(band_freqs: np.ndarray, polar_angle_deg: np.ndarray, horizontal_band: np.ndarray) -> dict:
    """Ripple of the 0 deg cut of ``horizontal_spl_db``, detrended in log10(f).

    ``horizontal_spl_db`` is the un-*polar*-normalized array (the companion
    ``horizontal_spl_norm_db`` is referenced to the on-axis sample, so its 0 deg
    column is identically zero and useless here). But the solve pipeline also
    applies *flat-target* normalization by default — a per-frequency drive
    correction that sets the on-axis pressure to a fixed level — and that leaves
    the 0 deg column of ``horizontal_spl_db`` constant too, i.e. flat by
    construction rather than by merit.

    There is no third, un-flat-targeted on-axis array in ``pressure_data_raw.npz``,
    so when the cut is flat to within ``FLAT_ON_AXIS_SPAN_DB`` this returns
    ``subscore: None`` with a reason instead of the free 1.0 the detrended fit
    would otherwise produce. compute_metrics then drops the term from the
    weighted score and reports it in ``unmeasured_subscores``/``warnings``.
    """
    on_axis_col = int(np.argmin(np.abs(np.asarray(polar_angle_deg, dtype=float))))
    on_axis = np.asarray(horizontal_band, dtype=float)[:, on_axis_col]
    span = float(on_axis.max() - on_axis.min())
    if not math.isfinite(span) or span <= FLAT_ON_AXIS_SPAN_DB:
        return {
            "measured": False,
            "on_axis_span_db": span,
            "peak_to_peak_db": None,
            "rms_db": None,
            "subscore": None,
            "reason": (
                f"on_axis_ripple is not measurable: the 0 deg cut of horizontal_spl_db spans {span:.2e} dB "
                f"over the band (<= {FLAT_ON_AXIS_SPAN_DB:g} dB), i.e. it is level-normalized by construction. "
                "This solve used flat-target normalization (blab.config "
                "SimulationConfig.flat_target_normalization_enabled, on by default), which EQs the on-axis "
                "response flat before the polars are written, so no on-axis ripple survives in the NPZ. "
                "The term was dropped from the weighted score (not awarded 1.0); re-solve with flat-target "
                "normalization disabled to score it, or set its weight to 0 in the spec."
            ),
        }
    log_f = np.log10(band_freqs)
    slope, intercept = np.polyfit(log_f, on_axis, 1)
    residual = on_axis - (slope * log_f + intercept)
    rms = float(np.sqrt(np.mean(residual**2)))
    return {
        "measured": True,
        "on_axis_span_db": span,
        "peak_to_peak_db": float(residual.max() - residual.min()),
        "rms_db": rms,
        "subscore": _subscore(rms, RIPPLE_SCALE_DB),
        "reason": None,
    }


def _size_penalty(size_limit_mm: dict | None, mesh_result: dict | None) -> dict:
    bbox = None if mesh_result is None else mesh_result.get("bbox_mm")
    dimensions = None
    if bbox is not None:
        dimensions = {
            "width_mm": float(bbox[0]),
            "height_mm": float(bbox[1]),
            "depth_mm": float(bbox[2]),
        }
    penalty = 0.0
    if size_limit_mm:
        limits = {}
        for key in ("width", "height", "depth"):
            limit = size_limit_mm.get(key)
            if limit is None:
                continue
            limit = float(limit)
            if not math.isfinite(limit) or limit <= 0:
                raise ValueError(f"objective.size_limit_mm.{key} must be a finite, positive number (got {limit!r}).")
            limits[key] = limit
        if limits and dimensions is None:
            # Never award a perfect size subscore just because the bbox is unknown.
            raise ValueError(
                "objective.size_limit_mm is set but the mesh bounding box is unavailable; "
                "pass --mesh-run or ensure the mesh run's result.json is discoverable from the solve config."
            )
        for key, limit in limits.items():
            penalty += max(0.0, (dimensions[f"{key}_mm"] - limit) / limit)
    return {"penalty": penalty, "subscore": float(1.0 / (1.0 + penalty)), "dimensions": dimensions}


def _normalized_weights(spec_weights: dict | None, unmeasured: list[str] | tuple[str, ...] = ()) -> dict:
    """Validate spec weights, zero the unmeasurable terms, renormalize to 1."""
    merged = dict(DEFAULT_WEIGHTS)
    for name, value in (spec_weights or {}).items():
        if name in merged:
            merged[name] = float(value)
    for name, value in merged.items():
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"objective.weights.{name} must be a finite, nonnegative number (got {value!r}).")
    requested_total = sum(merged.values())
    if requested_total <= 0:
        raise ValueError("objective.weights must sum to a positive value.")
    for name in unmeasured:
        merged[name] = 0.0
    total = sum(merged.values())
    if total <= 0:
        raise ValueError(
            "every weighted subscore is unmeasurable for this solve "
            f"({', '.join(unmeasured)}); no score can be computed. Re-weight the objective, or fix the "
            "solve settings named in the metrics warnings."
        )
    return {name: value / total for name, value in merged.items()}


def _provenance(mesh_result: dict | None, solve_result: dict | None) -> dict:
    solve_metrics = (solve_result or {}).get("metrics") or {}
    triangles = solve_metrics.get("triangles")
    if triangles is None and mesh_result is not None:
        triangles = mesh_result.get("triangles")
    return {
        "solve_settings": {
            "freq_min_hz": solve_metrics.get("freq_min_hz"),
            "freq_max_hz": solve_metrics.get("freq_max_hz"),
            "n_freqs": solve_metrics.get("n_freqs"),
            "backend": solve_metrics.get("backend"),
            "symmetry": solve_metrics.get("symmetry"),
        },
        "triangles": None if triangles is None else int(triangles),
    }


def _to_plain(value):
    """Recursively convert numpy types to plain python; NaN/inf become None."""
    if isinstance(value, dict):
        return {key: _to_plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_plain(item) for item in value]
    if isinstance(value, np.ndarray):
        return [_to_plain(item) for item in value.tolist()]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        value = float(value)
        return value if math.isfinite(value) else None
    return value


# --- plot helpers ---------------------------------------------------------


def _plot_series(metrics_section: dict, key: str) -> tuple[np.ndarray, np.ndarray]:
    freqs = np.asarray([np.nan if f is None else f for f in metrics_section["freq_hz"]], dtype=float)
    values = np.asarray([np.nan if v is None else v for v in metrics_section[key]], dtype=float)
    return freqs, values


def _new_axes():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(9, 5), dpi=160)
    fig.patch.set_facecolor("white")
    return plt, fig, ax


def plot_beamwidth_vs_freq(metrics: dict, out_png: str | Path) -> str:
    """Plot H/V connected -6 dB beamwidth vs frequency with target/tolerance bands."""
    plt, fig, ax = _new_axes()
    for (axis_name, label), color in zip((("horizontal", "Horizontal"), ("vertical", "Vertical")), _SERIES_COLORS):
        section = metrics["coverage"][axis_name]
        freqs, widths = _plot_series(section, "beamwidth_deg")
        ax.plot(freqs, widths, color=color, linewidth=2.0, marker="o", markersize=4, label=label)
        target = section.get("target_deg")
        if target is not None:
            tolerance = section.get("tolerance_deg") or DEFAULT_TOLERANCE_DEG
            ax.axhline(target, color=color, linestyle="--", linewidth=1.0)
            ax.axhspan(target - tolerance, target + tolerance, color=color, alpha=0.08, linewidth=0)
    ax.set_xscale("log")
    ax.set_xlabel("Frequency (Hz)")
    ax.set_ylabel("-6 dB beamwidth (deg)")
    ax.set_title("Connected -6 dB beamwidth vs frequency")
    ax.grid(**_GRID_KWARGS)
    ax.legend()
    fig.tight_layout()
    out_png = Path(out_png)
    fig.savefig(out_png, facecolor="white")
    plt.close(fig)
    return str(out_png)


def plot_di_curves(metrics: dict, out_png: str | Path) -> str:
    """Plot in-band SPDI/ERDI curves with the scoring band edges marked."""
    plt, fig, ax = _new_axes()
    section = metrics["di_smoothness"]
    for (key, label), color in zip((("spdi_db", "SPDI"), ("erdi_db", "ERDI")), _SERIES_COLORS):
        freqs, values = _plot_series(section, key)
        ax.plot(freqs, values, color=color, linewidth=2.0, marker="o", markersize=4, label=label)
    for edge in metrics["band_hz"]:
        ax.axvline(edge, color="#808080", linestyle="--", linewidth=1.0)
    ax.set_xscale("log")
    ax.set_xlabel("Frequency (Hz)")
    ax.set_ylabel("Directivity index (dB)")
    ax.set_title("Sound power / early reflections DI")
    ax.grid(**_GRID_KWARGS)
    ax.legend()
    fig.tight_layout()
    out_png = Path(out_png)
    fig.savefig(out_png, facecolor="white")
    plt.close(fig)
    return str(out_png)
