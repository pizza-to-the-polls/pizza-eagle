# Pizza Eagle — Operations Runbook

One page. If Matt's unavailable, this keeps the bird flying.

## Is it running?

- **The #dev channel is the heartbeat** — pizza-eagle answers @mentions. If it's silent for >10 min, the alarm posts to `#dev`.
- **Daily self-check**: runs at 09:00 Pacific, posts a digest to `#dev` **only if something fails** (silent when green).
- **Off-box health check**: GitHub Actions runs daily at 09:00 Pacific (`.github/workflows/health.yml`), also silent when green.
- **Quick manual check**: `ssh ptp-ops "systemctl is-active pizza-eagle; journalctl -u pizza-eagle -n 5"`

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
- **GitHub App**: `pizza-eagle-agent` (id 5434163), installed on polls.pizza + pizzabase + hotnready
