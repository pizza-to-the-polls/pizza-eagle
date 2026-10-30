---
name: pizzabase-api
description: Authenticated access to the pizzabase admin API (https://base.polls.pizza) with the Pizza Eagle production API key — auth pattern, endpoint map, and the write gate. Use when a task needs the pizzabase API rather than read-only SQL (ban a number, submit a trusted report, or an API-only read).
---

# pizzabase admin API — auth + endpoint map

The pizzabase API key (`api_keys` row description: **pizza eagle**) is stored
in Secrets Manager. It authenticates `Authorization: Basic <key>` requests
against **prod**: `https://base.polls.pizza` (staging `https://base-next.polls.pizza`
shares the code but NOT the `api_keys` table — this key only works on prod).

## Getting the key (never echo it)

```bash
PIZZABASE_KEY=$(aws secretsmanager get-secret-value \
  --secret-id ptp/prod/pizza-eagle/pizzabase-api-key \
  --query SecretString --output text)
```

- `AWS_PROFILE=ptp-agent` is already set and can read this secret.
- **Never** print the key, paste it into an answer, write it to a case file,
  or put it in argv where a `ps` could see it echoed. Keep it in the shell
  variable and use it inline:
  `curl -s -H "Authorization: Basic $PIZZABASE_KEY" …`
- The key never comes from the `api_keys` table (SELECTing that table is
  forbidden — credential grab). Secrets Manager is the only source.

## Write gate

This key grants **production write endpoints**. Before using it for anything
that writes (ban, unban, trusted report):

1. `request-auth.json` in the case workdir must say `"writeAllowed": true`.
2. The requester must have **explicitly asked** for the specific write
   ("ban this number", "submit a trusted report for …") — never speculatively,
   never "while I'm in here".
3. Say in the answer exactly what was written — who/what/why, and the ids
   returned. These endpoints audit (`bannedBy`, `user` fields, Action logs) —
   pass the **requester's Slack name** in them, not your own.

If either gate fails: do the investigation, give the exact request you *would*
send, and stop. Reads with the key are fine any time, but prefer read-only SQL
(`ptp_ro`) for data lookups — the API is for what SQL can't do.

## Endpoint map (auth-required unless noted)

| Method + path | What |
|---|---|
| `POST /report` | Submit a report; authed = **trusted report** (see `trusted-reports` skill) |
| `GET /banned-phone-numbers` | List bans, newest first (`?limit=100&page=N`) |
| `GET /banned-phone-numbers/:idOrPhoneNumber` | One ban (by id or phone) |
| `POST /banned-phone-numbers` | **Ban** a phone number (see `block-people` skill) |
| `DELETE /banned-phone-numbers/:id` | **Unban** (by id — look it up first) |
| `GET /blocked-ips` | List IP blocks (`?limit=100&page=N`) — rows store SHA-256 **hashes** only, never raw IPs |
| `POST /blocked-ips` | **Block** a submission IP — body `{ ip, reason, blockedBy }`; the server normalizes+hashes it. Blocked IPs get `403` at the `POST /report` / `POST /upload` edge (see `block-people` skill) |
| `DELETE /blocked-ips/:id` | **Unblock** (by id — look it up first; lookup by hash) |
| `GET /reports/:idOrAddress/media` | Moderation-queue media view for a report |
| `PUT /locations/:idOrAddress/validate` / `skip` / `truck` / `order` | Location admin actions — same write gate applies |
| `GET /totals`, `GET /locations`, `GET /reports` | Public reads, no key needed |

Errors: `401` = key not valid (if the `api_keys` row is new, confirm it
landed); `422` = validation errors (field names in the body); ban/report
writes return JSON you can quote directly.
