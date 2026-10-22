# pizza-eagle — pizza-eagle

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
systemd/             pizza-eagle.service + nightly update timer + failure notifier
scripts/bootstrap.sh cloud-init user-data (idempotent, EIP+DNS self-registration)
scripts/ga.mjs       zero-dep GA4 query helper (readonly SA; report/realtime/accounts)
manifest.json         Slack app manifest (name, bot user, scopes, Socket Mode)
cloudformation/      pizza-eagle.yaml — DRAFT stack (review TODOs before deploy)
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
    BotSecretArn=arn:… BackupBucketName=…
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
Host pizza-eagle
  HostName i-0…            # instance id (SSM target, not DNS)
  User duncombe
  IdentityFile ~/.ssh/id_ed25519
  ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-SSHSessionCommand"
```

  (needs `brew install --cask session-manager-plugin` locally)

- Port-forward to Aurora:
  `aws ssm start-session --targets "Key=tag:Name,Values=pizza-eagle" \
    --document-name AWS-StartPortForwardingSessionToRemoteSocket \
    --parameters host=pizzabase.cluster-c0xyw6eawjva.us-west-2.rds.amazonaws.com,portNumber=5432`

Box updates are pull-based: nightly `pizza-eagle-update.timer` runs
`git pull --ff-only && npm ci && npm run build && systemctl restart pizza-eagle`;
GitHub Actions can trigger the same via `ssm send-command`.

## Security boundary (read-only by construction)

- The `pizza-eagle` OS user's only AWS identity is the instance role: logs
  read, S3 media read, `PizzaBaseReadOnly` Data API (`ptp_ro` = SELECT on
  all 14 tables — verified), Bugsnag readonly, gh, GA4 readonly (aggregate
  analytics, no PII — SA at `~/.config/ptp/ga-readonly.json`).
- No DB write path exists for the bot. The only mutating surface is P4's
  scoped GitHub App: draft PRs on `polls.pizza`/`pizzabase` (human merge
  mandatory — branch protection + author-can't-approve) and free publish to
  the `hotnready` Pages sandbox. Credentials ride the per-invocation
  injection rule. See SLACK_BOT_PLAN.md §10 P4.
- Never post raw contact info or raw bucket paths to Slack — conventions
  live in `agent/AGENTS.md`.

## Remaining before first deploy (console-side — Matt)

- [ ] Secrets under prefix `ptp/prod/pizza-eagle/`: `env` (bot tokens, model
      key, alert webhook), `ga-readonly` (GA service-account JSON),
      `retool-ssh-key`, `admin-ssh-key`; P4 adds `gh-pr-token`
- [ ] `GA_PROPERTY_ID` (GA Admin → Property settings) — or enable the
      Analytics Admin API in GCP project 115859449668 for self-discovery
- [ ] Deploy params: `VpcId`, `SubnetId`, `BotSecretArn`, `BackupBucketName`
- [ ] IAM: `pizza-eagle-github-deploy` OIDC role for Actions (repo
      pizza-to-the-polls/pizza-eagle, ref main)
- [ ] P4 (when ready): fine-grained PAT + branch protection on `main` of
      polls.pizza + pizzabase (branch protection is load-bearing)
- [ ] Skills sync for the `pizza-eagle` user (`~/.pi/agent/skills`)
- [ ] Post-P3: `pg_default_acl` fix (new tables invisible to `retool` role)