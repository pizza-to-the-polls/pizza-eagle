---
name: block-people
description: Ban or unban a phone number from receiving pizza via the pizzabase admin API (POST/DELETE /banned-phone-numbers), or block/unblock a submission IP (POST/DELETE /blocked-ips) — for abuse, spam, or fake reports. Use when asked to "block", "ban", or "blacklist" someone/a number/an IP address, to check whether a number or IP is blocked, or to lift a ban.
---

# Block people — banned phone numbers (prod)

Banning a phone number makes every future report from it get the silent
no-pizza response (`hasTruck: false, willReceive: false, alreadyOrdered:
false`) — no error, no SMS, the requester just never gets pizza. Use it for
spam/abuse: repeated fake reports, harassment, banned-recurrence numbers.

**Write gate applies** (see `pizzabase-api` skill): `writeAllowed: true` +
the requester explicitly asked. Get the key first:

```bash
PIZZABASE_KEY=$(aws secretsmanager get-secret-value \
  --secret-id ptp/prod/pizza-eagle/pizzabase-api-key \
  --query SecretString --output text)
```

## Check whether a number is already banned (read, any time)

```bash
curl -s -H "Authorization: Basic $PIZZABASE_KEY" \
  "https://base.polls.pizza/banned-phone-numbers/%2B15038938626"
```
Returns the ban (id, phoneNumber, reason, bannedBy, bannedAt) or 404 if not
banned. The lookup accepts an id or a phone number; server-side phone
variants are normalized, but pass E.164 (`+1…`) to be safe.

## Ban a number

```bash
curl -s -X POST -H "Authorization: Basic $PIZZABASE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"phoneNumber": "+15035550123", "reason": "repeated fake reports from this number", "bannedBy": "Scott Duncombe"}' \
  https://base.polls.pizza/banned-phone-numbers
```

- `reason` — why (quote the requester's justification).
- `bannedBy` — the **requester's** Slack name (audit trail), not yours.
- Response: the new ban JSON; quote the `id` back in the answer.

## List bans (read)

`GET https://base.polls.pizza/banned-phone-numbers?limit=100&page=0` —
newest first, 100 max per page. Useful before banning to avoid duplicates.

## Unban

`DELETE /banned-phone-numbers/:id` — by **id only**. Look the ban up first
(by phone via the show endpoint), confirm with the requester which ban is
coming off, then delete.

## Conventions

- Read the number back to the requester (digit for digit) before banning —
  a wrong number silently starves a real person and nobody notices.
- One ban per ask. Never bulk-ban from a list without an explicit request.
- After banning, say in the answer: the number, the reason, the ban id,
  and that existing reports/orders are untouched (the ban only affects
  *future* report submissions from that number).

## Block a submission IP (same write gate)

IP blocks stop `POST /report` / `POST /upload` from an address at the edge
(403, no rows created) — use for abuse from a source IP (e.g. a flood of
fake web reports). Same gate: `writeAllowed: true` + explicit ask.

```bash
curl -s -X POST -H "Authorization: Basic $PIZZABASE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"ip": "203.0.113.7", "reason": "flood of fake reports", "blockedBy": "Scott Duncombe"}' \
  https://base.polls.pizza/blocked-ips
```

- `ip` — the raw address as seen in investigation output (`uploads.ip_address`,
  CloudWatch filter patterns). The server normalizes it (IPv4-mapped IPv6 →
  IPv4) and stores only its SHA-256 hash — the blocklist is not a PII ledger.
- `blockedBy` — the **requester's** Slack name, as with bans.
- Lookup/unblock: `GET /blocked-ips/:id` by row id (list rows via
  `GET /blocked-ips?limit=100&page=0`), `DELETE /blocked-ips/:id`.
- To check whether an IP is blocked without the row id: `ipHash` it the same
  way (normalize → sha256 hex) and grep the list — or just try the block:
  a duplicate insert of the same normalized IP upserts-collides (unique hash);
  safest is look up by hash in the list first.
- `X-Forwarded-For` is never trusted directly — pizzabase uses the proxy-
  computed `req.ip`; pass through what the investigation shows.
