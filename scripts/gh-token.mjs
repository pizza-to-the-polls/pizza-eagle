#!/usr/bin/env node
/**
 * gh-token.mjs — mint GitHub App installation tokens for pizza-eagle-brain
 * (Pizza Eagle's GitHub identity, P4). Zero-dep: RS256 JWT via node:crypto;
 * the PEM is fetched from Secrets Manager via the aws CLI (works with the
 * ptp-agent profile locally, the instance role on the ops box) so the key
 * never lands in a file.
 *
 * Usage (GH_APP_ID from env; listener injects it from .env):
 *   node gh-token.mjs list                     # show installations (no mint)
 *   node gh-token.mjs --repo owner/name         # token for that repo's installation
 *
 * Prints the raw token to STDOUT (capture: GH_TOKEN="$(node gh-token.mjs …)")
 * and token metadata to STDERR. Never display the token itself. Tokens
 * expire in 1h.
 *
 * Red team hardening (2026-10-27 — findings 4 + 5):
 *   - --installation <id> minting is REMOVED: it minted an unscoped token
 *     for ANY installation id with no audit ledger entry.
 *   - --repo enforces an allowlist (GITHUB_ALLOWED_REPOS, comma-separated,
 *     default the four PTP repos the bot may touch).
 *   - --repo mints REPO-SCOPED tokens: the POST body carries `repositories`
 *     + minimal `permissions`, so a "hotnready publish token" can no longer
 *     touch every repository on the installation.
 *   - Minting is a write power: it refuses unless the case workdir carries
 *     a listener-written request-auth.json with writeAllowed: true. The
 *     Slack question text cannot forge that file.
 *   - Every mint lands in the usage ledger bound to the requester id.
 *
 * Injection rule: this mints ONLY on PR/publish paths — investigations run
 * with no GitHub credential in the process.
 */
import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const API = "https://api.github.com";
const PEM_SECRET = "ptp/prod/pizza-eagle/gh-app-key";

// Repos the App may act on. Extend via GITHUB_ALLOWED_REPOS only if the
// write gate (AGENTS.md) has been updated too.
const DEFAULT_ALLOWED_REPOS = [
  "pizza-to-the-polls/pizzabase",
  "pizza-to-the-polls/polls.pizza",
  "pizza-to-the-polls/feedflag",
  "pizza-to-the-polls/hotnready",
];
const ALLOWED_REPOS = (process.env.GITHUB_ALLOWED_REPOS ?? DEFAULT_ALLOWED_REPOS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Minimum permissions for the bot's GitHub work: open/push PR branches,
// (feedflag only) merge them, and dispatch issues with the `agent:ready`
// label (dd-agent pickup). Labels and issue comments require `issues: write`
// — issue *creation* succeeds without it, label add 403s (observed
// 2026-10-28: pizzabase#349 filed fine, labels rejected). Must be a subset
// of the installation's grants or GitHub rejects the mint with 422 —
// fail-loud, never fail-wide.
const MINT_PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write" };

/**
 * Case-file authorization — written by the LISTENER from the Slack event's
 * authenticated metadata before each run (src/investigate.ts). The question
 * text lands in case-history.md, which can imitate any *prose* auth marker,
 * but cannot create this file. Helper scripts enforce it independently of
 * the model's good behavior.
 */
export function readRequestAuth(cwd = ".") {
  try {
    const parsed = JSON.parse(readFileSync(`${cwd}/request-auth.json`, "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* no file / unreadable — treated as no write powers */
  }
  return null;
}

// Audit ledger: every mint IS a write-power use (PRs, hotnready publishes).
// Best-effort — a ledger failure must never block a legitimate mint.
function logMint(repo, requester) {
  try {
    appendFileSync(
      process.env.USAGE_LOG ?? "/opt/pizza-eagle/state/usage.jsonl",
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "token-mint",
        requester: requester ?? null,
        detail: repo,
      }) + "\n",
    );
  } catch { /* laptop/dev or missing dir — fine */ }
}

export const b64url = (buf) =>
  Buffer.from(buf).toString("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export function appJwt(pem, appId) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({
    iss: String(appId), iat: now - 60, exp: now + 540, // <10min per GitHub
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(pem))}`;
}

function fetchPem() {
  return execFileSync("aws", [
    "secretsmanager", "get-secret-value",
    "--secret-id", PEM_SECRET,
    "--region", process.env.AWS_REGION ?? "us-west-2",
    "--query", "SecretString", "--output", "text",
  ], { encoding: "utf8" }).trim();
}

async function gh(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pizza-eagle gh-token.mjs",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`GitHub API ${res.status} ${path}: ${JSON.stringify(out).slice(0, 300)}`);
    process.exit(4);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const appId = process.env.GH_APP_ID;
  if (!appId) {
    console.error("GH_APP_ID not set (env or .env — the listener injects it)");
    process.exit(2);
  }

  if (argv[0] === "list") {
    const pem = fetchPem();
    const jwt = appJwt(pem, appId);
    const installs = await gh("/app/installations", { token: jwt });
    for (const i of installs) {
      console.log(JSON.stringify({
        id: i.id, account: i.account?.login, selection: i.repository_selection,
      }));
    }
    return;
  }

  if (argv[0] !== "--repo" || !argv[1]) {
    console.error(
      "usage: gh-token.mjs list | --repo owner/name\n" +
      "  (--installation minting was removed 2026-10-27: unscoped, unaudited)");
    process.exit(1);
  }

  const repo = argv[1];
  if (!ALLOWED_REPOS.includes(repo)) {
    console.error(`FATAL: ${repo} is not on the mint allowlist (${ALLOWED_REPOS.join(", ")})`);
    process.exit(5);
  }

  // Write-power gate: request-auth.json is written by the listener from the
  // Slack event metadata. No file (or writeAllowed !== true) ⇒ no mint.
  const auth = readRequestAuth();
  if (!auth || auth.writeAllowed !== true) {
    console.error(
      "FATAL: write powers not granted for this case (request-auth.json) — " +
      "ask an admin (Scott/Nina/Lee) to request it.");
    process.exit(3);
  }

  const pem = fetchPem();
  const jwt = appJwt(pem, appId);

  const inst = await gh(`/repos/${repo}/installation`, { token: jwt });
  // Repo-scoped mint: without this body GitHub grants the FULL installation
  // (every repo + every permission) — that was the pre-2026-10-27 behavior.
  // `repositories` is installation-relative (name without owner).
  const repoName = repo.split("/")[1];
  const tok = await gh(`/app/installations/${inst.id}/access_tokens`, {
    method: "POST", token: jwt,
    body: { repositories: [repoName], permissions: MINT_PERMISSIONS },
  });

  logMint(repo, auth.requester ?? null);
  console.error(
    `# token expires ${tok.expires_at}; scoped to ${repo} ` +
    `(permissions ${JSON.stringify(MINT_PERMISSIONS)}; requester ${auth.requester ?? "unknown"})`);
  process.stdout.write(tok.token);
}

import { pathToFileURL } from "node:url";
// Run only when executed directly (not when imported by the test suite)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}