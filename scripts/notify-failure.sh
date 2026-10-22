#!/usr/bin/env bash
# Post a systemd unit failure to the ops channel. Called by
# notify-failure@.service via OnFailure=.
set -euo pipefail
UNIT="$1"
[[ -n "${SLACK_ALERT_WEBHOOK:-}" ]] || { echo "no SLACK_ALERT_WEBHOOK; skipping"; exit 0; }
curl -sS -X POST "$SLACK_ALERT_WEBHOOK" \
  -H 'Content-type: application/json' \
  --data '{"text":":rotating_light: pizza-eagle unit `'"${UNIT}"'` failed on '"$(hostname)"' — check journalctl -u '"${UNIT}"'"}'
echo