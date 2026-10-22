#!/usr/bin/env bash
# ptp-ops bootstrap — cloud-init user-data for the ops box.
#
# Idempotent: safe to re-run on every instance refresh. The CFN template
# (cloudformation/ptp-ops.yaml) passes parameters via instance tags or
# /etc/ptp-ops/bootstrap.env. Where marked TODO, fill in the concrete
# values for the PTP account before first deploy.
set -euo pipefail

#### Parameters (override via /etc/ptp-ops/bootstrap.env if present)
PTP_BOT_HOME=/opt/ptp-bot
PTP_BOT_REPO="https://github.com/pizza-to-the-polls/ptp-ops.git" # read-only over https on the box; updates are pull-based
EIP_ALLOCATION_ID="TODO: eipalloc-..."                     # allocated by the CFN stack
DNS_ZONE_ID="TODO: Route53 public hosted zone id"
DNS_NAME="bastion.polls.pizza"
SECRETS_PREFIX="ptp/prod/ptp-ops"              # e.g. ptp/prod/ptp-ops — must match the CFN BotSecretsPrefix
ADMIN_USER="duncombe"                          # sudo-capable human; reached via SSH-over-SSM
[[ -f /etc/ptp-ops/bootstrap.env ]] && . /etc/ptp-ops/bootstrap.env

#### 1. Base packages
dnf install -y git nodejs jq amazon-cloudwatch-agent || {
  # AL2023's default node may lag pi's >=22.19 requirement — nodesource fallback.
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf install -y nodejs
}

#### 2. pi (the agent runtime)
npm install -g @earendil-works/pi-coding-agent

#### 3. Bot OS user — no sudo, its only identity is the instance role
id -u ptp-bot &>/dev/null || useradd -r -m -s /usr/sbin/nologin ptp-bot

#### 4. Checkout
mkdir -p "$PTP_BOT_HOME"
if [[ ! -d "$PTP_BOT_HOME/.git" ]]; then
  git clone --depth 1 "$PTP_BOT_REPO" "$PTP_BOT_HOME"
  chown -R ptp-bot:ptp-bot "$PTP_BOT_HOME"
fi

#### 5. Boot secrets from Secrets Manager (instance role is scoped to these)
mkdir -p /etc/ptp-ops
aws secretsmanager get-secret-value --secret-id "${SECRETS_PREFIX}/env" \
  --query SecretString --output text > /etc/ptp-ops/.env.raw
# Expect a JSON object of {SLACK_APP_TOKEN, SLACK_BOT_TOKEN, ...}
jq -r 'to_entries | .[] | "\(.key)=\(.value)"' /etc/ptp-ops/.env.raw > "$PTP_BOT_HOME/.env"
chown ptp-bot:ptp-bot "$PTP_BOT_HOME/.env"
chmod 600 "$PTP_BOT_HOME/.env"
rm -f /etc/ptp-ops/.env.raw

#### 5b. GA service account (read-only) — investigations data source
# scripts/ga.mjs reads this path (GA_SA_JSON default) as the ptp-bot user.
install -d -o ptp-bot -g ptp-bot -m 700 /home/ptp-bot/.config /home/ptp-bot/.config/ptp
if aws secretsmanager get-secret-value --secret-id "${SECRETS_PREFIX}/ga-readonly" \
     --query SecretString --output text > /home/ptp-bot/.config/ptp/ga-readonly.json.tmp 2>/dev/null; then
  mv /home/ptp-bot/.config/ptp/ga-readonly.json.tmp /home/ptp-bot/.config/ptp/ga-readonly.json
  chown ptp-bot:ptp-bot /home/ptp-bot/.config/ptp/ga-readonly.json
  chmod 600 /home/ptp-bot/.config/ptp/ga-readonly.json
else
  echo "WARN: secret ${SECRETS_PREFIX}/ga-readonly not found — GA queries stay disabled" >&2
  rm -f /home/ptp-bot/.config/ptp/ga-readonly.json.tmp
fi

#### 6. Operator context + skills for the bot user
install -d -o ptp-bot -g ptp-bot -m 755 /opt/ptp-bot/state
install -o ptp-bot -g ptp-bot -m 644 "$PTP_BOT_HOME/agent/AGENTS.md" \
  /opt/ptp-bot/state/AGENTS.template.md
# Skills (triage, agent-status, ...) — copied once by provisioning, then
# ride the repo via the update timer:
install -d -o ptp-bot -g ptp-bot /home/ptp-bot/.pi/agent/skills
# TODO: rsync -a "$PTP_BOT_HOME/skills/" /home/ptp-bot/.pi/agent/skills/

#### 7. Retool tunnel user (Retool Cloud dials in as this, no shell)
id -u retool &>/dev/null || useradd -r -m -s /usr/sbin/nologin retool
install -d -o retool -g retool -m 700 /home/retool/.ssh
if aws secretsmanager get-secret-value --secret-id "${SECRETS_PREFIX}/retool-ssh-key" \
     --query SecretString --output text > /home/retool/.ssh/authorized_keys.tmp 2>/dev/null; then
  mv /home/retool/.ssh/authorized_keys.tmp /home/retool/.ssh/authorized_keys
  chown retool:retool /home/retool/.ssh/authorized_keys
  chmod 600 /home/retool/.ssh/authorized_keys
else
  echo "WARN: secret ${SECRETS_PREFIX}/retool-ssh-key not found — Retool tunnel fails until it exists" >&2
  rm -f /home/retool/.ssh/authorized_keys.tmp
fi

#### 7b. Admin SSH user (humans reach sshd via Session Manager's
#### SSH-over-SSM proxy — zero inbound; the SG stays Retool-only)
id -u "$ADMIN_USER" &>/dev/null || useradd -m -s /bin/bash "$ADMIN_USER"
usermod -aG wheel "$ADMIN_USER"
install -d -o "$ADMIN_USER" -g "$ADMIN_USER" -m 700 "/home/$ADMIN_USER/.ssh"
if aws secretsmanager get-secret-value --secret-id "${SECRETS_PREFIX}/admin-ssh-key" \
     --query SecretString --output text > "/home/$ADMIN_USER/.ssh/authorized_keys.tmp" 2>/dev/null; then
  mv "/home/$ADMIN_USER/.ssh/authorized_keys.tmp" "/home/$ADMIN_USER/.ssh/authorized_keys"
  chown "$ADMIN_USER:$ADMIN_USER" "/home/$ADMIN_USER/.ssh/authorized_keys"
  chmod 600 "/home/$ADMIN_USER/.ssh/authorized_keys"
else
  echo "WARN: secret ${SECRETS_PREFIX}/admin-ssh-key not found — admin SSH disabled until it exists" >&2
  rm -f "/home/$ADMIN_USER/.ssh/authorized_keys.tmp"
fi
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload sshd || systemctl reload sshd.service || true

#### 8. EIP + DNS self-registration (box identity survives instance refresh)
if [[ -z "$EIP_ALLOCATION_ID" || "$EIP_ALLOCATION_ID" == TODO* ]]; then
  echo "FATAL: EIP_ALLOCATION_ID unset — bootstrap.env not written by UserData?" >&2
  exit 1
fi
INSTANCE_ID=$(curl -s -H 'X-aws-ec2-metadata-token: '$(
  curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' \
  http://169.254.169.254/latest/api/token) \
  http://169.254.169.254/latest/meta-data/instance-id)
aws ec2 associate-address --instance-id "$INSTANCE_ID" \
  --allocation-id "$EIP_ALLOCATION_ID" --allow-reassociation || true
PUBLIC_IP=$(aws ec2 describe-addresses --allocation-ids "$EIP_ALLOCATION_ID" \
  --query 'Addresses[0].PublicIp' --output text)
aws route53 change-resource-record-sets --hosted-zone-id "$DNS_ZONE_ID" \
  --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"'"$DNS_NAME"'","Type":"A","TTL":60,"ResourceRecords":[{"Value":"'"$PUBLIC_IP"'"}]}}]}'

#### 9. Services
# notify-failure@ must be present before any OnFailure= reference resolves.
install -d /etc/systemd/system
install -m 644 "$PTP_BOT_HOME/systemd/notify-failure@.service" \
  "$PTP_BOT_HOME/systemd/ptp-bot.service" \
  "$PTP_BOT_HOME/systemd/ptp-bot-update.service" \
  "$PTP_BOT_HOME/systemd/ptp-bot-update.timer" \
  "$PTP_BOT_HOME/systemd/ptp-bot-backup.service" \
  "$PTP_BOT_HOME/systemd/ptp-bot-backup.timer" \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ptp-bot.service ptp-bot-update.timer ptp-bot-backup.timer

echo "ptp-ops bootstrap complete."