"""VRAM estimation for BEM solves, and detection of the GPU's capacity.

Nothing here ever blocks a solve. Mesh size is a hardware-capacity question,
not a correctness one: we estimate what the solve will need, compare it with
what the GPU that will run it actually has, and warn. The solve proceeds either
way.

"The GPU that will run it" is not always this machine's. For ``beat_cuda`` /
``beat_rocm`` it is the local card, read from nvidia-smi. For the ``server``
backend the solve happens wherever the far end is, so the comparison is against
the ``gpu`` block in that server's ``GET /health`` payload -- and only when the
server says it is running a GPU solver, since a card being present on a
``bempp_cpu`` server tells us nothing.

Where the model comes from
--------------------------
The BEAT engine (``src/blab/solvers/julia_local/``) is a mixed P1/DP0 Burton-
Miller Galerkin BEM. Reading the assembly and solve paths:

* ``build_p1_space`` / ``build_dp0_space`` (``src/BeatEngineCore.jl``) give
  ``V = len(vertices)`` P1 unknowns and ``F = len(faces)`` DP0 unknowns. The
  linear system is ``V x V``; the Neumann data is per-triangle. For a
  triangulated surface ``F ~ 2V``, so ``V ~ triangles / 2`` when the vertex
  count is not known exactly.
* ``src/BeatEngineCudaAssembly.jl`` builds four dense operators that stay
  resident for the whole frequency step: ``single_layer`` and
  ``adjoint_double_layer`` are ``V x F``; ``double_layer`` and
  ``hypersingular`` are ``V x V``.
* ``BeatEngineCore.jl`` solve step allocates ``d_lhs = similar(double_layer)``
  (another ``V x V``), and ``d_lhs \\ d_rhs`` dispatches to CUDA.jl's
  ``copy_cublasfloat`` + ``getrf!``, which copies the LHS before factorizing
  in place -- so one more ``V x V``.
* ``solver.jl`` hardcodes ``FloatType = Float32``, so every operator entry is a
  ``ComplexF32``: 8 bytes.

Peak dense footprint is therefore ``8 * (2*V*F + 4*V*V)`` bytes. The assembly
stage's own peak (eight real ``Float32`` staging arrays plus one materialized
complex operator) is smaller, so the solve step sets the high-water mark.

The singular-correction stage does not raise that mark either, which is easy to
misread:

* ``BeatEngineCudaAssembly.jl`` materializes each complex operator and
  immediately ``CUDA.unsafe_free!``s its real/imag staging pair, one at a time,
  *before* calling ``add_singular_corrections_cuda_compact!``.
* That function's four "storage" arrays come from
  ``_cuda_complex_operator_storage``, which is
  ``reinterpret(reshape, T, operator)`` -- a view over the resident operator,
  not a copy. Its only allocations are ``pair_count x 3`` / ``pair_count x 9``
  value blocks, i.e. O(N), counted below.
* The eight ``Float32`` matrices in ``add_image_singular_corrections_cuda_
  compact!`` sit in the ``else`` of ``if on_gpu``. The CUDA path passes
  ``on_gpu=true``, so that branch is the CPU-operator fallback and never runs
  here.

Symmetry reduces this, it does not grow it: the reduced mesh IS the fundamental
domain and image contributions are accumulated into the same matrices by extra
kernel launches (``_launch_regular_symmetry_image_kernel!``). Halving the
element count quarters the memory. So the estimate must be fed the element
counts of the mesh that is actually handed to the solver.

On top of the dense matrices there are O(N) allocations that are small but not
nothing: the per-frequency singular correction value blocks in
``BeatEngineCudaSingular.jl`` are 24 ComplexF32 per adjacent element pair with
roughly 13-14 pairs per triangle (~2.6 kB/triangle), plus the persistent
singular cache (~0.6 kB/triangle) and the regular geometry cache
(~0.1 kB/triangle).

Cross-check: the README's measured VRAM table is indexed by node count N and
fits ``48 * N^2`` bytes almost exactly (1k -> ~50 MB, 10k -> ~4.8 GB,
20k -> ~19 GB). With ``F = 2V`` this model gives ``64 * V^2``, i.e. ~33% above
the measured numbers -- it accounts for the LU copy the table does not. Erring
high is the right direction for a capacity warning.
"""

from __future__ import annotations

from blab.gpu import GPU_BACKEND_IDS, backend_uses_gpu, detect_gpu_memory
from blab.solvers.http_server import (
    server_health_backend_id,
    server_health_gpu,
    server_health_solver_uses_gpu,
)

__all__ = [
    "AUX_BYTES_PER_TRIANGLE",
    "COMPLEX_BYTES",
    "DEFAULT_OVERHEAD",
    "LOCAL_GPU_BACKENDS",
    "detect_gpu_memory",
    "estimate_solve_vram_bytes",
    "format_bytes",
    "is_local_gpu_backend",
    "remote_gpu_from_health",
    "vertices_from_triangles",
    "vram_report",
]

# ComplexF32 (solver.jl: FloatType = Float32). 8 bytes per operator entry.
COMPLEX_BYTES = 8

# Dense matrix-equivalents live at peak, expressed as (V*F terms, V*V terms):
# single_layer + adjoint_double_layer are V x F; double_layer, hypersingular,
# d_lhs and the LU copy of d_lhs are V x V.
_VF_MATRICES = 2
_VV_MATRICES = 4

# O(N) GPU allocations that scale with triangle count: per-frequency singular
# value blocks (~2.6 kB), persistent singular cache (~0.6 kB), regular geometry
# cache (~0.1 kB).
AUX_BYTES_PER_TRIANGLE = 3400

# CUDA memory-pool fragmentation, the cuSOLVER getrf workspace, field-evaluation
# temporaries, and the fact that CUDA.jl does not free the LU copy eagerly.
DEFAULT_OVERHEAD = 1.25

# Backends that consume the *local* machine's GPU memory. `server` is remote,
# `beat_cpu` and `local` (bempp-cl OpenCL) run on host RAM. Ids here are the
# canonical ones from blab.solvers.registry.normalize_backend_id -- callers must
# normalize before asking (e.g. "julia_local" normalizes to "beat_cuda"). The
# set itself is shared with blab.server, which uses it to say whether its own
# configured solver touches the GPU it reports in /health.
LOCAL_GPU_BACKENDS = GPU_BACKEND_IDS

REMOTE_BACKEND_ID = "server"

GIB = 1024**3


def is_local_gpu_backend(normalized_backend_id: str) -> bool:
    """True if this backend solves on the local machine's GPU memory."""
    normalized = str(normalized_backend_id or "").strip()
    return normalized != REMOTE_BACKEND_ID and backend_uses_gpu(normalized)


def remote_gpu_from_health(health: dict | None) -> dict | None:
    """The remote GPU to size a solve against, or None when there isn't one.

    None covers three different situations that all mean "do not compare":
    no health payload at all, a server whose solver runs on the CPU, and a
    GPU server that does not report its card (an older build, or no
    nvidia-smi). Only the third one deserves a "could not check" warning, which
    is why `vram_report` tests `solver_uses_gpu` separately.
    """
    if not isinstance(health, dict):
        return None
    if not remote_health_uses_gpu(health):
        return None
    return server_health_gpu(health)


def remote_health_uses_gpu(health: dict | None) -> bool:
    """True if the far end's configured solver runs in GPU memory."""
    return server_health_solver_uses_gpu(health)


def vertices_from_triangles(triangles: int) -> int:
    """Fallback P1 unknown count when the real vertex count is unavailable.

    Euler's formula for a triangulated surface gives F ~ 2V.
    """
    return max(1, round(int(triangles) / 2))


def estimate_solve_vram_bytes(
    *,
    triangles: int,
    vertices: int | None = None,
    complex_bytes: int = COMPLEX_BYTES,
    overhead: float = DEFAULT_OVERHEAD,
) -> int:
    """Estimate peak GPU memory for one BEM solve of this mesh, in bytes.

    ``triangles`` and ``vertices`` are the counts of the mesh actually given to
    the solver -- i.e. the symmetry-reduced mesh when solving with symmetry.
    """
    faces = int(triangles)
    if faces <= 0:
        raise ValueError(f"triangles must be positive, got {triangles!r}")
    nodes = int(vertices) if vertices else vertices_from_triangles(faces)
    if nodes <= 0:
        raise ValueError(f"vertices must be positive, got {vertices!r}")
    dense = complex_bytes * (_VF_MATRICES * nodes * faces + _VV_MATRICES * nodes * nodes)
    aux = AUX_BYTES_PER_TRIANGLE * faces
    return int(round(overhead * (dense + aux)))


def format_bytes(value: int | float | None) -> str:
    """Human-readable GiB/MiB, for warning text."""
    if value is None:
        return "unknown"
    if value >= GIB:
        return f"{value / GIB:.2f} GiB"
    return f"{value / (1024**2):.0f} MiB"


def vram_report(
    *,
    triangles: int,
    vertices: int | None,
    backend_id: str,
    symmetry: str = "off",
    gpu: dict | None = None,
    remote_health: dict | None = None,
) -> dict:
    """Estimate, compare against the GPU that will run it, and warn if needed.

    Never raises for capacity reasons and never signals refusal -- the returned
    ``warning`` is advisory text (None when everything looks fine).

    ``gpu`` overrides detection (used by tests and by callers that already
    probed). ``remote_health`` is the far end's ``/health`` payload and is what
    makes the ``server`` backend checkable at all: without it a remote solve is
    sized against nothing and simply reports the estimate.
    """
    estimate = estimate_solve_vram_bytes(triangles=triangles, vertices=vertices)
    remote = str(backend_id or "").strip() == REMOTE_BACKEND_ID
    local_gpu = is_local_gpu_backend(backend_id)
    report: dict = {
        "estimate_bytes": estimate,
        "estimate_human": format_bytes(estimate),
        "backend": backend_id,
        "symmetry": symmetry,
        "solver_triangles": int(triangles),
        "solver_vertices": int(vertices) if vertices else vertices_from_triangles(triangles),
        "local_gpu_backend": local_gpu,
        "gpu": None,
        "gpu_location": None,
        "warning": None,
    }

    if remote:
        return _apply_remote_capacity(report, remote_health=remote_health, gpu=gpu)
    if not local_gpu:
        # Host RAM, not VRAM, on the line: report the estimate, no warning.
        return report
    return _apply_local_capacity(report, gpu=gpu)


def _apply_local_capacity(report: dict, *, gpu: dict | None) -> dict:
    if gpu is None:
        gpu = detect_gpu_memory()
    if gpu is None:
        report["warning"] = (
            "Could not detect local GPU memory (nvidia-smi unavailable), so the "
            f"{report['estimate_human']} estimated for this solve could not be checked against it. "
            "Proceeding anyway; if the solve dies with an out-of-memory error, reduce the mesh or "
            "solve with symmetry."
        )
        return report
    report["gpu"] = gpu
    report["gpu_location"] = "local"
    return _warn_if_over_capacity(report, gpu, where="the local GPU", location="local")


def _apply_remote_capacity(report: dict, *, remote_health: dict | None, gpu: dict | None) -> dict:
    """Size a `server` solve against the far end's card, when it reports one."""
    report["remote_backend"] = server_health_backend_id(remote_health) or None
    if remote_health is None and gpu is None:
        # No probe was made (e.g. a caller that never asked for health). Nothing
        # to compare against and nothing worth complaining about.
        return report
    if remote_health is not None and not remote_health_uses_gpu(remote_health):
        # A CPU solve server has no VRAM limit to blow through.
        return report

    remote_gpu = gpu if gpu is not None else remote_gpu_from_health(remote_health)
    if remote_gpu is None:
        report["warning"] = (
            f"The solve server reports a GPU solver ({report['remote_backend'] or 'unknown backend'}) but no GPU "
            f"details, so the {report['estimate_human']} estimated for this solve could not be checked against it. "
            "Proceeding anyway; if the remote solve dies with an out-of-memory error, reduce the mesh or "
            "solve with symmetry."
        )
        return report

    report["gpu"] = remote_gpu
    report["gpu_location"] = "remote"
    return _warn_if_over_capacity(report, remote_gpu, where="the solve server's GPU", location="remote")


def _warn_if_over_capacity(report: dict, gpu: dict, *, where: str, location: str) -> dict:
    # "Will it fit right now" is the useful question, so prefer free over total.
    # A genuine 0 free is still the right number to compare against, hence the
    # explicit None check rather than an `or`.
    free_bytes = gpu.get("free_bytes")
    which = "free" if isinstance(free_bytes, int) else "total"
    capacity = free_bytes if which == "free" else gpu.get("total_bytes")
    estimate = report["estimate_bytes"]
    if not isinstance(capacity, int) or estimate <= capacity:
        return report

    symmetry = report["symmetry"]
    hint = (
        "Coarsen the mesh or solve with symmetry (halving the element count quarters the memory)."
        if symmetry == "off"
        else "Coarsen the mesh; symmetry is already reducing the element count."
    )
    report["warning"] = (
        f"Estimated peak GPU memory {report['estimate_human']} exceeds the {which} VRAM on "
        f"{gpu.get('name', where)} ({format_bytes(capacity)}"
        + (f" free of {format_bytes(gpu.get('total_bytes'))}" if which == "free" else "")
        + (" on the solve server" if location == "remote" else "")
        + f"). Solving {report['solver_triangles']} triangles / {report['solver_vertices']} nodes with "
        f"symmetry='{symmetry}' on backend '{report['backend']}' may fail with a CUDA out-of-memory error. "
        f"Running anyway. {hint}"
    )
    return report
