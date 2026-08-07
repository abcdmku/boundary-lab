"""GPU capacity probe shared by the solve server and the bridge CLI.

This lives in ``blab`` rather than ``bridge/py`` because both sides need it:
``blab.server`` reports the *serving* machine's GPU in its ``/health`` payload,
and ``bridge/py/vram.py`` compares a solve's estimated peak against whichever
GPU will actually run it -- the local one for ``beat_*`` backends, or the
remote one (read out of ``/health``) for the ``server`` backend.

Nothing here ever decides that a solve is too big. A ``None`` return means
"unknown", never "too small".
"""

from __future__ import annotations

import re
import shutil
import subprocess

# Solver backend ids that consume GPU memory. `beat_cpu` and `local` (bempp-cl
# OpenCL) run on host RAM; `server` is whatever the far end is configured with,
# which is why the health payload reports its own backend id.
GPU_BACKEND_IDS = frozenset({"beat_cuda", "beat_rocm"})

_MIB = 1024**2
_NUMERIC = re.compile(r"\d+(\.\d+)?")


def detect_gpu_memory() -> dict | None:
    """Query the first NVIDIA GPU via nvidia-smi.

    Returns ``{"name", "total_bytes", "free_bytes"}``, or None when nvidia-smi
    is missing, fails, or returns nothing parseable (no NVIDIA GPU, an AMD/ROCm
    box, a driver hiccup). Callers must treat None as "unknown".
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
        if not _NUMERIC.fullmatch(total_mib):
            continue
        free_bytes = int(float(free_mib) * _MIB) if _NUMERIC.fullmatch(free_mib) else None
        return {
            "name": name,
            "total_bytes": int(float(total_mib) * _MIB),
            "free_bytes": free_bytes,
        }
    return None


def backend_uses_gpu(backend_id: str) -> bool:
    """True if this solver backend id solves in GPU memory."""
    return str(backend_id or "").strip() in GPU_BACKEND_IDS
