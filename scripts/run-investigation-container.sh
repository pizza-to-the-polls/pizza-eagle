#!/usr/bin/env bash
# run-investigation-container.sh — the isolation boundary between the Slack
# listener and one pi investigation run (issue #5).
#
# The listener (src/investigate.ts) spawns THIS script instead of pi
# directly:
#
#   run-investigation-container.sh <workdir> <session-id> "<question>"
#
# stdin is unused (the question rides as argv[3]); stdout is pi's answer,
# stderr is diagnostics + pi stderr — investigate.ts splits the streams and
# treats a non-zero exit as a failed run. Input validation here repeats
# what investigate.ts already enforces — defense in depth: this script is
# also the argv boundary for anything else that ever invokes it.
#
# WHY THIS EXISTS
# The pi child used to inherit the listener's OS user (pizza-eagle), so a
# prompt-injected investigation could:
#   - read /proc/<listener-pid>/environ (Slack tokens — the old childEnv()
#     scrub only protected the child's OWN env, not the parent's),
#   - ptrace/signal the listener itself,
#   - read every state/ file, ~/.config/ptp, ~/.config/bugsnag.
# This wrapper runs the investigation as a DIFFERENT unprivileged OS user
# (pizza-eagle-inv), inside a rootless Podman container when one is
# available. It picks the strongest available mode automatically:
#
#   mode 1 (ops box):  sudo -u pizza-eagle-inv podman run …  — PID namespace
#                      (the listener's /proc is unreachable), UID boundary
#                      (no ptrace/signal, no listener file access), read-only
#                      rootfs, no capabilities, only the case workdir and a
#                      per-run staged HOME are mounted
#   mode 2 (no image): sudo -u pizza-eagle-inv pi …  — UID boundary only
#                      (Option B level; used until the image is built)
#   mode 3 (dev/CI):   pi directly as the current user — NO isolation;
#                      acceptable on a laptop, but the box must never be
#                      here: scripts/self-check.mjs probe 10 alerts when
#                      podman or the image is missing on the box.
#
# WHAT THE CHILD CAN REACH (all modes): the case workdir (bind-mounted /
# cwd, the ONLY writable path), triage-read credentials staged per run from
# the listener user's HOME (GA service account, Bugsnag readonly token,
# pi's models.json — the model key is env-keyed, never on disk), the AWS
# instance role via IMDS (by design — read-only triage policy), and the
# repo's helper scripts mounted read-only so AGENTS.md absolute paths keep
# working. Nothing else: not state/, not the listener's env, not the
# listener's memory.
#
# ENV CONTRACT (set by investigate.ts's wrapperEnv allowlist): PATH, HOME,
# TMPDIR, LANG, OPENROUTER_KEY_EAGLE / OPENROUTER_KEY_PIZZA (whichever
# pi's models.json keys the provider on — box: EAGLE, laptop/dev: PIZZA),
# GH_APP_ID (gh-token.mjs), PI_BIN, INV_IMAGE, INV_USER,
# PI_AGENT_DIR, PI_MODEL (per-run model override — issue #34; absent
# when unset, which keeps the staged settings.json default),
# AWS_REGION/AWS_DEFAULT_REGION, GA_PROPERTY_ID, ZAPIER_MCP_URL.
# Slack tokens are structurally absent — investigate.ts never passes
# them, and this script forwards only the list above.
#
# SUDOERS (bootstrap.sh installs /etc/sudoers.d/pizza-eagle-investigation):
#   pizza-eagle ALL=(pizza-eagle-inv) NOPASSWD: ALL
# The drop carries an explicit env (HOME + passthrough list via `env`),
# so sudo's env_reset cannot leak anything else into the child — and it
# also means no env_keep knobs need maintaining in sudoers.
set -euo pipefail

INV_USER="${INV_USER:-pizza-eagle-inv}"
INV_IMAGE="${INV_IMAGE:-pizza-eagle-investigation}"
PI_BIN="${PI_BIN:-pi}"
PI_AGENT_DIR="${PI_AGENT_DIR:-${HOME:-/root}/.pi/agent}"
MAX_QUESTION_CHARS=32000
# The ops box is us-west-2; the container has no ~/.aws, so the region must
# ride explicitly (IMDS supplies credentials, never region).
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"

die() { echo "run-investigation-container: $*" >&2; exit 1; }

[[ $# -eq 3 ]] || die "usage: $0 <workdir> <session-id> <question>"
WORKDIR="$1"
SESSION_ID="$2"
QUESTION="$3"

# ── Input validation (untrusted argv: session id round-trips through
# state/threads.json; the question is raw Slack text) ──────────────────────
[[ "$SESSION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || die "invalid session id (uuid expected)"
(( ${#QUESTION} <= MAX_QUESTION_CHARS )) \
  || die "question exceeds $MAX_QUESTION_CHARS characters"
[[ -d "$WORKDIR" ]] || die "workdir does not exist: $WORKDIR"

# The case workdir is the exchange surface with the container/inv user:
# owner pizza-eagle, group pizza-eagle (pizza-eagle-inv is a member —
# bootstrap.sh), mode 770. World-read drops off (was 755): only the bot
# user + investigation user traverse it.
mkdir -p "$WORKDIR/sessions"
chmod 0770 "$WORKDIR" "$WORKDIR/sessions" 2>/dev/null || true

PI_ARGS=(
  --print
  --session-id "$SESSION_ID"
  --session-dir "$WORKDIR/sessions"
  --no-approve   # decline project trust — see src/investigate.ts header note
)
# Per-run model override (issue #34): the operator selects a vision model
# (e.g. PI_MODEL=or-pizza/z-ai/glm-5v-turbo in the listener's env). Must
# ride BEFORE the `--` separator — it's a pi option, not a positional —
# and the model must exist in the staged catalog. Unset = default.
[[ -n "${PI_MODEL:-}" ]] && PI_ARGS+=(--model "$PI_MODEL")
PI_ARGS+=(-- "$QUESTION")

# ── Privilege drop helpers ─────────────────────────────────────────────────
# Rootless podman keeps its image store under the invoking user's home, so
# the drop must set HOME to the inv user's real home — never the wrapper's.
INV_HOME="$( (getent passwd "$INV_USER" 2>/dev/null || true) | cut -d: -f6 )"

can_drop() {
  [[ -n "$INV_HOME" ]] || return 1
  [[ "$(id -u)" == "0" ]] && return 0
  command -v sudo >/dev/null 2>&1 || return 1
  # -n: never prompt — a passworded sudo would hang the investigation.
  sudo -n -u "$INV_USER" -- true 2>/dev/null
}

# Env the isolated child gets. Enumerated explicitly (not inherited) so the
# listener's full env can never ride along, whatever invokes this script.
PASSTHROUGH_ENV=(OPENROUTER_KEY_EAGLE OPENROUTER_KEY_PIZZA GH_APP_ID GA_PROPERTY_ID ZAPIER_MCP_URL PI_MODEL)
build_drop_env() {  # prints env(1) arguments: HOME, PATH, passthrough
  printf 'HOME=%s\n' "$INV_HOME"
  printf 'PATH=%s\n' "${PATH:-/usr/local/bin:/usr/bin:/bin}"
  local v
  for v in "${PASSTHROUGH_ENV[@]}"; do
    [[ -n "${!v:-}" ]] && printf '%s=%s\n' "$v" "${!v}"
  done
  printf 'AWS_REGION=%s\n' "$AWS_REGION"
  return 0
}

# Runs the given command as the inv user in the background, forwarding
# TERM/INT (the listener kills active investigations on shutdown — with a
# plain exec the signal would replace this shell and orphan the container).
run_dropped() {  # run_dropped CMD...
  local drop_env args=()
  while IFS= read -r drop_env; do args+=("$drop_env"); done < <(build_drop_env)
  if [[ "$(id -u)" == "0" ]]; then
    runuser -u "$INV_USER" -- env "${args[@]}" "$@" &
  else
    sudo -n -u "$INV_USER" -- env "${args[@]}" "$@" &
  fi
  CHILD_PID=$!
}

CHILD_PID=""
on_term() {
  [[ -n "$CHILD_PID" ]] && kill -TERM "$CHILD_PID" 2>/dev/null || true
  exit 143
}
trap on_term TERM INT

image_available() {
  if [[ "$(id -u)" == "0" ]]; then
    runuser -u "$INV_USER" -- env HOME="$INV_HOME" podman image exists "$INV_IMAGE" 2>/dev/null
  else
    sudo -n -u "$INV_USER" -- env HOME="$INV_HOME" podman image exists "$INV_IMAGE" 2>/dev/null
  fi
}

# ── Mode selection ─────────────────────────────────────────────────────────
if command -v podman >/dev/null 2>&1 && can_drop && image_available; then
  echo "run-investigation-container: mode 1 — podman container as $INV_USER (image $INV_IMAGE)" >&2

  # Per-run staging of everything the child must read from the listener
  # user's HOME. Lives in the listener's PrivateTmp, removed on exit; the
  # inv user can never traverse /home/pizza-eagle (mode 700) directly, and
  # nothing is copied into the case workdir — credentials must not land in
  # state/ or its S3 backups.
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/pizza-eagle-inv.XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT
  mkdir -p "$STAGE/home/.pi/agent" "$STAGE/home/.config/ptp" "$STAGE/home/.config/bugsnag"

  # pi provider/skill config (models.json carries no secrets — the model
  # key is env-keyed). Agnostic about whether PI_CODING_AGENT_DIR-style
  # paths are ~/.pi/agent or ~/.pi: both layouts materialize.
  for f in models.json settings.json; do
    if [[ -f "$PI_AGENT_DIR/$f" ]]; then
      cp "$PI_AGENT_DIR/$f" "$STAGE/home/.pi/agent/$f"
      mkdir -p "$STAGE/home/.pi/agent/agent"
      cp "$PI_AGENT_DIR/$f" "$STAGE/home/.pi/agent/agent/$f"
    fi
  done
  if [[ -d "$PI_AGENT_DIR/skills" ]]; then
    cp -R "$PI_AGENT_DIR/skills" "$STAGE/home/.pi/agent/skills"
    mkdir -p "$STAGE/home/.pi/agent/agent"
    cp -R "$PI_AGENT_DIR/skills" "$STAGE/home/.pi/agent/agent/skills"
  fi

  # Triage-read credentials, staged to the paths AGENTS.md documents
  # (~/.config/ptp/ga-readonly.json, ~/.config/bugsnag/readonly-token).
  GA_SRC="${GA_SA_JSON:-${HOME:-}/.config/ptp/ga-readonly.json}"
  if [[ -n "$GA_SRC" && -f "$GA_SRC" ]]; then
    cp "$GA_SRC" "$STAGE/home/.config/ptp/ga-readonly.json"
  fi
  BUGSNAG_SRC="${BUGSNAG_TOKEN_PATH:-${HOME:-}/.config/bugsnag/readonly-token}"
  if [[ -f "$BUGSNAG_SRC" ]]; then
    cp "$BUGSNAG_SRC" "$STAGE/home/.config/bugsnag/readonly-token"
  fi

  # World-readable stage contents (the inv user / container must read
  # them); the stage HOME dir itself is writable — pi keeps runtime state
  # (locks, memory) under ~/.pi and it must survive inside the boundary.
  chmod 0777 "$STAGE/home"
  chmod -R a+rX "$STAGE/home/.pi" "$STAGE/home/.config"

  # Helper scripts (gh-token.mjs, ga.mjs, publish-hotnready.sh) mounted
  # read-only at their documented absolute path so AGENTS.md instructions
  # and request-auth-relative flows keep working. The zapier fleet harness
  # is mounted too when present — write attempts from inside the container
  # fail visibly (read-only) rather than silently.
  SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PODOPTS=(
    run --rm -i --network host   # IMDS + AWS APIs; egress control is the instance role (RUNBOOK)
    --cap-drop ALL               # no CAP_NET_RAW, no CAP_PTRACE, no DAC_OVERRIDE
    --security-opt no-new-privileges
    --pids-limit 64              # fork-bomb protection
    --read-only                  # rootfs immutable; /workspace + staged HOME are the writable surfaces
    --tmpfs /tmp:rw,size=64m,mode=1777
    --log-driver none
    -w /workspace
    -v "$WORKDIR":/workspace
    -v "$STAGE/home":/home/pi
    -e HOME=/home/pi
    -e PI_CODING_AGENT_DIR=/home/pi/.pi/agent
    -e OPENROUTER_KEY_EAGLE
    -e OPENROUTER_KEY_PIZZA
    -e GH_APP_ID
    -e GA_PROPERTY_ID
    -e ZAPIER_MCP_URL
    -e PI_MODEL
    -e AWS_REGION -e AWS_DEFAULT_REGION
    -v "$SCRIPTS_DIR":/opt/pizza-eagle/scripts:ro
  )
  [[ -d /opt/ptp-zapier-workflows ]] && PODOPTS+=(-v /opt/ptp-zapier-workflows:/opt/ptp-zapier-workflows:ro)

  run_dropped podman "${PODOPTS[@]}" "$INV_IMAGE" "${PI_ARGS[@]}"

elif can_drop; then
  echo "run-investigation-container: mode 2 — direct pi as $INV_USER (podman/image unavailable: Option B level isolation)" >&2
  cd "$WORKDIR"
  run_dropped "$PI_BIN" "${PI_ARGS[@]}"

else
  echo "run-investigation-container: mode 3 — NO ISOLATION: pi as the current user (dev/CI only; on the box this is a self-check failure)" >&2
  cd "$WORKDIR"
  # No privilege drop, nothing staged → plain exec is safe (the listener
  # kills this process directly, and there is nothing to clean up).
  exec "$PI_BIN" "${PI_ARGS[@]}"
fi

# Both staged modes land here: reap the child (stdout/stderr stream through
# the inherited pipes), preserve its exit status, and let the EXIT trap
# remove the staged credentials.
set +e
wait "$CHILD_PID"
status=$?
set -e
exit "$status"
