"""Boundary Lab HTTP solve-server backend client.

The same client drives a server on localhost and a server on another machine:
the whole solve request (config + mesh assets, base64-inlined) goes up with
``POST /jobs`` and results stream back as NDJSON, so the far end never needs the
client's filesystem. What makes the remote case different is only that the link
can break, and that the far end's capabilities are not knowable from the local
registry -- both handled here.

Capability negotiation is deliberately health-driven rather than table-driven.
The static registry entry for the ``server`` backend cannot know what the far
end is configured with: a server running ``--solver beat_cuda`` supports
symmetry, one running ``--solver bempp_cpu`` does not. Sending a
symmetry-reduced mesh to a server that will not reconstruct the reflections
produces plausible-looking but wrong pressures, so a reduced mesh is only ever
submitted after ``GET /health`` affirmatively advertises
``capabilities.supports_symmetry``. An unreachable or silent server is treated
as "no", never as "probably fine".
"""

from __future__ import annotations

import http.client
import json
import time
from typing import Callable, Iterator
from urllib import error, parse, request

import numpy as np

from blab.protocol import (
    frequency_result_from_dict,
    ndarray_from_wire,
    solve_request_from_config_and_frequencies,
)
from blab.solvers.base import (
    FrequencyResult,
    SolveMetadata,
    SolverCapabilities,
    SolveRequest,
)

DEFAULT_SERVER_URL = "http://127.0.0.1:8765"
ALLOWED_SCHEMES = ("http", "https")

# Short, bounded waits for the small request/response endpoints.
DEFAULT_REQUEST_TIMEOUT_S = 30.0
DEFAULT_HEALTH_TIMEOUT_S = 5.0

# The events stream is long-lived and mostly idle: a single 20k-element
# frequency step can take minutes with nothing to report. The server emits a
# heartbeat line while it waits, so an idle stretch this long means the link is
# genuinely gone rather than the solve merely being slow.
DEFAULT_STREAM_IDLE_TIMEOUT_S = 120.0
DEFAULT_STREAM_RETRIES = 5
_MAX_RECONNECT_DELAY_S = 15.0

_TERMINAL_EVENT_TYPES = frozenset({"completed", "cancelled", "failed"})

# URLError and its friends are all OSError subclasses; HTTPError is caught
# first because a 4xx is an answer, not a dropped link.
_TRANSIENT_STREAM_ERRORS = (TimeoutError, http.client.HTTPException, OSError)


def normalize_server_url(server_url: str | None, *, default: str | None = DEFAULT_SERVER_URL) -> str:
    """Validate and canonicalize a solve server URL.

    Accepts ``http``/``https`` with a host and optional port and base path;
    strips trailing slashes so callers can append ``/jobs`` unconditionally.
    Raises ``ValueError`` with an actionable message for anything else -- a bad
    URL should fail at argument-parse time, not halfway through a solve.
    """
    text = str(server_url or "").strip()
    if not text:
        text = str(default or "").strip()
    if not text:
        raise ValueError("A solve server URL is required.")
    if "://" not in text:
        raise ValueError(f"Solve server URL {text!r} has no scheme; use http://host:port or https://host:port.")

    parsed = parse.urlparse(text)
    scheme = parsed.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise ValueError(f"Solve server URL {text!r} must use http:// or https://, not {parsed.scheme}://.")
    if parsed.username or parsed.password:
        raise ValueError(
            f"Solve server URL {text!r} must not embed credentials; pass a bearer token separately instead."
        )
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f"Solve server URL {text!r} has an invalid port.") from exc
    host = parsed.hostname
    if not host:
        raise ValueError(f"Solve server URL {text!r} has no host.")
    if parsed.query or parsed.fragment:
        raise ValueError(f"Solve server URL {text!r} must not include a query string or fragment.")

    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc = f"{netloc}:{port}"
    return parse.urlunparse((scheme, netloc, parsed.path.rstrip("/"), "", "", ""))


class HttpServerSession:
    def __init__(
        self,
        request_payload: SolveRequest,
        server_url: str,
        *,
        auth_token: str | None = None,
        request_timeout_s: float = DEFAULT_REQUEST_TIMEOUT_S,
        stream_idle_timeout_s: float = DEFAULT_STREAM_IDLE_TIMEOUT_S,
        stream_retries: int = DEFAULT_STREAM_RETRIES,
    ):
        self.request_payload = request_payload
        self.server_url = normalize_server_url(server_url)
        self.auth_token = str(auth_token or "").strip() or None
        self.request_timeout_s = float(request_timeout_s)
        self.stream_idle_timeout_s = float(stream_idle_timeout_s)
        self.stream_retries = max(0, int(stream_retries))
        self.job_id: str | None = None
        self._stop = False
        self._cancel_sent = False
        self._response = None
        self._events: Iterator[dict] | None = None
        self._metadata: SolveMetadata | None = None
        self._next_index = 0
        self._terminal_seen = False
        self._submit_and_initialize()

    @property
    def metadata(self) -> SolveMetadata:
        if self._metadata is None:
            raise RuntimeError("Server session has not initialized.")
        return self._metadata

    def solve_stream(
        self,
        *,
        stop_requested: Callable[[], bool] | None = None,
    ) -> Iterator[FrequencyResult]:
        if self._events is None:
            return

        try:
            for event in self._events:
                if self._stop or (stop_requested is not None and stop_requested()):
                    self.stop()

                event_type = str(event.get("type", ""))
                if event_type == "result":
                    yield frequency_result_from_dict(event["result"])
                elif event_type == "cancelling":
                    self._emit_status("Server cancellation requested...")
                elif event_type == "cancelled":
                    self._emit_status("Server job cancelled")
                    return
                elif event_type == "completed":
                    self._emit_status("Server job complete")
                    return
                elif event_type == "failed":
                    raise RuntimeError(str(event.get("error", "Server job failed.")))
        finally:
            self._close_response()

    def stop(self) -> None:
        """Ask the server to cancel this job. Idempotent: cancel is POSTed once."""
        self._stop = True
        if self.job_id is None or self._cancel_sent:
            return
        self._cancel_sent = True
        try:
            self._post_json(f"/jobs/{self.job_id}/cancel", {})
            self._emit_status("Stop requested on server; waiting for current frequency...")
        except Exception as exc:
            # Let a failed cancel be retried on the next pass rather than
            # leaving a remote job running because one POST was unlucky.
            self._cancel_sent = False
            self._emit_status(f"Stop request failed: {exc}")

    def _submit_and_initialize(self) -> None:
        self._emit_status(f"Submitting job to {self.server_url}...")
        job = self._post_json(
            "/jobs",
            solve_request_from_config_and_frequencies(
                self.request_payload.config,
                self.request_payload.frequencies_hz,
                include_assets=True,
            ),
        )
        self.job_id = str(job["job_id"])
        self._emit_status(f"Server job {self.job_id[:8]} queued")

        self._response = self._open_event_stream(0)
        self._events = self._iter_events()

        for event in self._events:
            event_type = str(event.get("type", ""))
            if event_type == "queued":
                self._emit_status("Server job queued")
            elif event_type == "started":
                self._emit_status("Server job started")
            elif event_type == "initialized":
                sphere_metadata = event.get("sphere_metadata") or {}
                self._metadata = SolveMetadata(
                    polar_angle_deg=ndarray_from_wire(event["polar_angle_deg"]),
                    radiator_names=np.asarray(event.get("radiator_names", ["Radiator"])),
                    sphere_metadata={key: ndarray_from_wire(value) for key, value in sphere_metadata.items()},
                )
                self._emit_status("Solving on server...")
                return
            elif event_type == "cancelled":
                raise RuntimeError("Server job cancelled before initialization.")
            elif event_type == "completed":
                raise RuntimeError("Server job completed before initialization.")
            elif event_type == "failed":
                raise RuntimeError(str(event.get("error", "Server job failed.")))

        raise RuntimeError("Server event stream ended before initialization.")

    def _open_event_stream(self, since: int):
        return request.urlopen(
            self._build_request(f"/jobs/{self.job_id}/events?since={int(since)}"),
            timeout=self.stream_idle_timeout_s,
        )

    def _read_stream(self) -> Iterator[dict]:
        """Decode one connection's worth of NDJSON, tracking the resume point."""
        for raw_line in self._response:
            line = raw_line.strip()
            if not line:
                continue
            event = json.loads(line.decode("utf-8"))
            event_type = str(event.get("type", ""))
            if event_type == "heartbeat":
                # Liveness only; heartbeats are not stored events and carry no
                # index, so they must not move the resume point.
                continue
            index = event.get("index")
            if isinstance(index, int):
                self._next_index = index + 1
            if event_type in _TERMINAL_EVENT_TYPES:
                self._terminal_seen = True
            yield event

    def _iter_events(self) -> Iterator[dict]:
        """Job events, resuming from the last seen index across dropped links.

        ``GET /jobs/{id}/events?since=N`` replays the server's stored event log,
        so a reconnect loses nothing: a solve that ran for an hour survives a
        NAT timeout or a laptop lid. Only genuinely transient failures are
        retried -- an HTTP status is an answer and stops the loop.
        """
        attempt = 0
        while True:
            failure: Exception | None = None
            progressed_from = self._next_index

            if self._response is None:
                try:
                    self._response = self._open_event_stream(self._next_index)
                except error.HTTPError as exc:
                    detail = exc.read().decode("utf-8", errors="replace")
                    raise RuntimeError(f"Could not resume server job {self.job_id}: HTTP {exc.code}: {detail}") from exc
                except _TRANSIENT_STREAM_ERRORS as exc:
                    self._response = None
                    failure = exc

            if failure is None:
                try:
                    yield from self._read_stream()
                except _TRANSIENT_STREAM_ERRORS as exc:
                    failure = exc
                except json.JSONDecodeError as exc:
                    failure = exc
                self._close_response()

            if self._terminal_seen or self._stop:
                return

            attempt = 0 if self._next_index > progressed_from else attempt + 1
            if self.stream_retries <= 0 or attempt > self.stream_retries:
                reason = f": {failure}" if failure is not None else " (stream closed early)"
                raise RuntimeError(
                    f"Lost the event stream for server job {self.job_id} at {self.server_url} after "
                    f"{self.stream_retries} reconnect attempts{reason}. The job may still be running; "
                    f"check GET {self.server_url}/jobs/{self.job_id}."
                )
            delay = min(2.0 ** (max(attempt, 1) - 1), _MAX_RECONNECT_DELAY_S)
            self._emit_status(
                "Server event stream interrupted"
                + (f" ({failure})" if failure is not None else "")
                + f"; reconnecting from event {self._next_index} in {delay:.0f}s "
                f"(attempt {attempt or 1}/{self.stream_retries})"
            )
            time.sleep(delay)

    def _build_request(self, path: str, *, data: bytes | None = None, method: str = "GET") -> request.Request:
        headers = {}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        return request.Request(f"{self.server_url}{path}", data=data, headers=headers, method=method)

    def _post_json(self, path: str, payload: dict) -> dict:
        req = self._build_request(path, data=json.dumps(payload).encode("utf-8"), method="POST")
        try:
            with request.urlopen(req, timeout=self.request_timeout_s) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Server returned HTTP {exc.code}: {detail}") from exc

    def _emit_status(self, message: str) -> None:
        if self.request_payload.status_callback is not None:
            self.request_payload.status_callback(message)

    def _close_response(self) -> None:
        if self._response is not None:
            try:
                self._response.close()
            except Exception:
                pass
            self._response = None


def query_server_health(
    server_url: str,
    *,
    timeout_s: float = DEFAULT_HEALTH_TIMEOUT_S,
    auth_token: str | None = None,
) -> dict:
    normalized_url = normalize_server_url(server_url)
    headers = {"Authorization": f"Bearer {auth_token}"} if str(auth_token or "").strip() else {}
    req = request.Request(f"{normalized_url}/health", headers=headers, method="GET")
    with request.urlopen(req, timeout=timeout_s) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("Solve server health response was not a JSON object.")
    return payload


def server_health_capabilities(payload: dict | None) -> dict:
    if not isinstance(payload, dict):
        return {}
    capabilities = payload.get("capabilities")
    return capabilities if isinstance(capabilities, dict) else {}


def server_health_supports_symmetry(payload: dict | None) -> bool:
    return bool(server_health_capabilities(payload).get("supports_symmetry"))


def server_health_backend_id(payload: dict | None) -> str:
    """The solver backend id the far end is actually running (e.g. ``beat_cuda``)."""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("backend") or payload.get("solver") or "").strip()


def server_health_gpu(payload: dict | None) -> dict | None:
    """The serving machine's GPU block, when the server reports one."""
    if not isinstance(payload, dict):
        return None
    gpu = payload.get("gpu")
    if not isinstance(gpu, dict) or not gpu:
        return None
    return gpu


def server_health_solver_uses_gpu(payload: dict | None) -> bool:
    """Whether the far end's configured solver runs in GPU memory.

    Servers predating the ``solver_uses_gpu`` flag are read from their backend
    id instead. This matters because a CPU solve server can perfectly well have
    a GPU in the box; reporting that card as the solve's capacity would be
    actively misleading.
    """
    if not isinstance(payload, dict):
        return False
    declared = payload.get("solver_uses_gpu")
    if isinstance(declared, bool):
        return declared
    from blab.gpu import backend_uses_gpu

    return backend_uses_gpu(server_health_backend_id(payload))


def server_health_summary(payload: dict | None) -> str:
    """One-line description of a health payload, for status text and errors."""
    backend = server_health_backend_id(payload) or "unknown"
    label = str((payload or {}).get("solver_label") or "").strip()
    symmetry = "yes" if server_health_supports_symmetry(payload) else "no"
    gpu = server_health_gpu(payload) if server_health_solver_uses_gpu(payload) else None
    gpu_text = f", gpu={gpu.get('name')}" if gpu else ""
    return f"solver={backend}" + (f" ({label})" if label else "") + f", symmetry={symmetry}{gpu_text}"


class HttpServerBackend:
    backend_id = "server"
    label = "Server"
    capabilities = SolverCapabilities(
        supports_remote_assets=True,
        supports_parallel_workers=True,
        is_remote=True,
    )

    def __init__(
        self,
        server_url: str = DEFAULT_SERVER_URL,
        *,
        auth_token: str | None = None,
        request_timeout_s: float = DEFAULT_REQUEST_TIMEOUT_S,
        health_timeout_s: float = DEFAULT_HEALTH_TIMEOUT_S,
        stream_idle_timeout_s: float = DEFAULT_STREAM_IDLE_TIMEOUT_S,
        stream_retries: int = DEFAULT_STREAM_RETRIES,
    ):
        self.server_url = normalize_server_url(server_url)
        self.auth_token = str(auth_token or "").strip() or None
        self.request_timeout_s = float(request_timeout_s)
        self.health_timeout_s = float(health_timeout_s)
        self.stream_idle_timeout_s = float(stream_idle_timeout_s)
        self.stream_retries = max(0, int(stream_retries))
        self._health: dict | None = None

    def health(self, *, refresh: bool = False) -> dict:
        """The far end's ``/health`` payload, probed once and cached.

        Raises when the server cannot be reached: an unknown server is never
        assumed to be capable.
        """
        if self._health is None or refresh:
            try:
                self._health = query_server_health(
                    self.server_url,
                    timeout_s=self.health_timeout_s,
                    auth_token=self.auth_token,
                )
            except Exception as exc:
                raise RuntimeError(f"Could not query solve server capabilities at {self.server_url}: {exc}") from exc
        return self._health

    @property
    def cached_health(self) -> dict | None:
        """The last probed payload, or None if this backend has not probed yet."""
        return self._health

    def supports_symmetry(self) -> bool:
        return server_health_supports_symmetry(self.health())

    def effective_capabilities(self) -> SolverCapabilities:
        """Static capabilities overlaid with what this particular server advertises.

        The registry entry describes the *protocol* the ``server`` backend
        speaks; only ``/health`` knows what the far end can compute.
        """
        from dataclasses import replace

        advertised = server_health_capabilities(self.health())
        overlay = {
            field: bool(advertised[field])
            for field in (
                "supports_spherical_sampling",
                "supports_impedance",
                "supports_burton_miller",
                "supports_flat_target_normalization",
                "supports_channel_resynthesis",
                "supports_cancellation",
                "supports_streaming",
                "supports_symmetry",
            )
            if field in advertised
        }
        return replace(self.capabilities, **overlay)

    def create_session(self, request_payload: SolveRequest) -> HttpServerSession:
        symmetry = request_payload.config.symmetry
        if symmetry != "off":
            # The mesh in this request is the fundamental domain, not the whole
            # radiator. Only submit it once the server has said, in this probe,
            # that it will reconstruct the reflections.
            payload = self.health(refresh=True)
            if not server_health_supports_symmetry(payload):
                raise RuntimeError(
                    f"The solve server at {self.server_url} does not advertise symmetry support "
                    f"({server_health_summary(payload)}), so it cannot be sent the symmetry='{symmetry}' "
                    "reduced mesh. Solve with symmetry='off' on the full mesh, or point --server-url at a "
                    "server started with --solver beat_cuda / beat_cpu."
                )
        return HttpServerSession(
            request_payload,
            self.server_url,
            auth_token=self.auth_token,
            request_timeout_s=self.request_timeout_s,
            stream_idle_timeout_s=self.stream_idle_timeout_s,
            stream_retries=self.stream_retries,
        )
