#!/usr/bin/env node
/**
 * health-check.mjs — the OFF-BOX health check (runs from GitHub Actions on
 * a schedule, completely independent of the pizza-eagle box and agent).
 *
 * Probes from outside: if the box is dead, this still runs and reports.
 *   1. heartbeat metric fresh (<15 min) — proves the agent process is alive
 *   2. latest state backup <26h old
 *   3. bot + app Slack tokens valid
 * Posture (decided 2026-10-24): SILENT when green, posts the full digest to
 * the ops channel only when something fails. Uses the deploy role's read
 * grants; Slack creds come from the env secret.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const sh = promisify(execFile);
const fails = [];
const info = [];
const check = async (name, fn) => {
  try { await fn(); info.push(`✅ ${name}`); }
  catch (e) { fails.push(`❌ ${name} — ${String(e.message || e).slice(0, 140)}`); }
};

// env secret carries tokens + alert channel
let env;
await check("env secret readable", async () => {
  const { stdout } = await sh("aws", ["secretsmanager", "get-secret-value",
    "--secret-id", "ptp/prod/pizza-eagle/env", "--query", "SecretString",
    "--region", "us-west-2", "--output", "text"]);
  env = JSON.parse(stdout.trim());
});
if (env) {
  await check("bot token (auth.test)", async () => {
    const r = await fetch("https://slack.com/api/auth.test", {
      method: "POST", headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
  });
  await check("app token (apps.connections.open)", async () => {
    const r = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST", headers: { Authorization: `Bearer ${env.SLACK_APP_TOKEN}` } });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
  });
}
await check("heartbeat metric <15 min old (agent alive)", async () => {
  const { stdout } = await sh("aws", ["cloudwatch", "get-metric-statistics",
    "--namespace", "pizza-eagle", "--metric-name", "Heartbeat",
    "--start-time", new Date(Date.now() - 15 * 60_000).toISOString(),
    "--end-time", new Date().toISOString(), "--period", "300",
    "--statistics", "Sum", "--region", "us-west-2"]);
  if (!JSON.parse(stdout).Datapoints?.length) throw new Error("no heartbeats in 15 min — agent is dead or the box is down");
});
await check("state backup <26h old", async () => {
  const { stdout } = await sh("aws", ["s3", "ls", "s3://pizza-eagle-backups/", "--region", "us-west-2"]);
  const rows = stdout.trim().split("\n").filter(Boolean);
  if (!rows.length) throw new Error("no backups in bucket");
  const [d, t] = rows[rows.length - 1].split(/\s+/).slice(0, 2);
  const age = (Date.now() - new Date(`${d}T${t}Z`).getTime()) / 3600_000;
  if (age > 26) throw new Error(`latest backup is ${age.toFixed(1)}h old`);
});

console.log([...info, ...fails].join("\n"));
if (fails.length && env?.SLACK_BOT_TOKEN && env?.SLACK_ALERT_CHANNEL) {
  const text = `:rotating_light: *pizza-eagle health check FAILED* (off-box, GitHub Actions)\n${fails.join("\n")}`;
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: env.SLACK_ALERT_CHANNEL, text }),
  });
  const j = await r.json();
  if (!j.ok) console.error("slack post failed:", j.error);
} else if (!fails.length) {
  console.log("all green — staying silent in Slack");
}
process.exit(fails.length ? 1 : 0);
