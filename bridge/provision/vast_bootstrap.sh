#!/usr/bin/env bash
#
# Boundary Lab solver bootstrap for a rented vast.ai GPU instance.
#
# Turns a bare CUDA container into a running `blab server --solver beat_cuda`.
# Mirrors docker/server-cuda.Dockerfile, but installs into a cache root on the
# instance's persistent disk so re-running on a reused instance is fast.
#
# INVOCATION
#   The bridge pipes this file over SSH and runs it with configuration in the
#   environment (see bridge/src/vast/provision.ts):
#
#     ssh root@host 'cat > /tmp/blab_bootstrap.sh' < vast_bootstrap.sh
#     ssh root@host 'BLAB_SERVER_PORT=8765 ... bash /tmp/blab_bootstrap.sh'
#
# CONTRACT
#   - Idempotent. Every slow stage is guarded by a stamp file holding a
#     fingerprint of its inputs; a stage whose fingerprint is unchanged is
#     skipped. BLAB_FORCE=1 invalidates every stamp.
#   - Streams machine-readable progress markers on stdout so the bridge can
#     turn them into UI progress without parsing prose:
#       ::blab:stage:<name>:<message>   entering a stage
#       ::blab:skip:<name>:<message>    stage satisfied by the cache
#       ::blab:ok:<name>                stage finished
#       ::blab:fail:<name>:<message>    stage failed (script then exits non-zero)
#       ::blab:result:<json>            final summary, exactly once, on success
#     Everything else on stdout/stderr is raw tool output for the log.
#   - Exit status is non-zero on any failure, with the failing stage named.
#
# SAFETY
#   Reads no credentials and writes none. Only ever touches $BLAB_CACHE_ROOT,
#   /tmp, and apt. Never destroys or bills anything — the instance is already
#   rented by the time this runs.

set -euo pipefail

# ---------------------------------------------------------------------------
# configuration (all overridable from the environment)
# ---------------------------------------------------------------------------
BLAB_CACHE_ROOT="${BLAB_CACHE_ROOT:-/workspace/blab}"
BLAB_REPO_URL="${BLAB_REPO_URL:-https://github.com/abcdmku/boundary-lab.git}"
BLAB_REPO_REF="${BLAB_REPO_REF:-main}"
BLAB_SERVER_PORT="${BLAB_SERVER_PORT:-8765}"
BLAB_SERVER_HOST="${BLAB_SERVER_HOST:-0.0.0.0}"
BLAB_SOLVER="${BLAB_SOLVER:-beat_cuda}"
BLAB_JULIA_CHANNEL="${BLAB_JULIA_CHANNEL:-release}"
BLAB_JULIA_THREADS="${BLAB_JULIA_THREADS:-auto}"
BLAB_WARM_SOLVER="${BLAB_WARM_SOLVER:-off}"
BLAB_MAX_RUNNING_JOBS="${BLAB_MAX_RUNNING_JOBS:-1}"
BLAB_LOG_LEVEL="${BLAB_LOG_LEVEL:-INFO}"
# The CUDA runtime the Julia CUDA.jl artifacts are pinned to. Must be <= the
# host driver's max supported version (read back from nvidia-smi below).
BLAB_CUDA_RUNTIME="${BLAB_CUDA_RUNTIME:-12.6}"
# Sysimage build is 20+ minutes and the cached depot already gives us most of
# the win, so it is opt-in.
BLAB_BUILD_SYSIMAGE="${BLAB_BUILD_SYSIMAGE:-0}"
BLAB_FORCE="${BLAB_FORCE:-0}"
# Seconds to wait for the server to answer /health after launch. A cold Julia
# start with CUDA precompilation already done is usually well under a minute.
BLAB_HEALTH_TIMEOUT="${BLAB_HEALTH_TIMEOUT:-300}"

REPO_DIR="${BLAB_CACHE_ROOT}/boundary-lab"
VENV_DIR="${BLAB_CACHE_ROOT}/venv"
JULIAUP_DIR="${BLAB_CACHE_ROOT}/juliaup"
JULIA_DEPOT="${BLAB_CACHE_ROOT}/julia-depot"
STAMP_DIR="${BLAB_CACHE_ROOT}/.stamps"
ARTIFACT_DIR="${BLAB_CACHE_ROOT}/server_jobs"
SERVER_LOG="${BLAB_CACHE_ROOT}/server.log"
PID_FILE="${BLAB_CACHE_ROOT}/server.pid"
SYSIMAGE_PATH="${BLAB_CACHE_ROOT}/blab-beat-cuda.so"
JULIA_PROJECT_DIR="${REPO_DIR}/src/blab/solvers/julia_cuda"
JULIA_BIN="${JULIAUP_DIR}/bin/julia"

export JULIAUP_HOME="${JULIAUP_DIR}"
export JULIA_DEPOT_PATH="${JULIA_DEPOT}"
export DEBIAN_FRONTEND=noninteractive
export PIP_NO_CACHE_DIR=1

CURRENT_STAGE="init"

# ---------------------------------------------------------------------------
# marker + stamp helpers
# ---------------------------------------------------------------------------
stage()  { CURRENT_STAGE="$1"; printf '::blab:stage:%s:%s\n' "$1" "${2:-}"; }
skip()   { printf '::blab:skip:%s:%s\n' "$1" "${2:-}"; }
ok()     { printf '::blab:ok:%s\n' "$1"; }
note()   { printf '[bootstrap] %s\n' "$*"; }

# Any non-zero exit anywhere names the stage it happened in, so the bridge can
# report "julia stage failed" instead of "exit 1".
on_error() {
    local code=$?
    printf '::blab:fail:%s:exited with status %s\n' "${CURRENT_STAGE}" "${code}"
    exit "${code}"
}
trap on_error ERR

# A stage is satisfied when its stamp file exists and matches the fingerprint
# of its inputs. Fingerprints are cheap strings (a git rev, a file checksum) —
# never timestamps, which would defeat caching across reboots.
stamp_file() { printf '%s/%s' "${STAMP_DIR}" "$1"; }
stamp_matches() {
    [ "${BLAB_FORCE}" = "1" ] && return 1
    local file; file="$(stamp_file "$1")"
    [ -f "${file}" ] && [ "$(cat "${file}")" = "$2" ]
}
stamp_write() { mkdir -p "${STAMP_DIR}"; printf '%s' "$2" > "$(stamp_file "$1")"; }

checksum() { sha256sum "$@" 2>/dev/null | sha256sum | cut -d' ' -f1; }

# ---------------------------------------------------------------------------
# stage: preflight — GPU visible, base packages present
# ---------------------------------------------------------------------------
stage preflight "checking GPU and base packages"
mkdir -p "${BLAB_CACHE_ROOT}" "${STAMP_DIR}" "${ARTIFACT_DIR}"

if ! command -v nvidia-smi >/dev/null 2>&1; then
    printf '::blab:fail:preflight:nvidia-smi not found — this image has no CUDA runtime\n'
    exit 1
fi
if ! nvidia-smi >/dev/null 2>&1; then
    printf '::blab:fail:preflight:nvidia-smi failed — no GPU is visible to this container\n'
    exit 1
fi
GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1 | tr -d '\r')"
GPU_VRAM_MIB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1 | tr -d '\r')"
DRIVER_CUDA="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1 | tr -d '\r')"
note "GPU: ${GPU_NAME} (${GPU_VRAM_MIB} MiB, driver ${DRIVER_CUDA})"

APT_PACKAGES="ca-certificates curl g++ gcc git python3 python3-pip python3-venv"
APT_FINGERPRINT="$(printf '%s' "${APT_PACKAGES}" | sha256sum | cut -d' ' -f1)"
if stamp_matches apt "${APT_FINGERPRINT}"; then
    skip apt "base packages already installed"
else
    note "installing base packages: ${APT_PACKAGES}"
    apt-get update -qq
    # shellcheck disable=SC2086
    apt-get install -y -qq --no-install-recommends ${APT_PACKAGES}
    rm -rf /var/lib/apt/lists/*
    stamp_write apt "${APT_FINGERPRINT}"
fi
# vast drops interactive shells into tmux, which mangles non-interactive runs.
touch "${HOME}/.no_auto_tmux" 2>/dev/null || true
ok preflight

# ---------------------------------------------------------------------------
# stage: repo — clone or fast-forward the solver source
# ---------------------------------------------------------------------------
stage repo "fetching ${BLAB_REPO_URL} @ ${BLAB_REPO_REF}"
if [ -d "${REPO_DIR}/.git" ]; then
    git -C "${REPO_DIR}" remote set-url origin "${BLAB_REPO_URL}"
    git -C "${REPO_DIR}" fetch --depth 1 origin "${BLAB_REPO_REF}"
else
    rm -rf "${REPO_DIR}"
    git clone --depth 1 --branch "${BLAB_REPO_REF}" "${BLAB_REPO_URL}" "${REPO_DIR}"
fi
# Detach onto the fetched commit: works for a branch, tag, or raw SHA and
# leaves no local branch state to drift between provisioning runs.
git -C "${REPO_DIR}" checkout --detach FETCH_HEAD 2>/dev/null \
    || git -C "${REPO_DIR}" checkout --detach "${BLAB_REPO_REF}"
REPO_REV="$(git -C "${REPO_DIR}" rev-parse HEAD)"
note "repo at ${REPO_REV}"
ok repo

# ---------------------------------------------------------------------------
# stage: python — venv + editable install of the blab package
# ---------------------------------------------------------------------------
stage python "installing the blab python package"
PY_FINGERPRINT="$(checksum "${REPO_DIR}/pyproject.toml")"
if [ -x "${VENV_DIR}/bin/blab" ] && stamp_matches python "${PY_FINGERPRINT}"; then
    skip python "venv already matches pyproject.toml"
else
    [ -d "${VENV_DIR}" ] || python3 -m venv "${VENV_DIR}"
    "${VENV_DIR}/bin/pip" install --quiet --upgrade pip setuptools wheel
    # Editable so a later `git fetch` of the repo takes effect without a
    # reinstall — the whole point of caching this on the persistent disk.
    "${VENV_DIR}/bin/pip" install --quiet -e "${REPO_DIR}"
    stamp_write python "${PY_FINGERPRINT}"
fi
"${VENV_DIR}/bin/python" -c 'import blab; print("[bootstrap] blab import ok")'
ok python

# ---------------------------------------------------------------------------
# stage: julia — juliaup, the CUDA project, and precompilation
# ---------------------------------------------------------------------------
stage julia "installing Julia and the CUDA solver project"
if [ -x "${JULIA_BIN}" ]; then
    skip julia-install "juliaup already present"
else
    note "installing juliaup (channel ${BLAB_JULIA_CHANNEL})"
    curl -fsSL https://install.julialang.org \
        | sh -s -- -y --path "${JULIAUP_DIR}" --default-channel "${BLAB_JULIA_CHANNEL}"
fi
export PATH="${JULIAUP_DIR}/bin:${PATH}"
"${JULIA_BIN}" --version

# The depot is the expensive artifact (CUDA.jl ships hundreds of MB of
# artifacts and precompiles for minutes). Fingerprint it on the project files
# plus the pinned runtime so only a real dependency change pays that cost.
JULIA_FINGERPRINT="$(checksum "${JULIA_PROJECT_DIR}/Project.toml" "${JULIA_PROJECT_DIR}/Manifest.toml")-${BLAB_CUDA_RUNTIME}"
if stamp_matches julia "${JULIA_FINGERPRINT}"; then
    skip julia "depot already instantiated for this Manifest"
else
    note "instantiating the Julia CUDA project (first run takes several minutes)"
    "${JULIA_BIN}" --project="${JULIA_PROJECT_DIR}" --startup-file=no -e \
        "using Pkg; Pkg.instantiate(); using CUDA; CUDA.set_runtime_version!(v\"${BLAB_CUDA_RUNTIME}\")"
    # set_runtime_version! rewrites the preferences and requires a fresh
    # session before the new runtime is picked up — hence the second call.
    "${JULIA_BIN}" --project="${JULIA_PROJECT_DIR}" --startup-file=no -e \
        'using Pkg; Pkg.precompile(); using CUDA; CUDA.precompile_runtime()'
    stamp_write julia "${JULIA_FINGERPRINT}"
fi

# Prove the GPU is actually usable from Julia before we claim success. A box
# whose driver is too old for the pinned runtime fails here, loudly, instead
# of at the first solve.
if ! "${JULIA_BIN}" --project="${JULIA_PROJECT_DIR}" --startup-file=no -e \
    'using CUDA; @assert CUDA.functional() "CUDA is not functional"; println("[bootstrap] CUDA device: ", name(CUDA.device()))'; then
    printf '::blab:fail:julia:CUDA is not functional in Julia — driver/runtime mismatch (pinned runtime %s)\n' "${BLAB_CUDA_RUNTIME}"
    exit 1
fi
ok julia

# ---------------------------------------------------------------------------
# stage: sysimage — optional, large speedup to solver start-up
# ---------------------------------------------------------------------------
SYSIMAGE_ARG=""
if [ "${BLAB_BUILD_SYSIMAGE}" = "1" ]; then
    stage sysimage "building the Julia sysimage (slow)"
    if [ -f "${SYSIMAGE_PATH}" ] && stamp_matches sysimage "${JULIA_FINGERPRINT}"; then
        skip sysimage "sysimage already built for this Manifest"
    else
        BLAB_JULIA_SYSIMAGE="${SYSIMAGE_PATH}" "${JULIA_BIN}" --startup-file=no \
            "${REPO_DIR}/docker/build-beat-cuda-sysimage.jl"
        stamp_write sysimage "${JULIA_FINGERPRINT}"
    fi
    [ -f "${SYSIMAGE_PATH}" ] && SYSIMAGE_ARG="--julia-sysimage ${SYSIMAGE_PATH}"
    ok sysimage
fi

# ---------------------------------------------------------------------------
# stage: launch — (re)start the solve server
# ---------------------------------------------------------------------------
stage launch "starting blab server on port ${BLAB_SERVER_PORT}"

# Stop any server from a previous provisioning run. Killing the process group
# takes the Julia worker with it — a stray worker would hold the GPU and the
# next solve would OOM.
if [ -f "${PID_FILE}" ]; then
    OLD_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then
        note "stopping previous server (pid ${OLD_PID})"
        kill -TERM "-${OLD_PID}" 2>/dev/null || kill -TERM "${OLD_PID}" 2>/dev/null || true
        for _ in $(seq 1 20); do
            kill -0 "${OLD_PID}" 2>/dev/null || break
            sleep 0.5
        done
        kill -KILL "-${OLD_PID}" 2>/dev/null || kill -KILL "${OLD_PID}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
fi
# Belt and braces: anything still bound to the port would make the health
# check pass against the wrong process.
if command -v fuser >/dev/null 2>&1; then
    fuser -k "${BLAB_SERVER_PORT}/tcp" 2>/dev/null || true
fi

# The launcher is written to disk rather than inlined so an operator can SSH in
# and re-run exactly what the bridge ran.
cat > "${BLAB_CACHE_ROOT}/run-server.sh" <<EOF
#!/usr/bin/env bash
# Generated by vast_bootstrap.sh — starts the Boundary Lab solve server.
set -euo pipefail
export JULIAUP_HOME="${JULIAUP_DIR}"
export JULIA_DEPOT_PATH="${JULIA_DEPOT}"
export PATH="${JULIAUP_DIR}/bin:${VENV_DIR}/bin:\${PATH}"
exec "${VENV_DIR}/bin/blab" server \\
    --host "${BLAB_SERVER_HOST}" \\
    --port "${BLAB_SERVER_PORT}" \\
    --solver "${BLAB_SOLVER}" \\
    --julia-executable "${JULIA_BIN}" \\
    --julia-threads "${BLAB_JULIA_THREADS}" \\
    --warm-solver "${BLAB_WARM_SOLVER}" \\
    --max-running-jobs "${BLAB_MAX_RUNNING_JOBS}" \\
    --log-level "${BLAB_LOG_LEVEL}" \\
    --artifact-dir "${ARTIFACT_DIR}" ${SYSIMAGE_ARG}
EOF
chmod +x "${BLAB_CACHE_ROOT}/run-server.sh"

# setsid gives the server its own process group so the kill above can take the
# whole tree next time. nohup + disown so it survives this SSH session.
: > "${SERVER_LOG}"
setsid nohup "${BLAB_CACHE_ROOT}/run-server.sh" >> "${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
printf '%s' "${SERVER_PID}" > "${PID_FILE}"
note "server pid ${SERVER_PID}, log ${SERVER_LOG}"
ok launch

# ---------------------------------------------------------------------------
# stage: health — wait for /health, then report
# ---------------------------------------------------------------------------
stage health "waiting for /health on port ${BLAB_SERVER_PORT}"
HEALTH_JSON=""
DEADLINE=$(( $(date +%s) + BLAB_HEALTH_TIMEOUT ))
while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
        printf '::blab:fail:health:server process exited during start-up; last log lines:\n'
        tail -n 40 "${SERVER_LOG}" || true
        exit 1
    fi
    if HEALTH_JSON="$(curl -fsS --max-time 5 "http://127.0.0.1:${BLAB_SERVER_PORT}/health" 2>/dev/null)"; then
        [ -n "${HEALTH_JSON}" ] && break
    fi
    sleep 3
done
if [ -z "${HEALTH_JSON}" ]; then
    printf '::blab:fail:health:no /health response within %s s; last log lines:\n' "${BLAB_HEALTH_TIMEOUT}"
    tail -n 40 "${SERVER_LOG}" || true
    exit 1
fi
note "health: ${HEALTH_JSON}"
ok health

# Single machine-readable summary line, consumed by provision.ts.
printf '::blab:result:{"repoRev":"%s","gpu":"%s","vramMiB":"%s","port":%s,"solver":"%s","pid":%s,"serverLog":"%s","cacheRoot":"%s"}\n' \
    "${REPO_REV}" "${GPU_NAME}" "${GPU_VRAM_MIB}" "${BLAB_SERVER_PORT}" "${BLAB_SOLVER}" \
    "${SERVER_PID}" "${SERVER_LOG}" "${BLAB_CACHE_ROOT}"
