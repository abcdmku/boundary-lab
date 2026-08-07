"""Tests for running a solve on a REMOTE Boundary Lab server.

Everything here uses fakes: no server is started and no socket is opened. The
things worth pinning down are the ones that are expensive or dangerous to get
wrong against a real remote box --

* a bad --server-url fails at argument-parse time, not after a mesh upload;
* a symmetry-reduced mesh is only ever submitted to a server that says, in this
  probe, that it will reconstruct the reflections (silently sending it to one
  that will not is wrong physics, not a slow solve);
* the VRAM estimate is compared against the GPU that will actually run the
  solve, which for `--backend server` is the far end's;
* a dropped event stream resumes from the last event rather than losing an
  hour of GPU time.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
import pytest

from blab.config import SimulationConfig
from blab.solvers.base import SolveRequest
from blab.solvers.http_server import (
    DEFAULT_SERVER_URL,
    HttpServerBackend,
    HttpServerSession,
    normalize_server_url,
    server_health_backend_id,
    server_health_gpu,
    server_health_summary,
    server_health_supports_symmetry,
)
from blab.solvers.registry import create_backend

sys.path.append(str(Path(__file__).resolve().parents[1] / "bridge" / "py"))

import blabctl  # noqa: E402
import vram  # noqa: E402

RTX_5080 = {"name": "NVIDIA GeForce RTX 5080", "total_bytes": 16303 * 1024**2, "free_bytes": 15000 * 1024**2}


def health(
    *,
    backend: str = "beat_cuda",
    symmetry: bool = True,
    gpu: dict | None = None,
    uses_gpu: bool | None = None,
) -> dict:
    payload = {
        "status": "ok",
        "solver": backend,
        "backend": backend,
        "solver_label": "BEAT Engine (CUDA)",
        "gpu": gpu,
        "capabilities": {"supports_streaming": True, "supports_symmetry": symmetry},
    }
    if uses_gpu is not None:
        payload["solver_uses_gpu"] = uses_gpu
    return payload


# --- URL validation -------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("http://127.0.0.1:8765", "http://127.0.0.1:8765"),
        ("  http://127.0.0.1:8765/  ", "http://127.0.0.1:8765"),
        ("HTTP://Example.Test:8765", "http://example.test:8765"),
        ("https://gpu.vast.ai", "https://gpu.vast.ai"),
        ("http://10.0.0.5:8765/blab/", "http://10.0.0.5:8765/blab"),
        ("http://[::1]:8765", "http://[::1]:8765"),
    ],
)
def test_normalize_server_url_canonicalizes(raw, expected):
    assert normalize_server_url(raw) == expected


def test_normalize_server_url_falls_back_to_localhost():
    assert normalize_server_url("") == DEFAULT_SERVER_URL
    assert normalize_server_url(None) == DEFAULT_SERVER_URL


@pytest.mark.parametrize(
    ("raw", "needle"),
    [
        ("127.0.0.1:8765", "no scheme"),
        ("ftp://host:8765", "http:// or https://"),
        ("file:///etc/passwd", "http:// or https://"),
        ("http://", "no host"),
        ("http://user:pw@host:8765", "credentials"),
        ("http://host:notaport", "invalid port"),
        ("http://host:8765?x=1", "query string"),
    ],
)
def test_normalize_server_url_rejects_nonsense(raw, needle):
    with pytest.raises(ValueError) as exc:
        normalize_server_url(raw)
    assert needle in str(exc.value)


def test_normalize_server_url_without_a_default_requires_a_value():
    with pytest.raises(ValueError):
        normalize_server_url("", default=None)


# --- URL threading: CLI -> registry -> backend ----------------------------


def test_registry_threads_the_server_url_into_the_backend():
    backend = create_backend("server", server_url="http://10.0.0.5:8765/")
    assert isinstance(backend, HttpServerBackend)
    assert backend.server_url == "http://10.0.0.5:8765"


def test_registry_defaults_to_localhost_when_no_url_is_given():
    assert create_backend("server").server_url == DEFAULT_SERVER_URL


def test_registry_threads_auth_and_timeouts():
    backend = create_backend(
        "server",
        server_url="https://gpu.example",
        server_auth_token="  s3cret  ",
        server_health_timeout_s=2.5,
        server_request_timeout_s=45.0,
        server_submit_timeout_s=1200.0,
        server_stream_idle_timeout_s=90.0,
        server_stream_retries=2,
    )
    assert backend.auth_token == "s3cret"
    assert backend.health_timeout_s == 2.5
    assert backend.request_timeout_s == 45.0
    assert backend.submit_timeout_s == 1200.0
    assert backend.stream_idle_timeout_s == 90.0
    assert backend.stream_retries == 2


def test_the_mesh_upload_gets_far_longer_than_a_control_request(monkeypatch, no_session):
    """POST /jobs carries the whole mesh; 30 s is a cancel's budget, not an upload's."""
    from blab.solvers.http_server import DEFAULT_REQUEST_TIMEOUT_S, DEFAULT_SUBMIT_TIMEOUT_S

    assert DEFAULT_SUBMIT_TIMEOUT_S >= 10 * DEFAULT_REQUEST_TIMEOUT_S
    monkeypatch.setattr("blab.solvers.http_server.query_server_health", lambda *_a, **_k: health())
    backend = create_backend("server", server_url="http://remote:8765")
    backend.create_session(solve_request("off"))
    assert no_session["submit_timeout_s"] == DEFAULT_SUBMIT_TIMEOUT_S
    assert no_session["request_timeout_s"] == DEFAULT_REQUEST_TIMEOUT_S


def test_the_upload_timeout_applies_to_the_submit_and_not_to_cancel(monkeypatch):
    from blab.solvers.http_server import DEFAULT_REQUEST_TIMEOUT_S

    timeouts: list[float] = []

    def fake_urlopen(req, timeout=None):
        timeouts.append(timeout)
        if req.get_method() == "POST":
            return io.BytesIO(json.dumps({"job_id": "job-1234abcd"}).encode("utf-8"))
        return FakeStream(
            [
                {"index": 0, "type": "queued"},
                {"index": 1, "type": "started"},
                initialized_event(),
                {"index": 3, "type": "cancelled"},
            ]
        )

    monkeypatch.setattr("blab.solvers.http_server.request.urlopen", fake_urlopen)
    monkeypatch.setattr(
        "blab.solvers.http_server.solve_request_from_config_and_frequencies",
        lambda *_a, **_k: {"config": {}},
    )
    session = HttpServerSession(
        SolveRequest(
            config=SimulationConfig(mesh_file="mesh.msh"),
            frequencies_hz=np.array([1000.0], dtype=np.float32),
        ),
        "http://remote:8765",
        submit_timeout_s=900.0,
    )
    session.stop()
    assert timeouts[0] == 900.0  # POST /jobs, the mesh upload
    assert timeouts[-1] == DEFAULT_REQUEST_TIMEOUT_S  # POST /cancel, a control request


def test_registry_rejects_a_bad_url_rather_than_defaulting():
    with pytest.raises(ValueError):
        create_backend("server", server_url="ftp://nope")


def test_blabctl_solve_parses_and_normalizes_server_url():
    args = blabctl.build_parser().parse_args(
        [
            "solve",
            "--mesh-run",
            "runs/mesh",
            "--out",
            "runs/solve",
            "--backend",
            "server",
            "--server-url",
            "http://10.0.0.5:8765/",
        ]
    )
    assert args.server_url == "http://10.0.0.5:8765"


def test_blabctl_solve_rejects_a_bad_server_url_at_parse_time(capsys):
    with pytest.raises(SystemExit):
        blabctl.build_parser().parse_args(["solve", "--mesh-run", "m", "--out", "o", "--server-url", "not-a-url"])
    assert "server-url" in capsys.readouterr().err


def subparser_help(command: str) -> str:
    parser = blabctl.build_parser()
    subparsers = next(action for action in parser._actions if isinstance(action, argparse._SubParsersAction))  # noqa: SLF001
    return subparsers.choices[command].format_help()


def test_blabctl_solve_help_documents_the_localhost_default():
    """--backend server without a URL keeps working; the help says where it goes."""
    solve_help = subparser_help("solve")
    assert DEFAULT_SERVER_URL in solve_help
    assert "BLAB_SERVER_URL" in solve_help
    assert "remote" in solve_help
    assert blabctl.build_parser().parse_args(["solve", "--mesh-run", "m", "--out", "o"]).server_url is None


def test_a_server_url_on_a_local_backend_is_an_error_not_a_silent_local_solve(monkeypatch, capsys):
    def unreachable(*_a, **_k):
        raise AssertionError("no server should be contacted")

    monkeypatch.setattr(blabctl, "probe_server_health", unreachable)
    lines, code = run_blabctl(
        ["solve", "--mesh-run", "m", "--out", "o", "--backend", "beat_cuda", "--server-url", "http://remote:8765"],
        monkeypatch,
        capsys,
    )
    assert code == 1
    assert "only applies to --backend server" in lines[-1]["error"]


def test_resolve_server_url_prefers_cli_then_env_then_localhost(monkeypatch):
    monkeypatch.delenv("BLAB_SERVER_URL", raising=False)
    assert blabctl.resolve_server_url(None) == DEFAULT_SERVER_URL
    monkeypatch.setenv("BLAB_SERVER_URL", "http://env.example:9000/")
    assert blabctl.resolve_server_url(None) == "http://env.example:9000"
    assert blabctl.resolve_server_url("http://cli.example:1234") == "http://cli.example:1234"


def test_resolve_server_token_prefers_cli_then_env(monkeypatch):
    monkeypatch.delenv("BLAB_SERVER_TOKEN", raising=False)
    assert blabctl.resolve_server_token(None) is None
    monkeypatch.setenv("BLAB_SERVER_TOKEN", " envtoken ")
    assert blabctl.resolve_server_token(None) == "envtoken"
    assert blabctl.resolve_server_token("clitoken") == "clitoken"


# --- symmetry negotiation -------------------------------------------------


def solve_request(symmetry: str) -> SolveRequest:
    return SolveRequest(
        config=SimulationConfig(mesh_file="reduced.msh", symmetry=symmetry),
        frequencies_hz=np.array([1000.0], dtype=np.float32),
    )


@pytest.fixture
def no_session(monkeypatch):
    """Stop create_session before it opens a socket; record what it got."""
    created: dict = {}

    def fake_session(request_payload, server_url, **kwargs):
        created["symmetry"] = request_payload.config.symmetry
        created["server_url"] = server_url
        created.update(kwargs)
        return created

    monkeypatch.setattr("blab.solvers.http_server.HttpServerSession", fake_session)
    return created


def test_symmetry_off_does_not_even_probe(monkeypatch, no_session):
    def boom(*_a, **_k):
        raise AssertionError("symmetry=off must not need a health probe")

    monkeypatch.setattr("blab.solvers.http_server.query_server_health", boom)
    backend = create_backend("server", server_url="http://remote:8765")
    backend.create_session(solve_request("off"))
    assert no_session["symmetry"] == "off"


def test_capable_server_accepts_a_reduced_mesh(monkeypatch, no_session):
    monkeypatch.setattr("blab.solvers.http_server.query_server_health", lambda *_a, **_k: health(symmetry=True))
    backend = create_backend("server", server_url="http://remote:8765", server_auth_token="tok")
    backend.create_session(solve_request("xy"))
    assert no_session["symmetry"] == "xy"
    assert no_session["server_url"] == "http://remote:8765"
    assert no_session["auth_token"] == "tok"


def test_incapable_server_never_receives_a_reduced_mesh(monkeypatch, no_session):
    monkeypatch.setattr(
        "blab.solvers.http_server.query_server_health",
        lambda *_a, **_k: health(backend="local", symmetry=False),
    )
    backend = create_backend("server", server_url="http://remote:8765")
    with pytest.raises(RuntimeError) as exc:
        backend.create_session(solve_request("xy"))
    assert "does not advertise symmetry support" in str(exc.value)
    assert not no_session


def test_unreachable_server_is_not_assumed_capable(monkeypatch, no_session):
    def boom(*_a, **_k):
        raise OSError("connection refused")

    monkeypatch.setattr("blab.solvers.http_server.query_server_health", boom)
    backend = create_backend("server", server_url="http://remote:8765")
    with pytest.raises(RuntimeError) as exc:
        backend.create_session(solve_request("x"))
    assert "Could not query solve server capabilities" in str(exc.value)
    assert not no_session


def test_symmetry_probe_is_refreshed_per_session(monkeypatch, no_session):
    """A server restarted with a different --solver must not be remembered."""
    payloads = [health(symmetry=True), health(backend="local", symmetry=False)]
    monkeypatch.setattr("blab.solvers.http_server.query_server_health", lambda *_a, **_k: payloads.pop(0))
    backend = create_backend("server", server_url="http://remote:8765")
    backend.create_session(solve_request("xy"))
    with pytest.raises(RuntimeError):
        backend.create_session(solve_request("xy"))


def test_effective_capabilities_overlay_health_onto_the_static_table(monkeypatch):
    monkeypatch.setattr("blab.solvers.http_server.query_server_health", lambda *_a, **_k: health(symmetry=True))
    backend = create_backend("server", server_url="http://remote:8765")
    # The registry's static entry describes the protocol and says "no symmetry".
    assert HttpServerBackend.capabilities.supports_symmetry is False
    effective = backend.effective_capabilities()
    assert effective.supports_symmetry is True
    assert effective.is_remote is True
    assert backend.supports_symmetry() is True


def test_health_helpers_read_the_payload():
    payload = health(gpu=RTX_5080)
    assert server_health_supports_symmetry(payload) is True
    assert server_health_backend_id(payload) == "beat_cuda"
    assert server_health_gpu(payload) == RTX_5080
    assert server_health_gpu(health(gpu=None)) is None
    # A CPU solve server can still have a card in the box; the summary must not
    # advertise it as this solve's capacity.
    cpu_server = health(backend="local", symmetry=False, gpu=RTX_5080, uses_gpu=False)
    assert "gpu=" not in server_health_summary(cpu_server)
    assert "gpu=NVIDIA GeForce RTX 5080" in server_health_summary(health(gpu=RTX_5080, uses_gpu=True))
    assert "beat_cuda" in server_health_summary(payload)
    assert "symmetry=yes" in server_health_summary(payload)
    assert "symmetry=no" in server_health_summary(health(symmetry=False))


# --- remote VRAM ----------------------------------------------------------


def test_remote_solve_is_sized_against_the_server_gpu():
    report = vram.vram_report(
        triangles=80_000,
        vertices=40_000,
        backend_id="server",
        remote_health=health(gpu=RTX_5080),
    )
    assert report["gpu"] == RTX_5080
    assert report["gpu_location"] == "remote"
    assert report["local_gpu_backend"] is False
    assert "exceeds" in report["warning"]
    assert "solve server" in report["warning"]
    assert "Running anyway" in report["warning"]


def test_remote_solve_that_fits_the_server_gpu_is_silent():
    report = vram.vram_report(
        triangles=8_000,
        vertices=4_000,
        backend_id="server",
        remote_health=health(gpu=RTX_5080),
    )
    assert report["warning"] is None
    assert report["gpu_location"] == "remote"


def test_remote_cpu_server_has_no_vram_to_exceed():
    report = vram.vram_report(
        triangles=200_000,
        vertices=100_000,
        backend_id="server",
        remote_health=health(backend="local", symmetry=False, gpu=RTX_5080, uses_gpu=False),
    )
    assert report["warning"] is None
    assert report["gpu"] is None


def test_remote_gpu_server_without_gpu_details_warns_that_it_could_not_check():
    report = vram.vram_report(
        triangles=8_000,
        vertices=4_000,
        backend_id="server",
        remote_health=health(gpu=None),
    )
    assert "could not be checked" in report["warning"]
    assert "Proceeding anyway" in report["warning"]
    assert report["gpu"] is None


def test_remote_report_without_any_health_stays_quiet(monkeypatch):
    """Unchanged behaviour for callers that never probed: estimate only."""
    monkeypatch.setattr(vram, "detect_gpu_memory", lambda: RTX_5080)
    report = vram.vram_report(triangles=200_000, vertices=100_000, backend_id="server")
    assert report["warning"] is None
    assert report["gpu"] is None
    assert report["estimate_bytes"] > 0


def test_remote_solve_never_looks_at_the_local_gpu(monkeypatch):
    def boom():
        raise AssertionError("a remote solve must not size itself against the local card")

    monkeypatch.setattr(vram, "detect_gpu_memory", boom)
    vram.vram_report(triangles=8_000, vertices=4_000, backend_id="server", remote_health=health(gpu=RTX_5080))


def test_remote_health_uses_gpu_falls_back_to_the_backend_id():
    # Older servers do not send solver_uses_gpu; the backend id still says so.
    assert vram.remote_health_uses_gpu(health(backend="beat_cuda")) is True
    assert vram.remote_health_uses_gpu(health(backend="beat_cpu")) is False
    assert vram.remote_health_uses_gpu(health(backend="beat_cpu", uses_gpu=True)) is True
    assert vram.remote_health_uses_gpu(None) is False


# --- remote-check ---------------------------------------------------------


def run_blabctl(argv, monkeypatch, capsys) -> list[dict]:
    """Run a blabctl command and return its NDJSON lines."""
    stream = io.StringIO()
    monkeypatch.setattr(blabctl, "_NDJSON_OUT", stream)
    code = blabctl.main(argv)
    capsys.readouterr()
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()], code


def test_remote_check_reports_solver_capabilities_and_gpu(monkeypatch, capsys):
    monkeypatch.setattr(
        "blab.solvers.http_server.query_server_health",
        lambda *_a, **_k: health(gpu=RTX_5080, uses_gpu=True),
    )
    lines, code = run_blabctl(["remote-check", "--server-url", "http://remote:8765"], monkeypatch, capsys)

    assert code == 0
    result = lines[-1]
    assert result["event"] == "result"
    assert result["ok"] is True
    assert result["server_url"] == "http://remote:8765"
    assert result["reachable"] is True
    assert result["backend"] == "beat_cuda"
    assert result["supports_symmetry"] is True
    assert result["solver_uses_gpu"] is True
    assert result["gpu"] == RTX_5080
    assert result["gpu_human"]["total"] == "15.92 GiB"
    assert result["capabilities"]["supports_symmetry"] is True
    assert isinstance(result["latency_ms"], float)
    assert any(line.get("event") == "progress" for line in lines)


def test_remote_check_reports_a_cpu_server_as_symmetry_less(monkeypatch, capsys):
    monkeypatch.setattr(
        "blab.solvers.http_server.query_server_health",
        lambda *_a, **_k: health(backend="local", symmetry=False, uses_gpu=False),
    )
    lines, code = run_blabctl(["remote-check", "--server-url", "http://remote:8765"], monkeypatch, capsys)

    assert code == 0
    result = lines[-1]
    assert result["supports_symmetry"] is False
    assert result["solver_uses_gpu"] is False
    assert result["gpu"] is None
    assert not [line for line in lines if line.get("event") == "warning"]


def test_remote_check_warns_when_a_gpu_server_hides_its_gpu(monkeypatch, capsys):
    monkeypatch.setattr(
        "blab.solvers.http_server.query_server_health",
        lambda *_a, **_k: health(gpu=None, uses_gpu=True),
    )
    lines, _code = run_blabctl(["remote-check", "--server-url", "http://remote:8765"], monkeypatch, capsys)
    warnings = [line for line in lines if line.get("event") == "warning"]
    assert warnings and "does not report GPU details" in warnings[0]["message"]


def test_remote_check_fails_cleanly_when_the_server_is_down(monkeypatch, capsys):
    def boom(*_a, **_k):
        raise OSError("connection refused")

    monkeypatch.setattr("blab.solvers.http_server.query_server_health", boom)
    lines, code = run_blabctl(["remote-check", "--server-url", "http://remote:8765"], monkeypatch, capsys)

    assert code == 1
    assert lines[-1] == {
        "event": "result",
        "ok": False,
        "error": lines[-1]["error"],
    }
    assert "http://remote:8765 is not reachable" in lines[-1]["error"]


def test_remote_check_defaults_to_localhost(monkeypatch, capsys):
    monkeypatch.delenv("BLAB_SERVER_URL", raising=False)
    seen: dict = {}

    def record(url, **kwargs):
        seen["url"] = url
        seen.update(kwargs)
        return health()

    monkeypatch.setattr("blab.solvers.http_server.query_server_health", record)
    lines, code = run_blabctl(["remote-check", "--server-token", "tok"], monkeypatch, capsys)
    assert code == 0
    assert seen["url"] == DEFAULT_SERVER_URL
    assert seen["auth_token"] == "tok"
    assert lines[-1]["server_url"] == DEFAULT_SERVER_URL


# --- which GPU is "the" GPU -----------------------------------------------
#
# A rented multi-GPU box is the normal case for a remote solve, and there
# CUDA_VISIBLE_DEVICES decides where the solve lands. Naming the wrong card is
# worse than naming none: it suppresses a real OOM warning on a smaller card and
# invents one on a larger.

TWO_GPUS = (
    "0, GPU-1111aaaa, NVIDIA GeForce RTX 5080, 16303, 15000\n1, GPU-2222bbbb, NVIDIA H100 80GB HBM3, 81559, 80000\n"
)


@pytest.fixture
def fake_nvidia_smi(monkeypatch):
    import subprocess

    import blab.gpu as blab_gpu

    monkeypatch.setattr(blab_gpu.shutil, "which", lambda _name: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(
        blab_gpu.subprocess,
        "run",
        lambda *_a, **_k: subprocess.CompletedProcess(args=[], returncode=0, stdout=TWO_GPUS, stderr=""),
    )
    return blab_gpu


def test_no_cuda_visible_devices_takes_the_first_card(fake_nvidia_smi):
    assert fake_nvidia_smi.detect_gpu_memory({})["name"] == "NVIDIA GeForce RTX 5080"


def test_cuda_visible_devices_selects_by_index(fake_nvidia_smi):
    gpu = fake_nvidia_smi.detect_gpu_memory({"CUDA_VISIBLE_DEVICES": "1"})
    assert gpu["name"] == "NVIDIA H100 80GB HBM3"
    assert gpu["index"] == 1
    assert gpu["total_bytes"] == 81559 * 1024**2


def test_cuda_visible_devices_selects_by_uuid(fake_nvidia_smi):
    gpu = fake_nvidia_smi.detect_gpu_memory({"CUDA_VISIBLE_DEVICES": "GPU-2222"})
    assert gpu["name"] == "NVIDIA H100 80GB HBM3"


def test_only_the_first_visible_device_matters(fake_nvidia_smi):
    """CUDA device 0 is the head of the list, and that is where the solve runs."""
    assert fake_nvidia_smi.detect_gpu_memory({"CUDA_VISIBLE_DEVICES": "1,0"})["index"] == 1


def test_an_empty_cuda_visible_devices_means_no_gpu(fake_nvidia_smi):
    assert fake_nvidia_smi.detect_gpu_memory({"CUDA_VISIBLE_DEVICES": ""}) is None


def test_an_unmatched_selector_reports_unknown_rather_than_the_wrong_card(fake_nvidia_smi):
    assert fake_nvidia_smi.detect_gpu_memory({"CUDA_VISIBLE_DEVICES": "7"}) is None
    assert fake_nvidia_smi.detect_gpu_memory({"CUDA_VISIBLE_DEVICES": "GPU-nosuch"}) is None


def test_visible_device_selector_reads_the_environment():
    from blab.gpu import visible_device_selector

    assert visible_device_selector({}) is None
    assert visible_device_selector({"CUDA_VISIBLE_DEVICES": "2,3"}) == "2"
    assert visible_device_selector({"CUDA_VISIBLE_DEVICES": " 2 "}) == "2"
    assert visible_device_selector({"CUDA_VISIBLE_DEVICES": ""}) == ""


# --- server-side health payload -------------------------------------------


def test_server_health_payload_reports_its_gpu(monkeypatch, tmp_path):
    from blab.server import BlabServer, JobOrchestrator

    monkeypatch.setattr("blab.server.detect_gpu_memory", lambda: RTX_5080)
    orchestrator = JobOrchestrator(artifact_root=tmp_path, solver_factory=lambda config: None)
    server = BlabServer(("127.0.0.1", 0), orchestrator, solver_id="beat_cuda")
    try:
        payload = server.health_payload()
        assert payload["backend"] == "beat_cuda"
        assert payload["solver_uses_gpu"] is True
        assert payload["gpu"] == RTX_5080
        assert payload["capabilities"]["supports_symmetry"] is True
        # A remote client must be able to read the payload with the same helpers
        # it uses against a live server.
        assert server_health_gpu(payload) == RTX_5080
        assert vram.remote_gpu_from_health(payload) == RTX_5080
    finally:
        orchestrator.shutdown()
        server.server_close()


def test_server_health_payload_marks_a_cpu_solver_as_gpu_less(monkeypatch, tmp_path):
    from blab.server import BlabServer, JobOrchestrator

    monkeypatch.setattr("blab.server.detect_gpu_memory", lambda: RTX_5080)
    orchestrator = JobOrchestrator(artifact_root=tmp_path, solver_factory=lambda config: None)
    server = BlabServer(("127.0.0.1", 0), orchestrator, solver_id="bempp_cpu")
    try:
        payload = server.health_payload()
        assert payload["solver_uses_gpu"] is False
        # The card is still reported, but it is not what the solve will use.
        assert payload["gpu"] == RTX_5080
        assert vram.remote_gpu_from_health(payload) is None
    finally:
        orchestrator.shutdown()
        server.server_close()


def test_server_gpu_probe_is_cached(monkeypatch, tmp_path):
    from blab.server import BlabServer, JobOrchestrator

    calls = {"n": 0}

    def counted():
        calls["n"] += 1
        return RTX_5080

    monkeypatch.setattr("blab.server.detect_gpu_memory", counted)
    orchestrator = JobOrchestrator(artifact_root=tmp_path, solver_factory=lambda config: None)
    server = BlabServer(("127.0.0.1", 0), orchestrator, solver_id="beat_cuda")
    try:
        for _ in range(5):
            server.health_payload()
        assert calls["n"] == 1
    finally:
        orchestrator.shutdown()
        server.server_close()


# --- event stream robustness ----------------------------------------------


class FakeStream:
    """One connection's worth of NDJSON, optionally truncated by a failure.

    Stands in for the file-like object urlopen returns: line-iterable, closable,
    and able to blow up mid-stream the way a real socket does.
    """

    def __init__(self, lines: list[dict | str], *, fail_with: Exception | None = None):
        self._buffer = io.BytesIO(
            b"".join((line if isinstance(line, str) else json.dumps(line)).encode("utf-8") + b"\n" for line in lines)
        )
        self._fail_with = fail_with
        self.closed = False

    def __iter__(self):
        while True:
            line = self._buffer.readline()
            if not line:
                break
            yield line
        if self._fail_with is not None:
            raise self._fail_with

    def close(self) -> None:
        self.closed = True


def make_session(monkeypatch, streams: list[FakeStream], *, stream_retries: int = 3) -> tuple[object, list]:
    """A session whose HTTP layer is a scripted list of streams."""
    opened: list = []
    statuses: list[str] = []

    def fake_urlopen(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        opened.append(url)
        if not streams:
            raise AssertionError(f"unscripted request: {url}")
        return streams.pop(0)

    monkeypatch.setattr("blab.solvers.http_server.request.urlopen", fake_urlopen)
    monkeypatch.setattr("blab.solvers.http_server.time.sleep", lambda _s: None)
    monkeypatch.setattr(
        "blab.solvers.http_server.solve_request_from_config_and_frequencies",
        lambda *_a, **_k: {"config": {}, "frequencies_hz": []},
    )
    monkeypatch.setattr(
        HttpServerSession,
        "_post_json",
        lambda self, path, payload, **_kwargs: {"job_id": "job-1234abcd"},
    )
    request_payload = SolveRequest(
        config=SimulationConfig(mesh_file="mesh.msh"),
        frequencies_hz=np.array([1000.0, 2000.0], dtype=np.float32),
        status_callback=statuses.append,
    )
    session = HttpServerSession(
        request_payload,
        "http://remote:8765",
        stream_retries=stream_retries,
    )
    session._opened_urls = opened  # noqa: SLF001 - test introspection
    session._statuses = statuses  # noqa: SLF001
    return session, opened


def initialized_event(index: int = 2) -> dict:
    return {
        "index": index,
        "type": "initialized",
        "polar_angle_deg": [0.0, 10.0],
        "radiator_names": ["Radiator"],
        "sphere_metadata": None,
    }


def test_heartbeats_keep_the_stream_alive_without_moving_the_resume_point(monkeypatch):
    stream = FakeStream(
        [
            {"index": 0, "type": "queued"},
            {"type": "heartbeat", "job_id": "job-1234abcd"},
            {"index": 1, "type": "started"},
            {"type": "heartbeat", "job_id": "job-1234abcd"},
            initialized_event(),
            {"index": 3, "type": "completed"},
        ]
    )
    session, _opened = make_session(monkeypatch, [stream])
    assert list(session.solve_stream()) == []
    assert session._next_index == 4  # noqa: SLF001 - heartbeats carry no index


def test_a_dropped_stream_resumes_from_the_last_event(monkeypatch):
    dropped = FakeStream(
        [{"index": 0, "type": "queued"}, {"index": 1, "type": "started"}, initialized_event()],
        fail_with=TimeoutError("read timed out"),
    )
    resumed = FakeStream([{"index": 3, "type": "completed"}])
    session, opened = make_session(monkeypatch, [dropped, resumed])

    assert list(session.solve_stream()) == []
    assert opened == [
        "http://remote:8765/jobs/job-1234abcd/events?since=0",
        "http://remote:8765/jobs/job-1234abcd/events?since=3",
    ]
    assert any("reconnecting from event 3" in message for message in session._statuses)  # noqa: SLF001


def test_reconnects_give_up_after_the_retry_budget(monkeypatch):
    # The retry budget counts *fruitless* attempts: the first reconnect follows
    # a stream that did deliver events, so it does not spend from the budget.
    streams = [
        FakeStream([{"index": 0, "type": "queued"}, {"index": 1, "type": "started"}, initialized_event()]),
        FakeStream([], fail_with=ConnectionResetError("boom")),
        FakeStream([], fail_with=ConnectionResetError("boom")),
        FakeStream([], fail_with=ConnectionResetError("boom")),
    ]
    session, opened = make_session(monkeypatch, streams, stream_retries=2)
    with pytest.raises(RuntimeError) as exc:
        list(session.solve_stream())
    message = str(exc.value)
    assert "Lost the event stream for server job job-1234abcd" in message
    assert "may still be running" in message
    assert opened.count("http://remote:8765/jobs/job-1234abcd/events?since=3") == 3


def test_progress_resets_the_retry_budget(monkeypatch):
    """A long solve that drops every so often keeps going as long as it advances."""
    streams = [
        FakeStream([{"index": 0, "type": "queued"}, {"index": 1, "type": "started"}, initialized_event()]),
        FakeStream([{"index": 3, "type": "result", "result": None}], fail_with=TimeoutError("idle")),
        FakeStream([{"index": 4, "type": "result", "result": None}], fail_with=TimeoutError("idle")),
        FakeStream([{"index": 5, "type": "result", "result": None}], fail_with=TimeoutError("idle")),
        FakeStream([{"index": 6, "type": "completed"}]),
    ]
    session, _opened = make_session(monkeypatch, streams, stream_retries=1)
    monkeypatch.setattr("blab.solvers.http_server.frequency_result_from_dict", lambda raw: raw)
    assert list(session.solve_stream()) == [None, None, None]


def test_a_completed_stream_is_not_reconnected(monkeypatch):
    stream = FakeStream(
        [
            {"index": 0, "type": "queued"},
            {"index": 1, "type": "started"},
            initialized_event(),
            {"index": 3, "type": "completed"},
        ]
    )
    session, opened = make_session(monkeypatch, [stream])
    assert list(session.solve_stream()) == []
    assert len(opened) == 1


def test_cancel_posts_once_against_the_remote_job(monkeypatch):
    stream = FakeStream(
        [
            {"index": 0, "type": "queued"},
            {"index": 1, "type": "started"},
            initialized_event(),
            {"index": 3, "type": "cancelling"},
            {"index": 4, "type": "cancelling"},
            {"index": 5, "type": "cancelled"},
        ]
    )
    session, _opened = make_session(monkeypatch, [stream])

    posts: list[str] = []
    monkeypatch.setattr(
        HttpServerSession,
        "_post_json",
        lambda self, path, payload, **_kwargs: posts.append(path) or {},
    )
    assert list(session.solve_stream(stop_requested=lambda: True)) == []
    assert posts == ["/jobs/job-1234abcd/cancel"]


def test_a_failed_cancel_is_retried(monkeypatch):
    stream = FakeStream([{"index": 0, "type": "queued"}, {"index": 1, "type": "started"}, initialized_event()])
    session, _opened = make_session(monkeypatch, [stream])

    attempts: list[str] = []

    def flaky(self, path, payload, **_kwargs):
        attempts.append(path)
        if len(attempts) == 1:
            raise RuntimeError("network hiccup")
        return {}

    monkeypatch.setattr(HttpServerSession, "_post_json", flaky)
    session.stop()
    session.stop()
    assert attempts == ["/jobs/job-1234abcd/cancel"] * 2
    session.stop()
    assert len(attempts) == 2  # succeeded, so no third POST


def test_the_auth_token_rides_on_every_request(monkeypatch):
    stream = FakeStream(
        [
            {"index": 0, "type": "queued"},
            {"index": 1, "type": "started"},
            initialized_event(),
            {"index": 3, "type": "completed"},
        ]
    )
    captured: list = []

    def fake_urlopen(req, timeout=None):
        captured.append(req)
        return stream

    monkeypatch.setattr("blab.solvers.http_server.request.urlopen", fake_urlopen)
    monkeypatch.setattr(
        "blab.solvers.http_server.solve_request_from_config_and_frequencies",
        lambda *_a, **_k: {"config": {}, "frequencies_hz": []},
    )
    monkeypatch.setattr(HttpServerSession, "_post_json", lambda self, path, payload, **_kwargs: {"job_id": "job-1"})
    session = HttpServerSession(
        SolveRequest(
            config=SimulationConfig(mesh_file="mesh.msh"),
            frequencies_hz=np.array([1000.0], dtype=np.float32),
        ),
        "http://remote:8765",
        auth_token="s3cret",
    )
    assert session.job_id == "job-1"
    assert captured[0].get_header("Authorization") == "Bearer s3cret"
