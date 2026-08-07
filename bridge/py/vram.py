"""VRAM estimation for BEM solves, and detection of the local GPU's capacity.

Nothing here ever blocks a solve. Mesh size is a hardware-capacity question,
not a correctness one: we estimate what the solve will need, compare it with
what the local GPU actually has, and warn. The solve proceeds either way.

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

import re
import shutil
import subprocess

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
# normalize before asking (e.g. "julia_local" normalizes to "beat_cuda").
LOCAL_GPU_BACKENDS = frozenset({"beat_cuda", "beat_rocm"})

GIB = 1024**3


def is_local_gpu_backend(normalized_backend_id: str) -> bool:
    """True if this backend solves on the local machine's GPU memory."""
    return str(normalized_backend_id or "").strip() in LOCAL_GPU_BACKENDS


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


def detect_gpu_memory() -> dict | None:
    """Query the local NVIDIA GPU via nvidia-smi.

    Returns ``{"name", "total_bytes", "free_bytes"}`` for the first GPU, or
    None when nvidia-smi is missing, fails, or returns nothing parseable (no
    NVIDIA GPU, an AMD/ROCm box, a driver hiccup). Callers must treat None as
    "unknown", never as "too small".
    """
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, resolved executable
            [exe, "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    for line in completed.stdout.splitlines():
        fields = [field.strip() for field in line.split(",")]
        if len(fields) < 3:
            continue
        name, total_mib, free_mib = fields[0], fields[1], fields[2]
        if not re.fullmatch(r"\d+(\.\d+)?", total_mib):
            continue
        free_bytes = int(float(free_mib) * 1024**2) if re.fullmatch(r"\d+(\.\d+)?", free_mib) else None
        return {
            "name": name,
            "total_bytes": int(float(total_mib) * 1024**2),
            "free_bytes": free_bytes,
        }
    return None


def vram_report(
    *,
    triangles: int,
    vertices: int | None,
    backend_id: str,
    symmetry: str = "off",
    gpu: dict | None = None,
) -> dict:
    """Estimate, compare against the local GPU, and build a warning if needed.

    Never raises for capacity reasons and never signals refusal -- the returned
    ``warning`` is advisory text (None when everything looks fine).
    """
    estimate = estimate_solve_vram_bytes(triangles=triangles, vertices=vertices)
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
        "warning": None,
    }
    if not local_gpu:
        # Not this machine's VRAM on the line: report the estimate, no warning.
        return report

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
    # "Will it fit right now" is the useful question, so prefer free over total.
    # A genuine 0 free is still the right number to compare against, hence the
    # explicit None check rather than an `or`.
    free_bytes = gpu.get("free_bytes")
    which = "free" if isinstance(free_bytes, int) else "total"
    capacity = free_bytes if which == "free" else gpu.get("total_bytes")
    if not isinstance(capacity, int) or estimate <= capacity:
        return report

    hint = (
        "Coarsen the mesh or solve with symmetry (halving the element count quarters the memory)."
        if symmetry == "off"
        else "Coarsen the mesh; symmetry is already reducing the element count."
    )
    report["warning"] = (
        f"Estimated peak GPU memory {report['estimate_human']} exceeds the {which} VRAM on "
        f"{gpu.get('name', 'the local GPU')} ({format_bytes(capacity)}"
        + (f" free of {format_bytes(gpu.get('total_bytes'))}" if which == "free" else "")
        + f"). Solving {report['solver_triangles']} triangles / {report['solver_vertices']} nodes with "
        f"symmetry='{symmetry}' on backend '{backend_id}' may fail with a CUDA out-of-memory error. "
        f"Running anyway. {hint}"
    )
    return report
