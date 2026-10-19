# ptp-ops — ptp-bot

**Status: scaffolded (2026-10-19) — compiles, not yet deployed.**

Slack front-end around a **pi agent session** for Pizza to the Polls ops
investigations. `@ptp-bot why does upload 13280 have no report?` →
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
cloudformation/      ptp-ops.yaml — DRAFT stack (review TODOs before deploy)
```

## How a mention flows

```
@ptp-bot <question>
  → allowlist check (channels, users)
  → post "🔎 Investigating…" to thread          (instant ack)
  → queue job → pi --print --session-id <thread-session> "<question>"
      cwd = state/work/<thread>/   (AGENTS.md operator context + case-history.md)
  → findings chunked into the thread; status edited to ✅/❌
  → thread map persisted (follow-ups resume the same pi session)
```

Sessions and case files live under `state/` (JSONL + markdown) — that's the
investigation transcript store; back it up with the box.

## Local development

```bash
npm install
export SLACK_APP_TOKEN=xapp-…      # app token (Socket Mode)
export SLACK_BOT_TOKEN=xoxb-…       # bot token
export ALLOWED_CHANNELS=C…         # your private test channel
npm run dev
```

Create the Slack app (one-time):

1. <https://api.slack.com/apps> → **Create App → From scratch**.
2. **Socket Mode** → enable → create app-level token (`connections:write`).
3. **OAuth & Permissions** → bot scopes: `app_mentions:read`, `chat:write`.
4. **Event Subscriptions** → enable → subscribe to `app_mention`.
5. Install to workspace → copy the bot token (`xoxb-`).
6. Invite the bot to your test channel.

Then @-mention it with the Spring Creek question and watch it go.

`PI_BIN` defaults to `pi` on PATH. On the ops box the bot runs as the
`ptp-bot` user whose `~/.pi` carries the skills; locally your own
`~/.pi/agent/skills` already work.

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