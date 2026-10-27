import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appJwt, b64url as ghB64, readRequestAuth } from "../scripts/gh-token.mjs";
import { b64url as gaB64, dimensionFilter, parseArgs, resolveDate } from "../scripts/ga.mjs";

test("ga + gh b64url: URL-safe, no padding, -/_ alphabet", () => {
  for (const b64 of [gaB64, ghB64]) {
    assert.equal(b64(Buffer.from("abc")), "YWJj");
    assert.equal(b64(Buffer.from("ab")), "YWI"); // stripped padding
    assert.ok(!b64(Buffer.from("a/b+c")).includes("+"), "+ becomes -");
    assert.equal(b64(Buffer.from("a/b+c")), "YS9iK2M");
  }
});

test("ga parseArgs: repeatable flags collect into arrays", () => {
  const { cmd, flags } = parseArgs(["report", "--dim", "date", "--dim", "country", "--metric", "sessions", "--limit", "10"]);
  assert.equal(cmd, "report");
  assert.deepEqual(flags.dim, ["date", "country"]);
  assert.deepEqual(flags.metric, ["sessions"]);
  assert.deepEqual(flags.limit, ["10"]);
});

test("ga resolveDate: 'today', relative Nd, and ISO passthrough", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(resolveDate("today"), today);
  assert.equal(resolveDate("2026-10-01"), "2026-10-01");
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(resolveDate("3d"), threeDaysAgo);
});

test("ga dimensionFilter: single value = EXACT string filter; comma = in-list", () => {
  const single = dimensionFilter("country=US");
  const f = single.andGroup.expressions[0].filter;
  assert.equal(f.fieldName, "country");
  assert.equal(f.stringFilter.matchType, "EXACT");
  assert.equal(f.stringFilter.value, "US");
  const list = dimensionFilter("pagePath=/donate,/report");
  const lf = list.andGroup.expressions[0].filter;
  assert.deepEqual(lf.inListFilter.values, ["/donate", "/report"]);
});

test("gh appJwt: three segments, valid RS256 signature, claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwt = appJwt(pem, 5434163);
  const [h, c, s] = jwt.split(".");
  assert.equal(h.length + c.length + s.length, jwt.length - 2, "exactly three segments");
  const dec = (x: string) => JSON.parse(Buffer.from(x, "base64url").toString());
  assert.deepEqual(dec(h), { alg: "RS256", typ: "JWT" });
  const claims = dec(c);
  assert.equal(claims.iss, "5434163");
  assert.ok(claims.exp - claims.iat <= 600 + 120, "GitHub max JWT lifetime is 10 minutes");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${c}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(s, "base64url")), "signature verifies with the public key");
});

// ── gh-token mint hardening (red team 2026-10-27, findings 4+5) ────────────

interface GhCall { url: string; method: string; body: string | null }

/**
 * Run gh-token.mjs in a child node process with AWS (PEM) + GitHub (fetch)
 * mocked. Captures every HTTP call; overrides process.exit so calls are
 * printed even on failure paths. The signing key is generated in-memory in
 * the child and never written anywhere.
 */
function runHelper(
  args: string[],
  opts: { auth?: unknown; env?: Record<string, string> } = {},
): { code: number; calls: GhCall[]; ledger: string } {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const helper = join(repoRoot, "scripts", "gh-token.mjs");
  const cwd = mkdtempSync(join(tmpdir(), "pe-ght-"));
  if (opts.auth !== undefined) {
    writeFileSync(join(cwd, "request-auth.json"), JSON.stringify(opts.auth));
  }
  const script = `
import cp from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
// Ephemeral test-only signing key, memory-only, never written.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
cp.execFileSync = () => privateKey.export({ type: "pkcs8", format: "pem" }).toString();
syncBuiltinESMExports();
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method ?? "GET", body: options.body ?? null });
  const u = String(url);
  if (u.endsWith("/access_tokens"))
    return { ok: true, json: async () => ({ token: "synthetic-test-only", expires_at: "t", permissions: {} }) };
  if (u.endsWith("/app/installations"))
    return { ok: true, json: async () => [] };
  if (u.includes("/installation"))
    return { ok: true, json: async () => ({ id: 777 }) };
  return { ok: true, json: async () => ({}) };
};
process.argv = [process.execPath, ${JSON.stringify(helper)}, ...${JSON.stringify(args)}];
const realWrite = process.stdout.write.bind(process.stdout);
const realExit = process.exit.bind(process);
process.stdout.write = () => true; // never print the synthetic token
process.exit = (code) => { realWrite("CALLS:" + JSON.stringify(calls)); realExit(code); };
try {
  await import(pathToFileURL(${JSON.stringify(helper)}));
} catch (e) {
  process.stderr.write(String(e));
  process.exit(1);
}
realWrite("CALLS:" + JSON.stringify(calls));
`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: script,
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      ...opts.env,
      GH_APP_ID: "5434163",
      USAGE_LOG: join(cwd, "usage.jsonl"),
      HOME: cwd,
    },
  });
  const marker = "CALLS:";
  const idx = res.stdout.lastIndexOf(marker);
  const calls = idx >= 0 ? (JSON.parse(res.stdout.slice(idx + marker.length)) as GhCall[]) : [];
  return {
    code: res.status ?? 1,
    calls,
    ledger: existsSync(join(cwd, "usage.jsonl")) ? readFileSync(join(cwd, "usage.jsonl"), "utf8") : "",
  };
}

test("gh-token: mint is repo-scoped, permission-scoped, and audited", () => {
  const r = runHelper(["--repo", "pizza-to-the-polls/hotnready"], {
    auth: { requester: "U2ZLJ2KBP", writeAllowed: true },
  });
  assert.equal(r.code, 0, "mint succeeds for gated requester");
  const mint = r.calls.find((c) => c.method === "POST");
  assert.ok(mint, "mint POST present");
  assert.ok(mint.url.endsWith("/app/installations/777/access_tokens"));
  const body = JSON.parse(mint.body ?? "{}");
  // The pre-fix behavior was an empty body = FULL installation access.
  assert.deepEqual(body.repositories, ["hotnready"], "token scoped to one repo");
  assert.deepEqual(body.permissions, { contents: "write", pull_requests: "write" }, "minimum permissions");
  assert.match(r.ledger, /"event":"token-mint"/);
  assert.match(r.ledger, /"requester":"U2ZLJ2KBP"/);
  assert.match(r.ledger, /hotnready/);
});

test("gh-token: no mint without write powers (request-auth.json gate)", () => {
  const noGate = runHelper(["--repo", "pizza-to-the-polls/hotnready"], {
    auth: { requester: "U9STRANGER", writeAllowed: false },
  });
  assert.notEqual(noGate.code, 0, "writeAllowed:false refuses");
  assert.equal(noGate.calls.filter((c) => c.method === "POST").length, 0, "no mint POST");

  const noFile = runHelper(["--repo", "pizza-to-the-polls/hotnready"], {});
  assert.notEqual(noFile.code, 0, "missing request-auth.json refuses");
  assert.equal(noFile.calls.length, 0, "no GitHub calls at all");
});

test("gh-token: repo allowlist is enforced (no off-list minting)", () => {
  const r = runHelper(["--repo", "evilcorp/example"], {
    auth: { requester: "U2ZLJ2KBP", writeAllowed: true },
    env: { GITHUB_ALLOWED_REPOS: "pizza-to-the-polls/hotnready" },
  });
  assert.notEqual(r.code, 0);
  assert.equal(r.calls.length, 0, "no GitHub calls for off-allowlist repo");
});

test("gh-token: raw --installation minting is gone", () => {
  // 2026-10-27: --installation minted an unscoped token for ANY installation
  // id, with no ledger entry. Removed.
  const r = runHelper(["--installation", "123"], {
    auth: { requester: "U2ZLJ2KBP", writeAllowed: true },
  });
  assert.notEqual(r.code, 0, "--installation must fail");
  assert.equal(r.calls.length, 0, "no GitHub calls");
  assert.equal(r.ledger, "", "no ledger entry");
});

test("gh-token: list stays read-only and needs no write gate", () => {
  const r = runHelper(["list"], { auth: { requester: "U1", writeAllowed: false } });
  assert.equal(r.code, 0);
  assert.ok(r.calls.some((c) => c.url.endsWith("/app/installations") && c.method === "GET"));
  assert.equal(r.calls.filter((c) => c.method === "POST").length, 0, "list never mints");
});

test("gh-token readRequestAuth: absent/unreadable file ⇒ null", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-ra-"));
  assert.equal(readRequestAuth(dir), null, "no file");
  writeFileSync(join(dir, "request-auth.json"), "{ not json");
  assert.equal(readRequestAuth(dir), null, "unparseable");
  writeFileSync(join(dir, "request-auth.json"), JSON.stringify({ writeAllowed: true }));
  assert.deepEqual(readRequestAuth(dir), { writeAllowed: true });
});
