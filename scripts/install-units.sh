#!/usr/bin/env bash
# install-units.sh — sync systemd unit files from the repo checkout into
# /etc/systemd/system, so unit-file fixes merged to main go live with the
# next update instead of sitting dormant until a human SSMs them in
# (2026-10-28: PR #18's guarded update unit and #11's OnFailure units both
# needed hand-installs because bootstrap.sh §9 was the only installer).
#
# Runs as root (caller context — /etc/systemd/system is root-owned; the
# nightly unit and the SSM dispatch both run as root). No version-control
# commands are involved, so the root-user "dubious ownership" repository
# trap does not apply.
#
# Per changed unit: systemd-analyze verify FIRST (invalid syntax exits 1 →
# the calling unit fails → OnFailure alerts — never install broken config),
# then install -m 644. Exactly one daemon-reload at the end, only when
# something changed (skip nightly no-op reloads).
#
# Scope guards:
#   - Glob covers *.service + *.timer only — template units like
#     notify-failure@.service match *.service and install fine; other
#     files (README etc.) are ignored.
#   - NO `enable` (bootstrap owns enablement) and NO `restart` here
#     (the caller's explicit pizza-eagle.service restart is the only one).
#     daemon-reload alone refreshes timer definitions.
#
# Edge case: this script is an ExecStartPost of pizza-eagle-update.service.
# If that unit's own file changes mid-run, the current run is unaffected
# (systemd read the old definition at start); the next run uses the new
# definition — that is correct behavior, no handling needed.
set -euo pipefail

REPO_DIR="/opt/pizza-eagle"
UNIT_DIR="/etc/systemd/system"
CHANGED=0

# pizza-eagle.service's ReadWritePaths references /var/lib/pizza-eagle-inv
# (rootless podman store for the future investigation user, issue #30).
# Materialize it on every update: a ReadWritePaths path that doesn't exist
# makes systemd fail the service at NAMESPACE setup (status=226 — the bot
# can't start at all; 2026-10-29 outage). Ownership/permissions stay with
# bootstrap once the inv user exists — mkdir -p preserves whatever is there.
mkdir -p /var/lib/pizza-eagle-inv

for unit in "$REPO_DIR"/systemd/*.service "$REPO_DIR"/systemd/*.timer; do
  # Unmatched glob (no .timer in systemd/, say) stays literal — skip it.
  [ -f "$unit" ] || continue
  name=$(basename "$unit")
  target="$UNIT_DIR/$name"

  # Idempotence: identical file → nothing to do (no install, no reload).
  if [ -f "$target" ] && cmp -s "$unit" "$target"; then
    continue
  fi

  # Validate syntax before touching the live unit dir. A non-zero exit
  # fails this script → fails the calling unit → OnFailure alerts, and the
  # broken unit is never installed.
  if ! systemd-analyze verify "$unit"; then
    echo "FATAL: $name failed systemd-analyze verify — not installing" >&2
    exit 1
  fi

  install -m 644 "$unit" "$target"
  echo "updated: $name"
  CHANGED=1
done

if [ "$CHANGED" -eq 1 ]; then
  # Single reload regardless of how many files changed.
  systemctl daemon-reload
  echo "daemon-reload done"
else
  echo "all units current — no changes"
fi
