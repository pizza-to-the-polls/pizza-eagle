#!/usr/bin/env bash
# Post a systemd unit failure to the ops channel. Called by notify-failure@.service
# via OnFailure=. Two paths, first wins:
#   1. SLACK_ALERT_WEBHOOK (a real incoming-webhook URL)
#   2. SLACK_ALERT_CHANNEL + SLACK_BOT_TOKEN (the bot posts the alert itself —
#      no webhook needed; chat:write is already in its scopes)
set -euo pipefail
UNIT="$1"
MSG=":rotating_light: pizza-eagle unit \`$UNIT\` failed on $(hostname) — check journalctl -u $UNIT"
if [ -n "\${SLACK_ALERT_WEBHOOK:-}" ] && [ "\${SLACK_ALERT_WEBHOOK:0:4}" = "http" ]; then
  curl -sS -X POST "$SLACK_ALERT_WEBHOOK" -H 'Content-type: application/json' \
    --data "{\"text\": \"$MSG\"}" && echo
elif [ -n "\${SLACK_ALERT_CHANNEL:-}" ] && [ -n "\${SLACK_BOT_TOKEN:-}" ]; then
  curl -sS -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer \${SLACK_BOT_TOKEN}" -H 'Content-type: application/json' \
    --data "{\"channel\": \"\${SLACK_ALERT_CHANNEL}\", \"text\": \"$MSG\"}" && echo
else
  echo "no alert path configured (webhook/channel); skipping"
fi
