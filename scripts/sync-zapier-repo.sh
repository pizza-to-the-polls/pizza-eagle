#!/usr/bin/env bash
# sync-zapier-repo.sh — keep /opt/ptp-zapier-workflows (the Zapier fleet
# harness checkout) present and fresh on the ops box.
#
# Why this exists (2026-11-12): agent/AGENTS.md's "Zapier fleet changes"
# section promises the eagle end-to-end zap ownership — fixture first, then
# npm run validate/deploy/smoke in the harness checkout. The docs landed
# (2026-10-28) but the box was never given the repo, so the eagle correctly
# reported "no fleet harness mounted" (#dev, 2026-11-12). This script is the
# provisioning + nightly-refresh half; the eagle's own flow still pulls
# --ff-only (with a freshly minted token) right before every change.
#
# Called from:
#   - scripts/bootstrap.sh §5e            (reborn box provisioning)
#   - systemd/pizza-eagle-update.service  (nightly refresh, 04:30)
#   - .github/workflows/deploy.yml        (immediate update-agent dispatch)
#
# Auth: mints a purpose-scoped installation token ("zapier-fleet-sync",
# contents:write on pizza-to-the-polls/zapier ONLY — see gh-token.mjs). No
# stored credentials: nothing persistent, nothing in a file that outlives the
# run. The token rides a 0600 env file sourced INSIDE the dropped shell —
# never argv — because journald records the full argv of every sudo/runuser
# invocation (the 2026-11-04 issue #65 leak class).
#
# Idempotent + non-destructive:
#   - missing checkout  → fresh clone + npm ci            (failure is FATAL:
#     a box without the repo can't honor the AGENTS.md promise)
#   - existing checkout → pull --ff-only; a dirty or diverged tree is a
#     WARN-and-skip, never a reset — the eagle's flow edits and commits in
#     this tree between validate and push, and destroying an in-flight
#     change is the one unrecoverable mistake this script could make.
#   - npm ci only when node_modules is missing or older than package-lock.
#
# Permissions model: the checkout is owned by pizza-eagle:pizza-eagle with
# group write + setgid dirs, so BOTH the listener user and the dropped
# investigation user (pizza-eagle-inv, a group member — bootstrap §3b) can
# run the read commands and (admin-asked) the edit→commit→push flow. The
# inv user also gets a system-wide git safe.directory entry: git refuses
# repos owned by another uid ("dubious ownership") and the eagle runs as
# pizza-eagle-inv.
set -euo pipefail

REPO_DIR="/opt/ptp-zapier-workflows"
REPO_URL="https://github.com/pizza-to-the-polls/zapier.git"
BOT_USER="pizza-eagle"
BOT_HOME="/home/pizza-eagle"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/etc/pizza-eagle/.env"

log()  { echo "sync-zapier-repo: $*"; }
warn() { echo "sync-zapier-repo: WARN: $*" >&2; }
die()  { echo "sync-zapier-repo: FATAL: $*" >&2; exit 1; }

# ── Environment: box .env carries GH_APP_ID + GITHUB_ALLOWED_REPOS ─────────
# (The listener injects the same values into investigations; gh-token.mjs
# reads them from the process env. A dev/CI box without the env file and
# without GH_APP_ID has nothing to sync — say so and exit clean.)
if [[ -z "${GH_APP_ID:-}" && -r "$ENV_FILE" ]]; then
  while IFS='=' read -r k v; do
    [[ "$k" == GH_APP_ID || "$k" == GITHUB_ALLOWED_REPOS ]] && export "$k=$v"
  done < <(grep -E '^(GH_APP_ID|GITHUB_ALLOWED_REPOS)=' "$ENV_FILE" || true)
fi
if [[ -z "${GH_APP_ID:-}" ]]; then
  log "no GH_APP_ID (dev/CI?) — nothing to sync, exiting clean"
  exit 0
fi
export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"

# ── The git-auth env file (0600, BOT_USER-owned, unlinked on exit) ─────────
# Sourced INSIDE the dropped shell so the token never appears in argv
# (journald records argv verbatim — issue #65).
RUN_ENV="$(mktemp /tmp/zapier-sync-env.XXXXXX)"
chmod 600 "$RUN_ENV"
cleanup() { rm -f "$RUN_ENV"; }
trap cleanup EXIT

GH_TOKEN="$(node "$SCRIPTS_DIR/gh-token.mjs" --repo pizza-to-the-polls/zapier --purpose zapier-fleet-sync)" \
  || die "token mint failed (purpose zapier-fleet-sync)"
B64="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64)"
printf 'GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=http.extraheader\nGIT_CONFIG_VALUE_0=AUTHORIZATION: basic %s\n' "$B64" > "$RUN_ENV"
unset GH_TOKEN B64
chown "$BOT_USER" "$RUN_ENV"

# Everything below runs as the repo's owning user (root's git rejects
# pizza-eagle-owned checkouts; root's npm leaves root-owned artifacts —
# the 2026-10-24 nightly-failure mode documented in pizza-eagle-update).
as_bot() {  # as_bot <bash-snippet> — runs with the auth env file sourced
  runuser -u "$BOT_USER" -- env HOME="$BOT_HOME" bash -c '. "$1"; shift; eval "$@"' _ "$RUN_ENV" "$1"
}

# ── Clone or refresh ────────────────────────────────────────────────────────
if [[ ! -d "$REPO_DIR/.git" ]]; then
  log "no checkout at $REPO_DIR — cloning"
  as_bot "git clone '$REPO_URL' '$REPO_DIR'" || die "clone failed"
else
  dirty="$(runuser -u "$BOT_USER" -- env HOME="$BOT_HOME" git -C "$REPO_DIR" status --porcelain || true)"
  if [[ -n "$dirty" ]]; then
    # NEVER reset: an in-flight eagle change (edited, validated, not yet
    # committed) lives here. Warn loudly and skip this cycle.
    warn "checkout has uncommitted changes (in-flight eagle change?) — skipping pull:"
    echo "$dirty" | head -5 >&2
  else
    if ! as_bot "git -C '$REPO_DIR' pull --ff-only"; then
      warn "pull --ff-only failed (diverged or transient network) — leaving checkout as-is; the eagle's own flow pulls before each change"
    fi
  fi
fi

# ── Deps: npm ci only when missing or stale (harness needs the dev tier —
# tsx + typescript run every validate/deploy/smoke, so NOT --omit=dev) ────────
if [[ ! -d "$REPO_DIR/node_modules" ]] || [[ "$REPO_DIR/package-lock.json" -nt "$REPO_DIR/node_modules" ]]; then
  log "installing harness deps (npm ci)"
  runuser -u "$BOT_USER" -- env HOME="$BOT_HOME" npm ci --prefix "$REPO_DIR" \
    || warn "npm ci failed — the harness (tsx/tsc) will not run until deps exist"
else
  log "node_modules fresh — skipping npm ci"
fi

# ── Commit identity (repo-LOCAL config: nothing is committed, no global) ───
runuser -u "$BOT_USER" -- env HOME="$BOT_HOME" git -C "$REPO_DIR" config user.name  "pizza-eagle-agent" || true
runuser -u "$BOT_USER" -- env HOME="$BOT_HOME" git -C "$REPO_DIR" config user.email "pizza-eagle-agent@users.noreply.github.com" || true

# ── Investigation-user access ───────────────────────────────────────────────
# The eagle runs as pizza-eagle-inv; git needs safe.directory for repos owned
# by another uid, and the edit→commit flow needs group write + setgid dirs
# (new files stay group pizza-eagle whatever uid creates them).
if [[ "$(id -u)" == "0" ]]; then
  git config --system --get safe.directory "$REPO_DIR" >/dev/null 2>&1 \
    || git config --system --add safe.directory "$REPO_DIR"
fi
chown -R "$BOT_USER":"$BOT_USER" "$REPO_DIR"
chmod -R g+rwX "$REPO_DIR"
find "$REPO_DIR" -type d -exec chmod g+s {} +

log "$REPO_DIR ready ($(runuser -u "$BOT_USER" -- env HOME="$BOT_HOME" git -C "$REPO_DIR" log --oneline -1 | head -1))"
