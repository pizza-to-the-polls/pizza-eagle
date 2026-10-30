---
name: twilio-lookup
description: Read-only Twilio delivery-status lookups — was the SMS to a given phone number sent, delivered, failed, or bounced, and what was the error code? Use when asked about text delivery problems ("did the pizza text go out?", "why didn't they get the confirmation"), investigating a specific report's SMS trail, or when given a Twilio MessageSid.
---

# Twilio delivery lookups (read-only)

Straight answers about outbound SMS delivery, straight from the Twilio
Messages API — no more inferring from status-callback notes.

    node /opt/pizza-eagle/scripts/twilio-lookup.mjs <command>

The credential is a **Restricted Twilio API key** (Messaging read only)
provisioned from Secrets Manager by bootstrap §5d. The helper is
GET-only — it cannot send, edit, or delete anything, ever. If the ask is
"send a text to X", that is a different tool and not this skill.

## Commands
- `to <number> [--since Nd] [--limit N]` — messages involving that number,
  newest first (checks `To=` then falls back to `From=`). Default window
  30d, default limit 25 (max 100).
- `show <MessageSid>` — one message in full, error code translated.
- `codes` — the delivery error-code cheat sheet.

Numbers accept `+1503...`, `503...` (US assumed), or spaced/dashed forms.
Prefix `HUMAN=1` for the quick-read format to paste into Slack.

## Recipes
- "Did the text to this number actually go out?":
  `HUMAN=1 node /opt/pizza-eagle/scripts/twilio-lookup.mjs to +15038938626 --since 2d`
- "Why did delivery fail?" — read `err=` from the above, then the meaning
  is already in parentheses; `30003` = handset unreachable,
  `30004` = carrier/spam-blocked, `30006` = landline, `30007` = content
  filter, `30001` = transient carrier failure (often retried).
- "What happened with message SMxxxx":
  `node /opt/pizza-eagle/scripts/twilio-lookup.mjs show SMxxxx`

## Conventions
- Report `status` plainly: `queued` → `sent` → `delivered`, or `failed` /
  `undelivered`. `sent` ≠ delivered — say which one you mean.
- For failures, always quote the error code + meaning, and check whether a
  later retry (`direction=outbound-api`, newer `date_sent`) got delivered.
- No messages found for a number is a normal answer — say so plainly
  (also means: number never texted us, or outside the window).
- Keep it modest: this counts against Twilio API/message listing; don't
  page through hundreds of messages, narrow with `--since`.
- This is the customer-facing phone system: **never paste message bodies**
  into Slack — report status/error only. Bodies may contain report PII.
