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

import os
import re
import shutil
import subprocess

# Solver backend ids that consume GPU memory. `beat_cpu` and `local` (bempp-cl
# OpenCL) run on host RAM; `server` is whatever the far end is configured with,
# which is why the health payload reports its own backend id.
GPU_BACKEND_IDS = frozenset({"beat_cuda", "beat_rocm"})

_MIB = 1024**2
_NUMERIC = re.compile(r"\d+(\.\d+)?")


def visible_device_selector(environ: dict | None = None) -> str | None:
    """The CUDA device the solver will actually use, as CUDA_VISIBLE_DEVICES names it.

    Returns the first entry of ``CUDA_VISIBLE_DEVICES`` -- an index like ``"1"``
    or a ``GPU-...``/``MIG-...`` UUID -- because that is what CUDA presents as
    device 0, which is what CUDA.jl picks up. ``None`` means the variable is
    unset and every GPU is visible in nvidia-smi's own order. An empty value is
    returned as ``""``: CUDA sees no devices at all.
    """
    raw = (environ if environ is not None else os.environ).get("CUDA_VISIBLE_DEVICES")
    if raw is None:
        return None
    entries = [entry.strip() for entry in str(raw).split(",")]
    return entries[0] if entries and entries[0] else ""


def _row_matches(selector: str, index: str, uuid: str) -> bool:
    if selector.isdigit():
        return index == selector
    # UUIDs may be given in an abbreviated form, which the driver accepts.
    return bool(uuid) and uuid.startswith(selector)


def detect_gpu_memory(environ: dict | None = None) -> dict | None:
    """Query the NVIDIA GPU the solver will use, via nvidia-smi.

    Returns ``{"name", "total_bytes", "free_bytes"}``, or None when nvidia-smi
    is missing, fails, or returns nothing parseable (no NVIDIA GPU, an AMD/ROCm
    box, a driver hiccup). Callers must treat None as "unknown".

    On a multi-GPU box -- a rented one, typically -- ``CUDA_VISIBLE_DEVICES``
    decides which card the solve lands on, and it is frequently not physical GPU
    0. Reporting the wrong card would be worse than reporting nothing: it would
    suppress a real out-of-memory warning on a smaller card, or invent one on a
    larger. So an unmatched or empty selector returns None rather than falling
    back to the first row.
    """
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    selector = visible_device_selector(environ)
    if selector == "":
        return None
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, resolved executable
            [exe, "--query-gpu=index,uuid,name,memory.total,memory.free", "--format=csv,noheader,nounits"],
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
        if len(fields) < 5:
            continue
        index, uuid, name, total_mib, free_mib = fields[0], fields[1], fields[2], fields[3], fields[4]
        if not _NUMERIC.fullmatch(total_mib):
            continue
        if selector is not None and not _row_matches(selector, index, uuid):
            continue
        free_bytes = int(float(free_mib) * _MIB) if _NUMERIC.fullmatch(free_mib) else None
        return {
            "name": name,
            "index": int(index) if index.isdigit() else None,
            "uuid": uuid or None,
            "total_bytes": int(float(total_mib) * _MIB),
            "free_bytes": free_bytes,
        }
    return None


def backend_uses_gpu(backend_id: str) -> bool:
    """True if this solver backend id solves in GPU memory."""
    return str(backend_id or "").strip() in GPU_BACKEND_IDS
