#!/usr/bin/env node
/**
 * self-check.mjs — pizza-eagle's daily health digest.
 *
 * Runs probes that answer "is everything fine?" and posts a ✅/⚠️/❌ digest
 * to the ops channel (SLACK_ALERT_CHANNEL, bot token). Installed as
 * pizza-eagle-selfcheck.timer (daily). Exit 1 if anything is ❌ — systemd
 * OnFailure then posts the loud unit-failure alert too.
 *
 * Zero-dep (plain node + aws CLI + fetch). Probes:
 *   1. bot token valid (auth.test)      5. disk space on /opt/pizza-eagle
 *   2. app token valid (apps.connections.open)
 *   3. bot secrets readable             6. heartbeat metric fresh (<15 min)
 *   4. backup tarball fresh (<26h)      7. service active (this runs on the box)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const sh = promisify(execFile);
const AWS_REGION = "us-west-2";

const results = [];
const check = async (name, fn) => {
  try { results.push([await fn() ? "✅" : "❌", name, ""]); }
  catch (e) { results.push(["❌", name, (e.message || "").slice(0, 120)]); }
};

const env = {};
for (const line of (await import("node:fs")).readFileSync("/opt/pizza-eagle/.env", "utf8").split("\n")) {
  const eq = line.indexOf("=");
  if (eq > 0 && !line.startsWith("#")) env[line.slice(0, eq)] = line.slice(eq + 1);
}

// 1+2. Slack tokens
const api = async (method, tok) => {
  const res = await fetch(`https://slack.com/api/${method}`, { headers: { Authorization: `Bearer ${tok}` } });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error ?? "slack api not ok");
  return j;
};
await check("bot token (auth.test)", async () => { await api("auth.test", env.SLACK_BOT_TOKEN); return true; });
await check("app token (apps.connections.open)", async () => { await api("apps.connections.open", env.SLACK_APP_TOKEN); return true; });

// 3. secrets readable
await check("bot env secret readable", async () => {
  const { stdout } = await sh("aws", ["secretsmanager", "describe-secret", "--secret-id", "ptp/prod/pizza-eagle/env", "--region", AWS_REGION]);
  return stdout.includes("ptp/prod/pizza-eagle/env");
});

// 4. backup fresh (<26h)
await check("backup tarball <26h old", async () => {
  const { stdout } = await sh("aws", ["s3", "ls", "s3://pizza-eagle-backups/", "--region", AWS_REGION]);
  const rows = stdout.trim().split("\n").filter(Boolean);
  if (!rows.length) throw new Error("no backups in bucket");
  const [d, t] = rows[rows.length - 1].split(/\s+/).slice(0, 2);
  const age = (Date.now() - new Date(`${d}T${t}Z`).getTime()) / 3600_000;
  if (age > 26) throw new Error(`latest backup is ${age.toFixed(1)}h old`);
  return true;
});

// 5. disk
await check("disk usage <80%", async () => {
  const { stdout } = await sh("df", ["-h", "/opt/pizza-eagle"]);
  const pct = parseInt(stdout.match(/(\d+)%/)?.[1] ?? "0", 10);
  if (pct >= 80) throw new Error(`disk at ${pct}%`);
  return true;
});

// 6. heartbeat fresh
await check("heartbeat metric <15 min old", async () => {
  const start = new Date(Date.now() - 15 * 60_000).toISOString();
  const end = new Date().toISOString();
  const { stdout } = await sh("aws", ["cloudwatch", "get-metric-statistics",
    "--namespace", "pizza-eagle", "--metric-name", "Heartbeat",
    "--start-time", start, "--end-time", end, "--period", "300",
    "--statistics", "Sum", "--region", AWS_REGION]);
  const datapoints = JSON.parse(stdout).Datapoints?.length ?? 0;
  if (!datapoints) throw new Error("no heartbeats in the last 15 minutes");
  return true;
});

// 7. service
await check("pizza-eagle.service active", async () => {
  const { stdout } = await sh("systemctl", ["is-active", "pizza-eagle.service"]);
  return stdout.trim() === "active";
});

// digest
const icon = results.some(r => r[0] === "❌") ? ":rotating_light:" : ":white_check_mark:";
const lines = results.map(([ok, name, why]) => `${ok} ${name}${why ? ` — \`${why}\`` : ""}`).join("\n");
const digest = `${icon} *pizza-eagle daily self-check*\n${lines}`;
console.log(digest);

if (env.SLACK_ALERT_CHANNEL && env.SLACK_BOT_TOKEN) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: env.SLACK_ALERT_CHANNEL, text: digest }),
  });
  const j = await res.json();
  if (!j.ok) console.error("digest post failed:", j.error);
}
process.exit(results.some(r => r[0] === "❌") ? 1 : 0);
