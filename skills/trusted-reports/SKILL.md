---
name: trusted-reports
description: Submit a trusted report to pizzabase via the admin API (POST /report with the API key) — auto-validates the location and can start a real pizza delivery immediately. Use when a writeAllowed admin vouches for a polling-location report, asks to "submit a trusted report", or needs a location validated now instead of through the moderation queue.
---

# Trusted reports — POST /report with the key (prod)

A report submitted **with the API key** is a *trusted report*: the location is
**validated immediately** (skips the moderation/verification queue), an
Action `"trusted report"` is logged with the vouching `user`, and the pizza
dispatch workflow fires (Zapier `zapNewReport` / `zapNewLocation`) when the
location is new or will receive. This can start a **real pizza order** —
it is not a drill.

**Write gate applies** (see `pizzabase-api` skill): `writeAllowed: true` +
the admin explicitly asked and is vouching. Get the key first:

```bash
PIZZABASE_KEY=$(aws secretsmanager get-secret-value \
  --secret-id ptp/prod/pizza-eagle/pizzabase-api-key \
  --query SecretString --output text)
```

## Submit

```bash
curl -s -X POST -H "Authorization: Basic $PIZZABASE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "address": "123 Main St, Springfield, IL 62701",
    "contact": "+12145550123",
    "contactFirstName": "Maria",
    "contactLastName": "Garcia",
    "contactRole": "Poll Worker",
    "waitTime": "45 minutes",
    "canDistribute": true,
    "user": "Nina Martinez"
  }' \
  https://base.polls.pizza/report
```

Body fields (all optional except `address` — authed defaults fill the rest):

| Field | Notes |
|---|---|
| `address` | **Required.** Full street address; server normalizes + geocodes it |
| `contact` | Phone or email of the on-site contact; defaults to a placeholder — pass it when there's a real contact |
| `contactFirstName` / `contactLastName` / `contactRole` | Who's on site |
| `waitTime` | Free text, e.g. `"45 minutes"` |
| `canDistribute` | Boolean — is distribution allowed at this location |
| `addressOverride` | Authed-only: force the normalized address when geocoding misfires |
| `uploadId` | Link an existing media upload |
| `user` | **Always pass this** — the vouching admin's Slack name. Lands in the Action log and the location's `validated` Action |

Response: `{address, hasTruck, willReceive, alreadyOrdered}` —

- `willReceive: true` → this location will get pizza (dispatch fires)
- `alreadyOrdered: true` → an order already exists for that location
- `hasTruck: true` → a pizza truck covers this location

## Conventions

- Before submitting, **read the address back** to the requester and confirm —
  a wrong address validates the wrong location and can send real pizza there.
- One report per ask; never bulk-submit.
- After submitting, quote the response fields and say the location is now
  validated (who vouched, per the `user` field).
- If the phone number in `contact` is banned, the API still records the
  report data but returns all-false willReceive — say so rather than
  retrying.
