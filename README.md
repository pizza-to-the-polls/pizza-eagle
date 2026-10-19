# ptp-ops — ptp-bot

**Status: scaffolded (2026-10-19) — compiles, not yet deployed.**

Slack front-end around a **pi agent session** for Pizza to the Polls ops
investigations. `@Pizza Eagle why does upload 13280 have no report?` →
ack in the thread → `pi` subprocess investigates with the same read-only
tooling used manually today (RDS Data API as `ptp_ro`, CloudWatch Logs,
Bugsnag readonly, `gh`) → findings posted back to the thread.

Design + decisions: `~/Projects/SLACK_BOT_PLAN.md`.

## Layout

```
src/index.ts        Socket Mode listener, allowlists, FIFO queue (ack-fast)
src/investigate.ts  pi subprocess per question (--session-id per Slack thread)
src/slack.ts         ack/async helpers, chunked posting
src/store.ts         thread_ts → session/workdir map (state/threads.json)
src/config.ts        env parsing
agent/AGENTS.md      operator context (copied into each case workdir)
systemd/             ptp-bot.service + nightly update timer + failure notifier
scripts/bootstrap.sh cloud-init user-data (idempotent, EIP+DNS self-registration)
manifest.json         Slack app manifest (name, bot user, scopes, Socket Mode)
cloudformation/      ptp-ops.yaml — DRAFT stack (review TODOs before deploy)
```

## How a mention flows

```
@Pizza Eagle <question>
  → allowlist check (channels, users)
  → post "🔎 Investigating…" to thread          (instant ack)
  → queue job → pi --print --session-id <thread-session> "<question>"
      cwd = state/work/<thread>/   (AGENTS.md operator context + case-history.md)
  → findings chunked into the thread; status edited to ✅/❌
  → thread map persisted (follow-ups resume the same pi session)
```

Sessions and case files live under `state/` (JSONL + markdown) — that's the
investigation transcript store; back it up with the box.

## Interfacing from a test channel

### One-time Slack app setup (~10 min)

The app config lives in **`manifest.json`** (name, bot user, scopes, Socket Mode) — create the app *from* it rather than clicking through settings:

1. <https://api.slack.com/apps> → **Create New App → From an app manifest** → paste `manifest.json` (the dashboard validates it on paste).
2. **App-Level Tokens** (*Basic Information* → scroll down) → **Generate token and scopes** → add scope `connections:write` → copy the `xapp-…` — *app tokens aren't representable in the manifest schema*.
3. **Event Subscriptions** → enable → **Subscribe to bot events** → add `app_mention` → Save. No request URL (Socket Mode is already on via the manifest); *the subscribed-event list isn't part of the manifest schema either*.
4. **OAuth & Permissions** → **Install to Workspace** → copy the bot token (`xoxb-…`).
5. Create a private test channel (e.g. `#bot-lab`), copy its ID from channel **details** (starts with `C`), and `/invite` the app into it.
6. Copy your own member ID (profile → ⋮ → **Copy member ID**, starts with `U`).

**Slack CLI** (optional; installed here as `slack-cli` v4.10.0): official installer is
`curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash -s slack-cli`.
`slack-cli manifest validate` only works inside a CLI project (`.slack/hooks.json`) — for this repo the dashboard's paste-validation is the check. Useful anyway: `slack-cli login` (workspace auth), `slack-cli doctor` (why-is-it-silent diagnostics), `slack-cli manifest diff` (dashboard vs repo drift, if this ever becomes a CLI project).

### Configure and pre-flight

```bash
cp .env.example .env   # fill in: both tokens, ALLOWED_CHANNELS=C…, ALLOWED_USERS=U…
npm run check:slack    # validates: bot token, socket connect, channel invite, user ID format
```

`check:slack` catches the classic failures before you start the listener — bad token type, `not_in_channel` (you forgot to invite the app), missing scope, malformed IDs.

### Run it

```bash
npm run dev             # listener — console shows "[ptp-bot] up …" on connect
```

No public URL is needed (Socket Mode is outbound wss) — this runs fine on a laptop.

### Talking to it

In the test channel:

```
@Pizza Eagle why does upload 13280 have no report?
```

What happens, in order:

1. **Instant status reply** in the thread: `🔎 Investigating — … (case <id>, question #1)` — that's the ack.
2. The investigation runs **async** (minutes, not seconds). Watch the `npm run dev` console for `[ptp-bot]` logs.
3. Findings post **as threaded replies** (long answers split at ~3800 chars), status message flips to ✅ (or ❌ with the error tail).

**Follow-ups must be *in the same thread*** — a reply that @-mentions the bot again resumes the same pi session (same case). A fresh top-level @mention starts a new case. That's the whole mental model: one thread = one case.

### Slack-free interface (agent quality testing)

`ask` runs the exact same investigation path (AGENTS.md context, case history, session resume) without Slack — good for tuning the operator prompt before wiring a workspace:

```bash
npm run ask -- "why does upload 13280 have no report?"
npm run ask -- --session <id> "follow-up"   # resume a case; ids print under each answer
```

### Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Nothing fires, no logs | App config: Event Subscriptions off, or `app_mention` not subscribed → step 4 |
| `not_in_channel` on check or silent ignoring | Bot not invited → `/invite` the app in the test channel |
| Mention ignored, console shows "un-allowlisted channel/user" | `ALLOWED_CHANNELS`/`ALLOWED_USERS` in `.env` are stale → re-copy IDs |
| `Missing required env var` | No `.env` and no shell exports → fill `.env` (listener reads it, shell env wins) |
| Reply never comes, case stuck | Check `state/work/<case>/case-history.md` + `journalctl -u ptp-bot` (or dev console) — timeout default 10 min |

`PI_BIN` defaults to `pi` on PATH. Locally your own `~/.pi/agent/skills` work as-is; on the ops box the bot runs as the `ptp-bot` user whose `~/.pi` carries the synced skills.

## Deploy (ops box)

The CFN stack (`cloudformation/ptp-ops.yaml`, **DRAFT — review TODOs**)
creates: IAM instance role = `ptp-triage-readonly-policy` + SSM core +
`GetSecretValue` on the bot secret; SG (egress 443, inbound 22 for Retool
only); ASG min=max=1 with the `bootstrap.sh` user-data; EIP + Route53
public record `bastion.polls.pizza` (Retool tunnel dependency — see plan §3).

Box updates are pull-based: nightly `ptp-bot-update.timer` runs
`git pull --ff-only && npm ci && npm run build && systemctl restart ptp-bot`;
GitHub Actions (OIDC, no AWS keys in GitHub) can trigger the same via
`ssm send-command`.

## Security boundary (read-only by construction)

- The `ptp-bot` OS user's only AWS identity is the instance role: logs
  read, S3 media read, `PizzaBaseReadOnly` Data API (`ptp_ro` = SELECT on
  all 14 tables — verified), Bugsnag readonly, gh.
- No DB write path exists for the bot. Mutating actions (filing issues,
  dispatching dd-agent) are deliberately **out of scope for v1** — that's
  the v1.5 confirmation-gate work.
- Never post raw contact info or raw bucket paths to Slack — conventions
  live in `agent/AGENTS.md`.

## TODO before first deploy

- [ ] Slack app in the PTP workspace (not just dev) + channel/user allowlists
- [ ] `cloudformation/ptp-ops.yaml` TODOs: VPC/subnet ids, public zone, AMI
      SSM param resolution, Retool CIDR ingress rules, UserData b64
- [ ] `scripts/bootstrap.sh` TODOs: repo URL, EIP allocation, secret names,
      retool user authorized_keys
- [ ] Skills sync for the `ptp-bot` user (`~/.pi/agent/skills`)
- [ ] Backup of `state/` (sessions + case history)
- [ ] The `pg_default_acl` gap fix (new tables invisible to `retool` role)