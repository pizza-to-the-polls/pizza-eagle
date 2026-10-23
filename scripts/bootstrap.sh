#!/usr/bin/env bash
# pizza-eagle bootstrap — cloud-init user-data for the ops box.
#
# Idempotent: safe to re-run on every instance refresh. The CFN template
# (cloudformation/pizza-eagle.yaml) passes parameters via instance tags or
# /etc/pizza-eagle/bootstrap.env. Where marked TODO, fill in the concrete
# values for the PTP account before first deploy.
set -euo pipefail

#### Parameters (override via /etc/pizza-eagle/bootstrap.env if present)
PTP_BOT_HOME=/opt/pizza-eagle
PTP_BOT_REPO="https://github.com/pizza-to-the-polls/pizza-eagle.git" # read-only over https on the box; updates are pull-based
EIP_ALLOCATION_ID="TODO: eipalloc-..."                     # allocated by the CFN stack
DNS_ZONE_ID="TODO: Route53 public hosted zone id"
DNS_NAME="bastion.polls.pizza"
SECRETS_PREFIX="ptp/prod/pizza-eagle"              # e.g. ptp/prod/pizza-eagle — must match the CFN BotSecretsPrefix
ADMIN_USER="duncombe"                          # sudo-capable human; reached via SSH-over-SSM
[[ -f /etc/pizza-eagle/bootstrap.env ]] && . /etc/pizza-eagle/bootstrap.env

#### 1. Base packages
# AL2023's default nodejs is v18 — the bot + pi need >=24 (active LTS,
# CVE-patched), so node comes from nodesource unconditionally (dnf install
# succeeding with an old version is not a failure — the old || fallback
# never fired).
dnf install -y git jq amazon-cloudwatch-agent
curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
dnf install -y nodejs

#### 2. pi (the agent runtime)
npm install -g @earendil-works/pi-coding-agent

#### 3. Bot OS user — no sudo, its only identity is the instance role
id -u pizza-eagle &>/dev/null || useradd -r -m -s /usr/sbin/nologin pizza-eagle

#### 4. Checkout
mkdir -p "$PTP_BOT_HOME"
if [[ ! -d "$PTP_BOT_HOME/.git" ]]; then
  git clone --depth 1 "$PTP_BOT_REPO" "$PTP_BOT_HOME"
  chown -R pizza-eagle:pizza-eagle "$PTP_BOT_HOME"
fi

#### 4b. Install + build (systemd runs node dist/index.js; the update timer
#### re-runs these on every nightly pull). npm needs cwd at the project root
#### (npm run --prefix does not resolve node_modules/.bin) and a writable HOME.
cd "$PTP_BOT_HOME"
runuser -u pizza-eagle -- env HOME=/home/pizza-eagle npm ci --omit=dev
runuser -u pizza-eagle -- env HOME=/home/pizza-eagle npm run build

#### 5. Boot secrets from Secrets Manager (instance role is scoped to these)
mkdir -p /etc/pizza-eagle
aws secretsmanager get-secret-value --secret-id "${SECRETS_PREFIX}/env" \
  --query SecretString --output text > /etc/pizza-eagle/.env.raw
# Expect a JSON object of {SLACK_APP_TOKEN, SLACK_BOT_TOKEN, ...}
jq -r 'to_entries | .[] | "\(.key)=\(.value)"' /etc/pizza-eagle/.env.raw > "$PTP_BOT_HOME/.env"
chown pizza-eagle:pizza-eagle "$PTP_BOT_HOME/.env"
chmod 600 "$PTP_BOT_HOME/.env"
rm -f /etc/pizza-eagle/.env.raw

#### 5b. GA service account (read-only) — investigations data source
# scripts/ga.mjs reads this path (GA_SA_JSON default) as the pizza-eagle user.
install -d -o pizza-eagle -g pizza-eagle -m 700 /home/pizza-eagle/.config /home/pizza-eagle/.config/ptp
if aws secretsmanager get-secret-value --secret-id "${SECRETS_PREFIX}/ga-readonly" \
     --query SecretString --output text > /home/pizza-eagle/.config/ptp/ga-readonly.json.tmp 2>/dev/null; then
  mv /home/pizza-eagle/.config/ptp/ga-readonly.json.tmp /home/pizza-eagle/.config/ptp/ga-readonly.json
  chown pizza-eagle:pizza-eagle /home/pizza-eagle/.config/ptp/ga-readonly.json
  chmod 600 /home/pizza-eagle/.config/ptp/ga-readonly.json
else
  echo "WARN: secret ${SECRETS_PREFIX}/ga-readonly not found — GA queries stay disabled" >&2
  rm -f /home/pizza-eagle/.config/ptp/ga-readonly.json.tmp
fi

#### 5c. Bugsnag read-only token — investigations data source
install -d -o pizza-eagle -g pizza-eagle -m 700 /home/pizza-eagle/.config /home/pizza-eagle/.config/bugsnag
if aws secretsmanager get-secret-value --secret-id "${SECRETS_PREFIX}/bugsnag-token" \
     --query SecretString --output text > /home/pizza-eagle/.config/bugsnag/readonly-token.tmp 2>/dev/null; then
  mv /home/pizza-eagle/.config/bugsnag/readonly-token.tmp /home/pizza-eagle/.config/bugsnag/readonly-token
  chown pizza-eagle:pizza-eagle /home/pizza-eagle/.config/bugsnag/readonly-token
  chmod 600 /home/pizza-eagle/.config/bugsnag/readonly-token
else
  echo "WARN: secret ${SECRETS_PREFIX}/bugsnag-token not found — Bugsnag checks disabled" >&2
  rm -f /home/pizza-eagle/.config/bugsnag/readonly-token.tmp
fi

#### 6. Operator context + skills for the bot user
install -d -o pizza-eagle -g pizza-eagle -m 755 /opt/pizza-eagle/state
install -o pizza-eagle -g pizza-eagle -m 644 "$PTP_BOT_HOME/agent/AGENTS.md" \
  /opt/pizza-eagle/state/AGENTS.template.md
# Skills (triage, agent-status, ...) — copied once by provisioning, then
# ride the repo via the update timer:
install -d -o pizza-eagle -g pizza-eagle /home/pizza-eagle/.pi/agent/skills
# Skills ride the repo: each skills/<name>/SKILL.md installs into the bot
# user's pi skill directory (updates arrive with the nightly git pull).
if [ -d "$PTP_BOT_HOME/skills" ]; then
  for d in "$PTP_BOT_HOME/skills"/*/; do
    [ -f "${d}SKILL.md" ] || continue
    sname=$(basename "$d")
    install -d -o pizza-eagle -g pizza-eagle -m 755 "/home/pizza-eagle/.pi/agent/skills/$sname"
    install -o pizza-eagle -g pizza-eagle -m 644 "${d}SKILL.md" "/home/pizza-eagle/.pi/agent/skills/$sname/SKILL.md"
  done
fi

#### 6b. pi config for the bot user (models/settings from Secrets Manager).
# pi-config secret holds a SANITIZED models.json — or-pizza provider ONLY
# (env-keyed via OPENROUTER_KEY_PIZZA; the personal provider must never
# reach this box) — plus settings.json defaults. Fails soft: pi errors
# visibly without it.
if aws secretsmanager get-secret-value --secret-id "${SECRETS_PREFIX}/pi-config" \
     --query SecretString --output text > /tmp/pi-config.json 2>/dev/null; then
  install -d -o pizza-eagle -g pizza-eagle -m 700 /home/pizza-eagle/.pi /home/pizza-eagle/.pi/agent
  jq -r 'to_entries[] | .key' /tmp/pi-config.json | while read -r f; do
    # -r is load-bearing: without it jq writes the JSON-string form
    # (double-encoded) and pi can't parse the file
    jq -r --arg f "$f" '.[$f]' /tmp/pi-config.json > "/home/pizza-eagle/.pi/agent/$f"
    chown pizza-eagle:pizza-eagle "/home/pizza-eagle/.pi/agent/$f"
    chmod 600 "/home/pizza-eagle/.pi/agent/$f"
  done
  rm -f /tmp/pi-config.json
else
  echo "WARN: secret ${SECRETS_PREFIX}/pi-config not found — pi has no provider auth" >&2
fi

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
  "$PTP_BOT_HOME/systemd/pizza-eagle.service" \
  "$PTP_BOT_HOME/systemd/pizza-eagle-update.service" \
  "$PTP_BOT_HOME/systemd/pizza-eagle-update.timer" \
  "$PTP_BOT_HOME/systemd/pizza-eagle-backup.service" \
  "$PTP_BOT_HOME/systemd/pizza-eagle-backup.timer" \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pizza-eagle.service pizza-eagle-update.timer pizza-eagle-backup.timer

echo "pizza-eagle bootstrap complete."