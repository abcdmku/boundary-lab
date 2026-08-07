"""Tests for bridge/py/vram.py — the solve-time VRAM estimate and warning.

The point of this module is that it WARNS and never refuses, so most of these
tests assert that a wildly oversized mesh still produces a report rather than an
exception.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.append(str(Path(__file__).resolve().parents[1] / "bridge" / "py"))

import vram  # noqa: E402

GIB = 1024**3


# --- pure estimator -------------------------------------------------------


def test_estimate_matches_the_hand_derived_formula():
    """8 bytes/ComplexF32 * (2*V*F + 4*V*V), plus O(N) aux, times overhead."""
    vertices, triangles = 4_000, 8_000
    dense = 8 * (2 * vertices * triangles + 4 * vertices * vertices)
    aux = vram.AUX_BYTES_PER_TRIANGLE * triangles
    expected = round(vram.DEFAULT_OVERHEAD * (dense + aux))
    assert vram.estimate_solve_vram_bytes(triangles=triangles, vertices=vertices) == expected


def test_estimate_falls_back_to_two_triangles_per_vertex():
    triangles = 10_000
    assert vram.vertices_from_triangles(triangles) == 5_000
    assert vram.estimate_solve_vram_bytes(triangles=triangles) == vram.estimate_solve_vram_bytes(
        triangles=triangles, vertices=5_000
    )


def test_estimate_scales_quadratically():
    small = vram.estimate_solve_vram_bytes(triangles=10_000, vertices=5_000)
    double = vram.estimate_solve_vram_bytes(triangles=20_000, vertices=10_000)
    # Dense terms are exactly 4x; the linear aux term drags the ratio a hair low.
    assert 3.9 < double / small < 4.05


@pytest.mark.parametrize(
    ("nodes", "low_gib", "high_gib"),
    [
        # The README's measured table is indexed by node count. Our model adds
        # the LU copy it omits, so it should sit at or just above each band.
        (5_000, 1.0, 2.2),
        (10_000, 4.0, 8.0),
        (15_000, 8.0, 18.0),
        (20_000, 14.0, 30.0),
    ],
)
def test_estimate_is_in_the_right_ballpark_versus_measured_table(nodes, low_gib, high_gib):
    estimate = vram.estimate_solve_vram_bytes(triangles=2 * nodes, vertices=nodes)
    assert low_gib * GIB <= estimate <= high_gib * GIB


def test_estimate_rejects_nonsense_counts():
    with pytest.raises(ValueError):
        vram.estimate_solve_vram_bytes(triangles=0)
    with pytest.raises(ValueError):
        vram.estimate_solve_vram_bytes(triangles=100, vertices=-3)


def test_format_bytes():
    assert vram.format_bytes(None) == "unknown"
    assert vram.format_bytes(2 * GIB) == "2.00 GiB"
    assert vram.format_bytes(512 * 1024**2) == "512 MiB"


# --- backend classification ----------------------------------------------


@pytest.mark.parametrize("backend", ["beat_cuda", "beat_rocm"])
def test_local_gpu_backends(backend):
    assert vram.is_local_gpu_backend(backend)


@pytest.mark.parametrize("backend", ["server", "beat_cpu", "local", "", None, "unknown_thing"])
def test_non_local_gpu_backends(backend):
    assert not vram.is_local_gpu_backend(backend)


def test_local_gpu_ids_match_the_solver_registry():
    """Guard against the registry renaming a backend out from under us."""
    from blab.solvers.registry import normalize_backend_id

    assert normalize_backend_id("julia_local") in vram.LOCAL_GPU_BACKENDS
    assert normalize_backend_id("cuda") in vram.LOCAL_GPU_BACKENDS
    assert normalize_backend_id("beat_cpu") not in vram.LOCAL_GPU_BACKENDS
    assert normalize_backend_id("server") not in vram.LOCAL_GPU_BACKENDS


# --- detection ------------------------------------------------------------


def test_detect_gpu_memory_returns_none_without_nvidia_smi(monkeypatch):
    monkeypatch.setattr(vram.shutil, "which", lambda _name: None)
    assert vram.detect_gpu_memory() is None


def test_detect_gpu_memory_parses_nvidia_smi(monkeypatch):
    monkeypatch.setattr(vram.shutil, "which", lambda _name: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(
        vram.subprocess,
        "run",
        lambda *_a, **_k: subprocess.CompletedProcess(
            args=[], returncode=0, stdout="NVIDIA GeForce RTX 5080, 16303, 11530\n", stderr=""
        ),
    )
    gpu = vram.detect_gpu_memory()
    assert gpu == {
        "name": "NVIDIA GeForce RTX 5080",
        "total_bytes": 16303 * 1024**2,
        "free_bytes": 11530 * 1024**2,
    }


def test_detect_gpu_memory_survives_a_broken_nvidia_smi(monkeypatch):
    monkeypatch.setattr(vram.shutil, "which", lambda _name: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(
        vram.subprocess,
        "run",
        lambda *_a, **_k: subprocess.CompletedProcess(args=[], returncode=9, stdout="", stderr="boom"),
    )
    assert vram.detect_gpu_memory() is None


def test_detect_gpu_memory_survives_unparseable_output(monkeypatch):
    monkeypatch.setattr(vram.shutil, "which", lambda _name: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(
        vram.subprocess,
        "run",
        lambda *_a, **_k: subprocess.CompletedProcess(args=[], returncode=0, stdout="[N/A], [N/A], [N/A]\n", stderr=""),
    )
    assert vram.detect_gpu_memory() is None


def test_detect_gpu_memory_survives_a_hung_nvidia_smi(monkeypatch):
    monkeypatch.setattr(vram.shutil, "which", lambda _name: "/usr/bin/nvidia-smi")

    def boom(*_a, **_k):
        raise subprocess.TimeoutExpired(cmd="nvidia-smi", timeout=10)

    monkeypatch.setattr(vram.subprocess, "run", boom)
    assert vram.detect_gpu_memory() is None


# --- report / warning -----------------------------------------------------

RTX_5080 = {"name": "NVIDIA GeForce RTX 5080", "total_bytes": 16303 * 1024**2, "free_bytes": 15000 * 1024**2}


def test_no_warning_when_the_solve_fits():
    report = vram.vram_report(triangles=8_000, vertices=4_000, backend_id="beat_cuda", gpu=RTX_5080)
    assert report["warning"] is None
    assert report["gpu"] == RTX_5080
    assert report["local_gpu_backend"] is True


def test_warns_but_does_not_refuse_when_the_solve_is_too_big():
    report = vram.vram_report(triangles=80_000, vertices=40_000, backend_id="beat_cuda", gpu=RTX_5080)
    assert report["warning"]
    assert "exceeds" in report["warning"]
    assert "Running anyway" in report["warning"]
    assert report["estimate_bytes"] > RTX_5080["free_bytes"]


def test_no_warning_for_non_local_backends_however_large(monkeypatch):
    monkeypatch.setattr(vram, "detect_gpu_memory", lambda: RTX_5080)
    for backend in ("server", "beat_cpu", "local"):
        report = vram.vram_report(triangles=200_000, vertices=100_000, backend_id=backend)
        assert report["warning"] is None
        assert report["local_gpu_backend"] is False
        assert report["estimate_bytes"] > 0


def test_undetectable_vram_warns_that_it_could_not_be_checked(monkeypatch):
    monkeypatch.setattr(vram, "detect_gpu_memory", lambda: None)
    report = vram.vram_report(triangles=8_000, vertices=4_000, backend_id="beat_cuda")
    assert report["warning"]
    assert "Could not detect" in report["warning"]
    assert "Proceeding anyway" in report["warning"]


def test_symmetry_shrinks_the_estimate_and_the_hint():
    full = vram.vram_report(triangles=20_000, vertices=10_000, backend_id="beat_cuda", symmetry="off", gpu=RTX_5080)
    reduced = vram.vram_report(triangles=5_000, vertices=2_500, backend_id="beat_cuda", symmetry="xy", gpu=RTX_5080)
    assert reduced["estimate_bytes"] < full["estimate_bytes"] / 10
    assert reduced["symmetry"] == "xy"


def test_report_falls_back_to_total_when_free_is_unknown():
    gpu = {"name": "GPU", "total_bytes": 4 * GIB, "free_bytes": None}
    report = vram.vram_report(triangles=80_000, vertices=40_000, backend_id="beat_cuda", gpu=gpu)
    assert "total VRAM" in report["warning"]
