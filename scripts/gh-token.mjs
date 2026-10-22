#!/usr/bin/env node
/**
 * gh-token.mjs — mint GitHub App installation tokens for pizza-eagle-brain
 * (Pizza Eagle's GitHub identity, P4). Zero-dep: RS256 JWT via node:crypto;
 * the PEM is fetched from Secrets Manager via the aws CLI (works with the
 * ptp-agent profile locally, the instance role on the ops box) so the key
 * never lands in a file.
 *
 * Usage (GH_APP_ID from env; listener injects it from .env):
 *   node gh-token.mjs list                     # show installations
 *   node gh-token.mjs --repo owner/name         # token for that repo's installation
 *   node gh-token.mjs --installation <id>       # token for an installation id
 *
 * Prints the raw token to STDOUT (capture: GH_TOKEN="$(node gh-token.mjs …)")
 * and token metadata (expires, permissions) to STDERR. Never display the
 * token itself. Tokens expire in 1h.
 *
 * Injection rule: this mints ONLY on PR/publish paths — investigations run
 * with no GitHub credential in the process.
 */
import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";

const API = "https://api.github.com";
const PEM_SECRET = "ptp/prod/pizza-eagle/gh-app-key";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

function appJwt(pem, appId) {
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

async function gh(path, { method = "GET", token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pizza-eagle gh-token.mjs",
      ...(method === "POST" ? {} : {}),
    },
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
  const pem = fetchPem();
  const jwt = appJwt(pem, appId);

  if (argv[0] === "list") {
    const installs = await gh("/app/installations", { token: jwt });
    for (const i of installs) {
      console.log(JSON.stringify({
        id: i.id, account: i.account?.login, selection: i.repository_selection,
      }));
    }
    return;
  }

  let installationId;
  if (argv[0] === "--repo" && argv[1]) {
    const inst = await gh(`/repos/${argv[1]}/installation`, { token: jwt });
    installationId = inst.id;
  } else if (argv[0] === "--installation" && argv[1]) {
    installationId = argv[1];
  } else {
    console.error("usage: gh-token.mjs list | --repo owner/name | --installation <id>");
    process.exit(1);
  }

  const tok = await gh(`/app/installations/${installationId}/access_tokens`, {
    method: "POST", token: jwt,
  });
  console.error(`# token expires ${tok.expires_at}; permissions: ${JSON.stringify(tok.permissions)}`);
  process.stdout.write(tok.token);
}

await main();