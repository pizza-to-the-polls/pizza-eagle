---
name: partner-users
description: Manage the approved partner list (the users table behind trusted reports and the partner login) via the pizzabase admin API — POST /users to add a partner with email, first name, and organization; GET /users to list; DELETE /users/:id to remove. The added partner can immediately magic-link in at polls.pizza/partners/report. Admin-gated (writeAllowed + explicit ask). Use when an admin asks to "add Jane from Common Cause as a partner", "who's on the partner list", or to remove partner access.
---

# Partner users — the approved-partner list (users CRUD)

The **users table is the partner list**: the people behind trusted reports
(`reports.trusted_by` FK) and the login behind the private partner report
page (`https://polls.pizza/partners/report` — enter email → magic link,
no password). Managed through the same pizzabase admin API as bans and
trusted reports (`pizzabase-api` skill: key + write gate apply in full).

## Gate

Write actions (add/update/remove) need `request-auth.json`
`"writeAllowed": true` **and** an explicit ask naming the person and org.
Adding a partner grants them the partner login and trusted-report
attribution — treat it like handing over the trusted status. Reads of
the list are fine any time.

## Add an approved partner

`POST https://base.polls.pizza/users`:

```bash
PIZZABASE_KEY=$(aws secretsmanager get-secret-value \
  --secret-id ptp/prod/pizza-eagle/pizzabase-api-key \
  --query SecretString --output text)

curl -s -X POST https://base.polls.pizza/users \
  -H "Authorization: Basic $PIZZABASE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "jane@example.org",
    "firstName": "Jane",
    "organization": "Common Cause",
    "admin": false
  }'
```

- `email` required (unique, normalized to lowercase); `firstName` /
  `organization` optional; `admin` **only** for the PTP team itself —
  partners are `admin: false`.
- 201 response = the created user row **plus a welcome email goes out
  automatically** (from partners@polls.pizza): what trusted submission
  means, the sign-in page, the no-password flow. Tell the admin the
  person got a welcome email and can sign in at
  `polls.pizza/partners/report` with that email (magic link, valid 24h
  per request).
- `welcomeEmailSent: false` in the 201 = the user was created (their
  access works) but Mailgun failed — say so plainly and give the admin
  the page URL to pass along manually. Never retry the create (the row
  exists; a retry 422s on the duplicate email).
- 422 with "already has a user (id N)" = they're already on the list —
  say so with the id, never retry.

## List partners (read, any time)

```bash
curl -s https://base.polls.pizza/users \
  -H "Authorization: Basic $PIZZABASE_KEY"
```

Returns `{results: [{id, email, firstName, organization, admin, createdAt}],
count}` — safe to quote in Slack (partner org emails, not reporters).

## Update a partner

`PUT https://base.polls.pizza/users/:id` with any of `email`, `firstName`,
`organization`, `admin` — e.g. fixing an org name. Email moves are
guarded (422 if it belongs to another user). Only on explicit ask.

## Remove a partner

`DELETE https://base.polls.pizza/users/:id` — on explicit admin ask only.

Effects of removal, say them in the answer:
- their reports' `trusted_by` attribution is **nulled** (ON DELETE SET
  NULL — the reports survive, the attribution doesn't; the actions log
  rows keep the raw email string)
- their magic-link sessions die on the next submit (login re-checks the
  table every time)

## Attribution reminder (trusted reports)

When filing a trusted report **on behalf of a partner**, pass their email
as the report's `user` field — it sets `reports.trusted_by` when it
matches a users row. If the partner isn't on the list yet, add them
first (above), then file. Full report procedure: `trusted-reports` skill.