"""Tests for bridge/py/blabctl.py generate: mesh size is never a refusal.

There used to be a hard 9000-triangle guard here. Mesh size is a hardware
capacity question, so it moved to solve time as a warning; generate must now
hand back any mesh a generator produces.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest

sys.path.append(str(Path(__file__).resolve().parents[1] / "bridge" / "py"))

# blabctl swaps sys.stdout for sys.stderr at import so stdout stays strict
# NDJSON; put pytest's capture back afterwards.
_PYTEST_STDOUT = sys.stdout
import blabctl  # noqa: E402
import generators  # noqa: E402
import preview  # noqa: E402
import vram  # noqa: E402

sys.stdout = _PYTEST_STDOUT


SCHEMA = {
    "id": "fake_horn",
    "title": "Fake",
    "description": "Fake generator for tests",
    "params": {"type": "object", "properties": {"element_size_mm": {"type": "number", "default": 4.0}}},
}


class FakeGenerator:
    SCHEMA = SCHEMA

    def __init__(self, triangles: int, out_dir: Path):
        self.triangles = triangles
        self.out_dir = out_dir
        self.seen_params: dict | None = None

    def generate(self, params, out_dir, name, emit):
        self.seen_params = params
        return {
            # Deliberately absent: _generate_vram_estimates must tolerate a mesh
            # file it cannot read rather than failing the run.
            "cleaned_msh_path": str(self.out_dir / f"{name}_missing.msh"),
            "mesh_path": str(self.out_dir / f"{name}_raw.msh"),
            "mirror_axes": [],
            "triangles": self.triangles,
            "bbox_mm": [100.0, 100.0, 50.0],
            "driven_tag": 7,
            "radiators": [{"name": "throat", "tag": 7, "level_db": 0.0}],
            "quality_warning": None,
        }


@pytest.fixture
def stubbed_generate(monkeypatch, tmp_path):
    """cmd_generate with the generator, STL export and preview render stubbed."""

    def _build(triangles: int, params: dict | None = None):
        fake = FakeGenerator(triangles, tmp_path)
        monkeypatch.setattr(generators, "load_generator", lambda _id: fake)
        monkeypatch.setattr(generators, "export_viewer_stls", lambda *_a, **_k: {"walls": None, "driven": None})
        monkeypatch.setattr(preview, "render_mesh_preview", lambda *_a, **_k: None)
        monkeypatch.setattr(vram, "detect_gpu_memory", lambda: None)
        params_path = None
        if params is not None:
            params_path = tmp_path / "params.json"
            params_path.write_text(json.dumps(params), encoding="utf-8")
        args = argparse.Namespace(
            generator="fake_horn",
            params=str(params_path) if params_path else None,
            out=str(tmp_path / "run"),
            name="case",
        )
        return fake, blabctl.cmd_generate(args)

    return _build


def test_the_triangle_guard_is_gone():
    assert not hasattr(blabctl, "TRIANGLE_GUARD")


@pytest.mark.parametrize("triangles", [9_001, 20_000, 250_000])
def test_generate_never_refuses_a_large_mesh(stubbed_generate, triangles):
    _fake, result = stubbed_generate(triangles)
    assert result["triangles"] == triangles
    assert result["generator"] == "fake_horn"


def test_generate_still_reports_triangles_and_quality_warning(stubbed_generate):
    _fake, result = stubbed_generate(50_000)
    assert result["triangles"] == 50_000
    assert "quality_warning" in result
    assert result["bbox_mm"] == [100.0, 100.0, 50.0]


def test_generate_result_json_is_written(stubbed_generate, tmp_path):
    _fake, _result = stubbed_generate(30_000)
    written = json.loads((tmp_path / "run" / "result.json").read_text(encoding="utf-8"))
    assert written["ok"] is True
    assert written["triangles"] == 30_000


def test_generate_carries_a_vram_block_even_when_the_mesh_is_unreadable(stubbed_generate):
    _fake, result = stubbed_generate(30_000)
    assert result["vram"]["estimate_bytes"] == {}
    assert result["vram"]["gpu"] is None


def test_allow_large_is_accepted_as_a_no_op(stubbed_generate):
    """Old campaign specs and saved params still carry the flag."""
    fake, result = stubbed_generate(30_000, params={"allow_large": True, "element_size_mm": 6.0})
    assert result["triangles"] == 30_000
    # It must not leak into the generator's params either.
    assert "allow_large" not in fake.seen_params
    assert fake.seen_params["element_size_mm"] == 6.0


def test_unknown_params_are_still_rejected(stubbed_generate):
    with pytest.raises(ValueError, match="Unknown params"):
        stubbed_generate(1_000, params={"not_a_real_param": 1})
