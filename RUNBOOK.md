# Pizza Eagle — Operations Runbook

One page. If Scott's unavailable, this keeps the bird flying.

## Is it running?

- **The #dev channel is the heartbeat** — pizza-eagle answers @mentions. If it's silent for >10 min, the alarm posts to `#dev`.
- **Daily self-check**: runs at 09:00 Pacific, posts a digest to `#dev` **only if something fails** (silent when green).
- **Memory pressure** (2026-10-31): `pizza-eagle-memory-high` (stack) pages when bastion memory is >85% for 5 min — the wedge class where a feedflag peak leg OOMs the box (SSM agent dies with it, Retool tunnel stranded). The eagle is also cgroup-capped (`MemoryMax=1G` in its unit; it has oom-kill history) and feedflag legs carry `TimeoutStartSec`/`MemoryMax` so a wedged leg self-recovers in ≤45 min.
- **Off-box health check**: GitHub Actions runs daily at 09:00 Pacific (`.github/workflows/health.yml`), also silent when green.
- **Quick manual check**: `ssh ptp-ops "systemctl is-active pizza-eagle; journalctl -u pizza-eagle -n 5"`
- **Nightly update health**: `ssh ptp-ops "journalctl -u pizza-eagle-update -n 10 --no-pager"` — the
  04:30 run pulls + rebuilds + restarts; if `git pull`/`npm` lines fail, the bot is
  silently running stale code. (2026-10-24..25: every nightly failed on root-vs-
  `pizza-eagle` repo ownership while the bot kept answering on day-1 code.)
- **Investigation sandbox prerequisites**: `pizza-eagle-inv` user + sudoers rule
  + `iptables-nft` are installed by bootstrap §3b/§1 — a box born without them
  fails the nightly at `install-units.sh`'s systemd-analyze verify
  (`FATAL: pizza-eagle-investigation-net.service failed verify` — 2026-10-31
  rebirth incident, first three 04:30 runs). Fix: PR #51 bootstrap + the update
  unit's `dnf install -y iptables-nft` self-heal; symptom on a broken box is the
  fence unit missing from `/etc/systemd/system/` entirely.
- **Deployed code version**: `ssh ptp-ops "git -c safe.directory=/opt/pizza-eagle -C /opt/pizza-eagle log --oneline -1"`
  — compare against origin/main; the box should never lag a day behind.

## Where everything lives

| Thing | Where |
|---|---|
| The bot | EC2 instance, stack `pizza-eagle`, `bastion.polls.pizza` (EIP) |
| The code | GitHub `pizza-to-the-polls/pizza-eagle`, deploys via Actions (OIDC) |
| Secrets | AWS Secrets Manager, prefix `ptp/prod/pizza-eagle/*` |
| Slack app | "Pizza Eagle" in api.slack.com/apps (Socket Mode, no webhook URL) |
| Database access | `ptp_ro` role (SELECT-only) via RDS Data API |
| Backups | `s3://pizza-eagle-backups/` — nightly tar, 180-day lifecycle |
| Usage ledger | `state/usage.jsonl` on the box — every question, mint, publish |
| pi model catalog | `/home/pizza-eagle/.pi/agent/models.json` on the box (NOT in this repo) |

## Model catalog (agent dir — re-provision by hand!)

pi's `models.json` and `settings.json` live in the box agent dir
(`/home/pizza-eagle/.pi/agent/`), **not in this repo** — a box rebuild will NOT
restore capability fixes to them. Known-good state (fixed 2026-10-29):

- Vision-capable models must declare `"input": ["text", "image"]`. These were
  upstream-declared text-only and had to be corrected by hand — a rebuild
  silently regresses them and vision runs (see `PI_MODEL` in `.env.example`)
  fail or ignore attachments:
  - `z-ai/glm-5v-turbo` (verified end-to-end with a test image)
  - `qwen/qwen3-vl-235b-a22b-instruct` and `-thinking`
  - `qwen/qwen3-vl-32b-instruct`
  - `baidu/ernie-4.5-vl-424b-a47b`
  - `google/gemini-3.5-flash` was already image-capable
- Default thinking level moved high → medium.

After any box rebuild or agent-dir re-provision, verify with:

```bash
ssh ptp-ops "grep -B2 -A8 'glm-5v-turbo' ~pizza-eagle/.pi/agent/models.json"
# each VL entry's "input" array must contain "image"
```

`PI_MODEL` (listener env) selects a model per run via pi `--model` and must
match an entry in that catalog — it only overrides, never adds models.

## How to restart it

```bash
ssh ptp-ops
sudo systemctl restart pizza-eagle
# verify:
journalctl -u pizza-eagle -n 5 --no-pager   # should show "up — channels=any"
```

## How to restore from backup

```bash
ssh ptp-ops
sudo systemctl stop pizza-eagle
latest=$(aws s3 ls s3://pizza-eagle-backups/ | sort | tail -1 | awk '{print $4}')
sudo runuser -u pizza-eagle -- aws s3 cp "s3://pizza-eagle-backups/$latest" - \
  | sudo tar xzf - -C /opt/pizza-eagle/state
sudo systemctl start pizza-eagle
```

RPO: 24h (nightly tar). Verified twice (drill + real restore after rebirth).

## How to rebuild the whole box from scratch

```bash
aws cloudformation deploy --stack-name pizza-eagle \
  --template-file build/pizza-eagle.rendered.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId=vpc-0a0dbd1cc9a68dc30 SubnetId=subnet-08c1c4ad92862ad8a \
    "BotSecretArn=$(aws secretsmanager describe-secret --secret-id ptp/prod/pizza-eagle/env --query ARN --output text)" \
    "RdsSecurityGroupId=sg-0e176dd57d8b04bde" \
    "BackupBucketName=pizza-eagle-backups" \
    "SlackAlarmChannel=C01CFGKK279"
```

The instance self-assembles in ~5 minutes (verified by rebirth drill).
Bot comes back connected, Retool tunnel reconnects, EIP + DNS re-register.

**After a rebuild**: Retool needs a new SSH host key re-accept. Your `ssh ptp-ops` prompts once.

## How to rotate a secret

```bash
# (Slack token, OpenRouter key, etc.) — prompt blind, never paste in chat:
python3 -c "
import getpass, json, subprocess
tok = getpass.getpass('New value: ')
def aws(*a): return subprocess.run(['aws',*a,'--region','us-west-2','--output','text'],capture_output=True,text=True,check=True).stdout.strip()
cur = json.loads(aws('secretsmanager','get-secret-value','--secret-id','ptp/prod/pizza-eagle/env','--query','SecretString'))
cur['<KEY_NAME>'] = tok
open('/tmp/s.json','w').write(json.dumps(cur))
subprocess.run(['aws','secretsmanager','update-secret','--secret-id','ptp/prod/pizza-eagle/env','--secret-string','file:///tmp/s.json','--region','us-west-2'],check=True)
import os; os.remove('/tmp/s.json')
"
# then restart the bot (see above)
```

**Important**: `/etc/pizza-eagle/.env` is root-owned — a plain restart does
NOT pick up a rotated secret. Re-fetch it as root first.

⚠ **Do NOT write it with a shell redirection** (`sudo aws … > /etc/pizza-eagle/.env`):
the `>` is performed by YOUR shell, which runs as a normal user — `/etc/pizza-eagle/`
is root-owned, so the redirect fails with `Permission denied` (and in the edge
case where the file exists with relaxed perms, it would end up owned by you,
not `root:root`, breaking the service boundary). Wrap the whole pipeline in
`sudo bash -c` so the fetch, redirect, chown, and chmod all run as root in one
atomic step:

```bash
sudo bash -c 'set -euo pipefail; aws secretsmanager get-secret-value \
  --secret-id ptp/prod/pizza-eagle/env --query SecretString --output text \
  | jq -r "to_entries | .[] | \"\\(.key)=\\(.value)\"" > /etc/pizza-eagle/.env; \
  chown root:root /etc/pizza-eagle/.env; \
  chmod 600 /etc/pizza-eagle/.env; \
  rm -f /opt/pizza-eagle/.env; \
  systemctl daemon-reload; \
  systemctl restart pizza-eagle'
```

Verify it took:

```bash
ls -l /etc/pizza-eagle/.env                    # must be -rw------- root root
sudo test ! -e /opt/pizza-eagle/.env && echo "old file gone"   # must NOT exist
sudo -u pizza-eagle cat /etc/pizza-eagle/.env  # must fail: Permission denied
systemctl is-active pizza-eagle                # must print: active
```

## 2026-10-27 red-team remediation — what changed, what still needs YOU

Full review: `~/Projects/pizza-eagle-red-team-2026-10-27.md`. Shipped in
this repo (deploys via the normal flow — the bot changes need the nightly
update or `update-agent` dispatch; the IAM changes need a stack deploy):

- **Write gate**: the requester gate is now `request-auth.json` — written by
  the LISTENER from Slack-authenticated event metadata before every run.
  The old scheme (newest `**Requester:**` line in `case-history.md`) was
  forgeable *by the question text itself* — verified, and invisible to the
  suspicion rules. `gh-token.mjs` and `publish-hotnready.sh` enforce the
  gate themselves; `--installation` raw minting is removed.
- **GitHub tokens**: mints are now repo-scoped (`repositories` + minimum
  `permissions` in the mint body) and allowlisted to the four PTP repos; a
  "hotnready token" can no longer touch every repo on the installation.
  Mints are ledgered with the requester id. Unattended box jobs (systemd
  timers) mint via `--purpose <name>` against a hard-coded `PURPOSES` table
  instead of `request-auth.json`, with a permission set that must be a strict
  subset of the interactive one and a `timer:`-prefixed ledger identity — so a
  timer needs no long-lived PAT in its `.env`. Adding a purpose is a reviewed
  code change.
- **Runner**: same-thread investigations serialize (shared workdir/session
  + a second request used to become "the newest requester" mid-run); thread
  records persist at case creation; queue bursts past the waiting-room cap
  get a polite refusal instead of unbounded memory.
- **IAM (BotRole)**: `LambdaRead` gone (GetFunction returns pizzabase env
  vars — Stripe/Twilio/Mailgun/JWT), change-set writes gone, Route53 pinned
  to one A-record UPSERT for `bastion.polls.pizza` (was: any record type,
  any action, whole zone), EIP association pinned to this stack's allocation.
- **systemd**: extra hardening on `pizza-eagle.service` (clocks/hostname/
  kernel/devices locked down).
- **Detection**: credential-table queries (`api_keys`,
  `integration_sessions`) now trip the pii-harvest flag.

### Human actions still required (NOT doable from the bot or this repo)

1. **DB revocation (do first)**: run `sql/revoke-credential-tables.sql`
   with master creds (`pizza-psql`) — revoke `ptp_ro` SELECT on
   `api_keys` + `integration_sessions`. Until then those tables are
   readable by every investigation. Then consider rotating whatever API
   keys/OAuth tokens existed in them (they were readable since 2026-10-23).
2. **Deploy the IAM changes**: `aws cloudformation deploy` with
   `build/pizza-eagle.rendered.yaml` (CI renders + changeset-first).
   ⚠ Review the change set: Route53 gets **condition-scoped** — if the next
   instance rebuild fails at EIP/DNS registration, the condition keys are
   the suspect; bootstrap does exactly one UPSERT of one A record for
   `bastion.polls.pizza`, which is what the conditions allow.
3. **Verify a real mint** after deploy: from a case workdir with
   `request-auth.json` (`writeAllowed: true`), `gh-token.mjs --repo
   pizza-to-the-polls/hotnready` — stderr must say "scoped to …" and a
   smoke push must still work.
4. **Verify a purpose mint** (no case workdir, so run it anywhere):
   `gh-token.mjs --repo pizza-to-the-polls/feedflag --purpose feedflag-digest`
   — stderr must report `permissions {"issues":"write"}` and
   `requester timer:feedflag-digest`, and `state/usage.jsonl` must gain a
   matching `token-mint` line. Then confirm the refusals still refuse:
   the same command with `--repo pizza-to-the-polls/pizzabase` exits 6, an
   unknown `--purpose` exits 6, and `--repo` with no `--purpose` and no
   `request-auth.json` still exits 3.

### Known residual — until the sandbox follow-up lands

The worker shares the instance profile/IMDS with bootstrap, so the
`ptp/prod/pizza-eagle/*` secrets (including `gh-app-key`) are still
reachable from a tool-compromised investigation run. The instruction-level
gates (AGENTS.md) and helper enforcement raise the bar but are not a
credential boundary. **Any evidence of prompt injection = incident:**
rotate `gh-app-key` (and the Slack tokens) and check `state/usage.jsonl`
for unexpected `token-mint` entries. Durable fix = per-run IAM identity /
sandbox (separate tracked work).

### Pre-isolation session files (2026-10-31, issue #54)

Every `<workdir>/sessions/*.jsonl` written before the uid boundary landed
(#52/#53) is listener-owned `0644` — the isolated child could not RESUME
it (EACCES), so every pre-isolation thread failed on its next reply.
`investigate.ts:ensureCaseWorkdirPerms` repairs group rw per run now, and
self-check probe 10c asserts the drop can append. Strays the listener
cannot chmod (root-owned, from SSM verification runs) need the root-side
one-liner:

```bash
sudo bash -c 'find /opt/pizza-eagle/state/work -path "*/sessions/*.jsonl" \
  -exec chgrp pizza-eagle {} + -exec chmod 0664 {} +; \
  find /opt/pizza-eagle/state/work -type d -name sessions \
  -exec chgrp pizza-eagle {} + -exec chmod 2770 {} +'
```

## Alert channels

| What | Where |
|---|---|
| Heartbeat silence (>10 min) | `#dev` — once on ALARM, replies to itself when self-healed |
| Daily self-check failure | Same channel, full digest |
| Unit failure (systemd) | Same channel, via bot token |
| Off-box health check failure | Same channel, from GitHub Actions |
| Suspicious request (PII harvest, write attempt, burst) | Same channel, real-time, tagged @you |

## Who to call

- **Slack app config**: whoever created it in api.slack.com (add a second admin)
- **AWS account**: 320802729995, us-west-2, Identity Center SSO
- **Retool resource**: SSH tunnel → `bastion.polls.pizza:22`, user `retool`
- **GitHub App**: `pizza-eagle-agent` (id 5434163), installed on polls.pizza + pizzabase + hotnready + feedflag + zapier (2026-10-28: zapier added — pizza-eagle now owns zap-fleet changes end-to-end via the repo harness at `/opt/ptp-zapier-workflows`, no PR/review step; harness gates are the review)
