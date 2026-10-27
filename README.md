# pizza-eagle — Pizza Eagle 🦅

**Status: IN PRODUCTION (deployed 2026-10-23) — stack `pizza-eagle`,
bot live via Socket Mode, Retool tunnel on `bastion.polls.pizza`.**

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
skills/               pi skills (ga: GA4 recipes; rides the repo to the bot user)
systemd/              pizza-eagle.service + update/backup/prune timers + failure notifier
scripts/bootstrap.sh cloud-init user-data (idempotent; EIP+DNS self-registration)
scripts/render-template.sh  splices bootstrap.sh into the CFN template's UserData
scripts/ga.mjs       zero-dep GA4 query helper (readonly SA; report/realtime/accounts)
scripts/gh-token.mjs GitHub App installation-token minter (pizza-eagle-agent; PEM from Secrets Manager)
scripts/publish-hotnready.sh  one-shot publisher to the hotnready Pages sandbox
scripts/pizza-psql   human DB console (SSM tunnel + Secrets Manager; no secrets in history)
scripts/notify-failure.sh     unit failures → Slack channel (webhook or bot token)
cloudwatch/           cwagent config (bot.log → /pizza-eagle/bot)
iam/                  pizza-eagle-ops policy — canonical definition (mirrored by BotRole)
manifest.json         Slack app manifest (name, bot user, scopes, Socket Mode)
cloudformation/       pizza-eagle.yaml — the ops-box stack
tests/                unit tests (node:test, zero new deps)
.github/workflows/    test.yml (every push/PR; required check) + deploy.yml
```

## Tests

```bash
npm run check   # tsc --noEmit (also runs in CI)
npm test        # unit suite: node:test via tsx — slack mrkdwn/chunking, config
                # validation, thread store, ga.mjs/gh-token.mjs pure helpers
                # (incl. real RS256 JWT verification with a generated key)
npm run smoke   # integration incl. live pi roundtrip — manual, needs .env
```

CI (`.github/workflows/test.yml`) runs check + test on every push and PR.
Make it a **required status check** in branch protection so pizza-eagle-agent
PRs can't merge red.

## How a mention flows

```
@pizza_eagle <question>
  → (access is OPEN: any user, any channel the bot is in)
  → fetch the WHOLE THREAD (needs channels:history) → thread-context.md
  → post "🔎 Investigating…" to thread          (instant ack)
  → queue job → pi --print --session-id <thread-session> "<question>"
      cwd = state/work/<thread>/   (AGENTS.md + case-history.md + thread-context.md)
      listener writes request-auth.json from Slack metadata — write-powers gate
      (same-thread runs serialize; global concurrency cap; queue-burst refusal)
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
npm run dev             # listener — console shows "[pizza-eagle] up …" on connect
```

No public URL is needed (Socket Mode is outbound wss) — this runs fine on a laptop.

### Talking to it

In the test channel:

```
@Pizza Eagle why does upload 13280 have no report?
```

What happens, in order:

1. **Instant status reply** in the thread: `🔎 Investigating — … (case <id>, question #1)` — that's the ack.
2. The investigation runs **async** (minutes, not seconds). Watch the `npm run dev` console for `[pizza-eagle]` logs.
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
| Reply never comes, case stuck | Check `state/work/<case>/case-history.md` + `journalctl -u pizza-eagle` (or dev console) — timeout default 10 min |

`PI_BIN` defaults to `pi` on PATH. Locally your own `~/.pi/agent/skills` work as-is; on the ops box the bot runs as the `pizza-eagle` user whose `~/.pi` carries the synced skills.

## Deploy (ops box)

The CFN stack (`cloudformation/pizza-eagle.yaml`) creates: IAM instance role =
triage-readonly policy + SSM core + `GetSecretValue` on the bot secrets; SG
(egress 443, inbound 22 for Retool CIDRs only); ASG min=max=1; EIP +
Route53 record `bastion.polls.pizza`; `base64(scripts/bootstrap.sh)` as
user-data.

**Always deploy the rendered template** — the raw one has no user-data:

```bash
bash scripts/render-template.sh   # splices bootstrap.sh into UserData + validates
aws cloudformation deploy --stack-name pizza-eagle \
  --template-file build/pizza-eagle.rendered.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides VpcId=vpc-… SubnetId=subnet-… \
    BotSecretArn=arn:… RdsSecurityGroupId=sg-… BackupBucketName=pizza-eagle-backups
```

CI (`.github/workflows/deploy.yml`, OIDC — no AWS keys in GitHub) renders and
deploys the same way on template/bootstrap changes, changeset-first for
review.

### Human access to the box (no SSH keys at the cloud level)

- Shell: `aws ssm start-session --targets "Key=tag:Name,Values=pizza-eagle"`
- Your laptop SSH key (installed from the `admin-ssh-key` secret), zero
  inbound — Session Manager proxies sshd over localhost:

```
# ~/.ssh/config — once (instance id from the console)
Host ptp-ops
  HostName i-0…            # instance id (SSM target, not DNS)
  User duncombe
  IdentityFile ~/.ssh/id_ed25519
  ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p"
```

  (needs `brew install --cask session-manager-plugin` locally)

- Database console: `~/bin/pizza-psql` (or `scripts/pizza-psql`) — SSM
  ssh -L tunnel on a dynamic local port, credential fetched from Secrets
  Manager with YOUR identity, passed via `PGPASSWORD`. Never in history.
  `-d pizzabasestage` for stage; `-r ptp_ro` for read-only.

  ⚠ Reinstalling the Slack app resets its channel memberships — re-`/invite`
  it anywhere it lived.

Box updates are pull-based: nightly `pizza-eagle-update.timer` runs
`git pull --ff-only && npm ci && npm run build && systemctl restart pizza-eagle`;
GitHub Actions can trigger the same via `ssm send-command`.

## Backups & restore

Nightly (`pizza-eagle-backup.timer`) tars `state/` — sessions, case-history,
thread map — to `s3://pizza-eagle-backups/state-<timestamp>.tgz`
(versioned bucket, 180-day lifecycle). Restore drill (from the box, or any
identity with s3:GetObject):

```bash
latest=$(aws s3 ls s3://pizza-eagle-backups/ | sort | tail -1 | awk '{print $4}')
aws s3 cp "s3://pizza-eagle-backups/$latest" - | tar tzf - | head   # verify contents
# full restore: stop the bot, extract over state/, restart
sudo systemctl stop pizza-eagle
aws s3 cp "s3://pizza-eagle-backups/$latest" - | tar xzf - -C /opt/pizza-eagle/state
sudo systemctl start pizza-eagle
```

## Record retention (PTP policy compliance)

State backups and live state contain 1-year-class records under the PTP
Document Retention & Destruction Policy (rule c — electronic documents,
including Slack messages: delete after one year):

- **S3 backups** (`pizza-eagle-backups`): lifecycle expires objects at
  **180 days** — stricter than the policy requires, and noncurrent
  versions at 30 days, so deletions actually complete.
- **Live state** (`state/sessions`, `state/work` incl. verbatim Slack
  thread context): `pizza-eagle-prune.timer` deletes anything older than
  **365 days**, weekly.
- **Legal hold** (rule d): `sudo systemctl mask pizza-eagle-prune.timer`
  suspends pruning until the hold lifts; S3 lifecycle must also be
  suspended from the console during a hold.
- **Exceptions**: only the PTP President or Audit Committee (policy,
  Exceptions section).
- Transcripts are kept PII-light by convention (masked columns in
  queries — see AGENTS.md).

## Observability

- **Bugsnag**: listener errors report to the PTP project (`BUGSNAG_KEY`) —
  bot crashes sit next to app crashes.
- **CloudWatch**: journald ships to `/pizza-eagle/bot` (cwagent); the agent
  can read its own log group (it's in the AGENTS.md data sources).
- **Slack alerts**: unit failures post to `SLACK_ALERT_CHANNEL` via the
  bot token (webhook path still supported).

## Security boundary

Red-team review 2026-10-27 (`~/Projects/pizza-eagle-red-team-2026-10-27.md`) —
what the boundary actually is, and what was fixed:

- **DB (`ptp_ro`, SELECT-only)**: no SQL write path exists for the bot. **But
  SELECT ≠ harmless**: `api_keys`/`integration_sessions` hold *usable*
  credentials (API keys accepted by pizzabase write endpoints; social OAuth
  tokens). AGENTS.md forbids querying them outright, the suspicion detector
  flags the phrasing, and `sql/revoke-credential-tables.sql` is the human-run
  revocation — until it lands, treat those tables as exposed.
- **AWS (instance role)**: logs read (pizzabase lambda + own), S3 media read,
  RDS Data API, Bugsnag/GA4 readonly. 2026-10-27: `LambdaRead` **removed**
  (GetFunction returns env vars = secrets), change-set writes removed, Route53
  UPSERT pinned to `bastion.polls.pizza` A-records (was zone-wide any-type),
  EIP association pinned to this stack's allocation.
- **Write powers (P4)**: gated by `request-auth.json` — a machine-readable file
  the LISTENER writes from Slack-authenticated event metadata before every
  run (admins: Scott/Nina/Lee). The helper scripts enforce it too:
  `gh-token.mjs` mints **repo-scoped** tokens (allowlist + `repositories` +
  minimum `permissions` in the mint body; raw `--installation` minting
  removed) and `publish-hotnready.sh` refuses without the gate. Every mint
  + publish lands in the usage ledger bound to the requester id.
- **Slack input**: question/thread text is untrusted — it can imitate prose
  auth markers in `case-history.md` (verified) but cannot create
  `request-auth.json`. Same-thread runs serialize (`src/queue.ts`), burst
  beyond the waiting-room cap is refused in-thread.
- Never post raw contact info or raw bucket paths to Slack — conventions
  live in `agent/AGENTS.md`.

**Known residual** (tracked in RUNBOOK): the worker shares the instance
profile/IMDS with bootstrap, so `ptp/prod/pizza-eagle/*` secrets (incl.
`gh-app-key`) remain reachable from a tool-compromised run — the durable fix
is a per-run sandbox/IAM identity, not done in this repo. Any hint of prompt
injection = incident: rotate the App key.

## Operations status

Deployed 2026-10-23. Secrets live under `ptp/prod/pizza-eagle/*` (env,
pi-config, gh-app-key, ga-readonly, bugsnag-token, retool-ssh-key,
admin-ssh-key). Day-to-day tasks are in the Pizza to the Polls Todoist
project (🤖Pi label); the design history and roadmap live in
`SLACK_BOT_PLAN.md` (§10, P0–P5).

Known follow-ups: CW log shipping (stream never materializes — todo), prod
channel pick, old-bastion decommission after soak. Security follow-ups from
the 2026-10-27 red team (see RUNBOOK): run
`sql/revoke-credential-tables.sql` against the DB (master creds), deploy
the IAM changes (change-set first), and build the per-run worker sandbox so
the investigation process never shares the instance profile.