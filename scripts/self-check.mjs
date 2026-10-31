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
 *                                       9. systemd units match the repo
 *                                      10. investigation drop + session resume
 *                                          across the uid boundary (10c)
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
const sh = promisify(execFile);
const AWS_REGION = "us-west-2";

const results = [];
const check = async (name, fn) => {
  try { results.push([await fn() ? "✅" : "❌", name, ""]); }
  catch (e) { results.push(["❌", name, (e.message || "").slice(0, 120)]); }
};

// Env: systemd injects /etc/pizza-eagle/.env (root:600, rendered by bootstrap.sh)
// via EnvironmentFile= in the unit before dropping to this User=pizza-eagle
// process — the file itself is unreadable at this uid, so the injected
// process env is the only correct source. (This block used to re-parse the
// old in-app .env by absolute path — deleted 2026-10-25 — which crashed
// the checker before probe 1; see the 2026-10-27 16:00Z #dev alert.)
const env = process.env;

// 1+2. Slack tokens
const api = async (method, tok) => {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST", // apps.connections.open rejects GET with insecure_request
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
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

// 8. usage ledger summary (last 24h) — the "is this being abused?" eyes
try {
  const lines = (await import("node:fs")).readFileSync("/opt/pizza-eagle/state/usage.jsonl", "utf8").split("\n").filter(Boolean);
  const since = Date.now() - 24 * 3600_000;
  const recent = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((e) => new Date(e.ts).getTime() >= since);
  const byUser = {};
  const writes = [];
  for (const e of recent) {
    if (e.event === "question") byUser[e.requester ?? "?"] = (byUser[e.requester ?? "?"] ?? 0) + 1;
    else writes.push(e);
  }
  const usage = [
    `questions (24h): ${recent.filter((e) => e.event === "question").length} from ${Object.keys(byUser).length} requester(s)` +
      (Object.entries(byUser).length ? " — " + Object.entries(byUser).map(([u, n]) => `<@${u}>: ${n}`).join(", ") : ""),
    `write-powers (24h): ${writes.length ? writes.map((w) => `${w.event} ${w.detail ?? ""}`).join("; ") : "none"}`,
  ];
  results.push(["✅", "usage ledger", usage.join(" | ")]);
} catch (e) {
  results.push(["✅", "usage ledger", "no ledger yet (first question will start it)"]);
}

// 9. systemd units match the repo — drift means a unit-file fix was merged to
// main but never installed on the box (2026-10-28: PR #18's guarded update unit
// was pulled but not installed; the alerting only worked after a human SSM'd
// `install -m 644` + daemon-reload in). install-units.sh (nightly ExecStartPost
// + SSM list) closes the gap; this probe makes any residual drift visible in
// the 09:00 digest instead of latent. Installed units are mode 644
// (world-readable), so reading them as User=pizza-eagle is fine.
await check("systemd units match repo", async () => {
  const repoDir = "/opt/pizza-eagle/systemd";
  const unitDir = "/etc/systemd/system";
  const names = readdirSync(repoDir).filter(
    (f) => f.endsWith(".service") || f.endsWith(".timer"),
  );
  if (!names.length) throw new Error("no unit files in /opt/pizza-eagle/systemd");
  const drift = [];
  for (const name of names) {
    const repo = readFileSync(`${repoDir}/${name}`);
    const installed = existsSync(`${unitDir}/${name}`)
      ? readFileSync(`${unitDir}/${name}`)
      : null;
    if (!installed) {
      drift.push(`${name}: missing from ${unitDir}`);
      continue;
    }
    // Digests rather than raw buffers: no file contents in the digest text.
    const repoSum = createHash("sha256").update(repo).digest("hex");
    const installedSum = createHash("sha256").update(installed).digest("hex");
    if (repoSum !== installedSum) drift.push(`${name}: differs from repo`);
  }
  if (drift.length) {
    throw new Error(
      `unit drift: ${drift.join("; ")} — next update run installs them, ` +
        "or run /opt/pizza-eagle/scripts/install-units.sh now",
    );
  }
  return true;
});

// 10. investigation privilege drop — the wrapper's mode-1/2 boundary.
// 2026-10-31 post-mortem: the box ran EVERY investigation in mode 3
// (unisolated — pi as the listener user, listener env readable) for a full
// day because the unit's red-team seccomp options silently enabled
// NoNewPrivileges and sudo cannot exec setuid under it — and nothing
// alerted, because no probe existed. This check runs INSIDE the unit
// (User=pizza-eagle), so it sees exactly what the listener's children
// see: if the drop is broken here, every investigation is unisolated.
await check("investigation drop (sudo -n -u inv)", async () => {
  const invUser = env.INV_USER ?? "pizza-eagle-inv";
  await sh("sudo", ["-n", "-u", invUser, "--", "true"]);
  return true;
});

// 10b. mode-1 prerequisites (advisory — mode 2 is the accepted fallback):
// missing podman or image means investigations run with a UID boundary but
// no container. Not a page; visible in the digest so the mode-1 rollout
// (container/Dockerfile + build-investigation-image.sh) doesn't rot silently.
try {
  const invUser = env.INV_USER ?? "pizza-eagle-inv";
  await sh("sudo", ["-n", "-u", invUser, "--", "env", `HOME=/home/${invUser}`,
    "podman", "image", "exists", env.INV_IMAGE ?? "pizza-eagle-investigation"]);
  results.push(["✅", "mode 1 (podman) image", "present"]);
} catch {
  results.push(["⚠", "mode 1 (podman)", "unavailable — investigations run mode 2 (UID boundary, no container)"]);
}

// 10c. session resume across the uid boundary (2026-10-31 post-mortem,
// issue #54). The session id is stable per Slack thread, so every follow-up
// RESUMES the same <workdir>/sessions/<file>; files written by the
// pre-isolation mode-3 runs are listener-owned 0644, and without the
// per-run repair (investigate.ts ensureCaseWorkdirPerms) the isolated
// child cannot append them — every pre-boundary thread fails with EACCES
// while new threads keep working. Probe: build the legacy layout, run the
// DEPLOYED repair (dist/investigate.js), then assert the inv user can
// append the file (group pizza-eagle — bootstrap.sh membership).
await check("session resume across the uid boundary", async () => {
  const invUser = env.INV_USER ?? "pizza-eagle-inv";
  const stateRoot = env.BOT_STATE_DIR ?? "/opt/pizza-eagle/state";
  const workRoot = join(stateRoot, "work");
  mkdirSync(workRoot, { recursive: true });
  const scratch = mkdtempSync(join(workRoot, ".selfcheck-"));
  try {
    mkdirSync(join(scratch, "sessions"), { recursive: true });
    const legacy = join(
      scratch, "sessions",
      "2026-10-31T00-00-00-000Z_00000000-0000-4000-8000-000000000000.jsonl",
    );
    writeFileSync(legacy, "{}\n", { mode: 0o644 });
    const { ensureCaseWorkdirPerms } = await import("../dist/investigate.js");
    ensureCaseWorkdirPerms(scratch);
    // The drop must be able to append the legacy file (group pizza-eagle).
    await sh("sudo", ["-n", "-u", invUser, "--", "test", "-w", legacy]);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// digest
const icon = results.some(r => r[0] === "❌") ? ":rotating_light:" : ":white_check_mark:";
const lines = results.map(([ok, name, why]) => `${ok} ${name}${why ? ` — \`${why}\`` : ""}`).join("\n");
const digest = `${icon} *pizza-eagle daily self-check*\n${lines}`;
console.log(digest);

// Ops posture (decided 2026-10-24): silence when green, loud when failing.
// Green runs log to journald/CW only; any ❌ posts the FULL digest so the
// failure arrives with its context. (Checker itself dying: OnFailure chain
// posts the generic unit-failure alert.)
if (results.some(r => r[0] === "❌") && env.SLACK_ALERT_CHANNEL && env.SLACK_BOT_TOKEN) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: env.SLACK_ALERT_CHANNEL, text: digest }),
  });
  const j = await res.json();
  if (!j.ok) console.error("digest post failed:", j.error);
} else if (!results.some(r => r[0] === "❌")) {
  console.log("all green — staying silent in Slack");
}
process.exit(results.some(r => r[0] === "❌") ? 1 : 0);
