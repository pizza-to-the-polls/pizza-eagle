import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appJwt, b64url as ghB64, checkPurposeMint, MINT_PERMISSIONS, PURPOSES, readRequestAuth } from "../scripts/gh-token.mjs";
import { b64url as gaB64, dimensionFilter, parseArgs, resolveDate } from "../scripts/ga.mjs";
import { errorCodeMeaning, normalizeNumber, sinceDaysAgo } from "../scripts/twilio-lookup.mjs";

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
  assert.deepEqual(body.permissions, { contents: "write", pull_requests: "write", issues: "write" }, "minimum permissions — issues:write included so dispatch issues can be labeled agent:ready");
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

// ── purpose mints: unattended box jobs (issue #44) ─────────────────────
//
// A systemd timer has no Slack case, so it can never satisfy the
// request-auth.json gate. Rather than hand it a long-lived PAT, it declares a
// purpose: a hard-coded binding to one repo, a NARROWER permission set, and a
// `timer:` ledger identity. These pin that the purpose path grants strictly
// less than the interactive path and cannot be widened at the call site.

test("gh-token purposes: every binding is narrower than MINT_PERMISSIONS", () => {
  const names = Object.keys(PURPOSES);
  assert.ok(names.length > 0, "at least one purpose is declared");
  for (const name of names) {
    const p = PURPOSES[name as keyof typeof PURPOSES];
    assert.ok(p.repo.includes("/"), `${name}: repo is owner/name`);
    assert.ok(p.requester.startsWith("timer:"), `${name}: ledger identity is prefixed timer:`);
    const keys = Object.keys(p.permissions);
    assert.ok(keys.length > 0, `${name}: declares at least one permission`);
    for (const [k, v] of Object.entries(p.permissions)) {
      assert.ok(
        k in MINT_PERMISSIONS,
        `${name}: permission "${k}" is not one the interactive path holds — a purpose may never grant a new capability`,
      );
      assert.equal(
        v,
        MINT_PERMISSIONS[k as keyof typeof MINT_PERMISSIONS],
        `${name}: "${k}" must match the interactive level, not exceed it`,
      );
    }
    assert.ok(
      keys.length < Object.keys(MINT_PERMISSIONS).length,
      `${name}: a purpose must be a STRICT subset of MINT_PERMISSIONS (${JSON.stringify(p.permissions)})`,
    );
  }
});

test("gh-token checkPurposeMint: pure validation, no I/O", () => {
  const ok = checkPurposeMint("feedflag-digest", "pizza-to-the-polls/feedflag");
  assert.ok("entry" in ok && ok.entry, "valid purpose + matching repo resolves");
  assert.deepEqual(ok.entry?.permissions, { issues: "write" });

  for (const [purpose, repo, why] of [
    ["feedflag-digest", "pizza-to-the-polls/pizzabase", "allowed repo, wrong purpose"],
    ["feedflag-digest", "evilcorp/example", "off-allowlist repo"],
    ["nope", "pizza-to-the-polls/feedflag", "unknown purpose"],
    [undefined, "pizza-to-the-polls/feedflag", "missing purpose name"],
  ] as const) {
    const r = checkPurposeMint(purpose as string | undefined, repo);
    assert.ok("error" in r && r.error, `${why}: refused`);
    assert.equal(r.code, 6, `${why}: distinct exit code 6`);
  }
  assert.match(
    String(checkPurposeMint("nope", "pizza-to-the-polls/feedflag").error),
    /valid: feedflag-digest/,
    "an unknown purpose names the valid ones",
  );
});

test("gh-token: purpose mint needs no request-auth.json and grants issues only", () => {
  // No `auth` — the case file is absent, which refuses the interactive path.
  const r = runHelper(["--repo", "pizza-to-the-polls/feedflag", "--purpose", "feedflag-digest"]);
  assert.equal(r.code, 0, "purpose path mints without request-auth.json");
  const mint = r.calls.find((c) => c.method === "POST");
  assert.ok(mint, "mint POST present");
  const body = JSON.parse(mint.body ?? "{}");
  assert.deepEqual(body.repositories, ["feedflag"], "scoped to the one repo");
  assert.deepEqual(
    body.permissions,
    { issues: "write" },
    "issues only — NOT MINT_PERMISSIONS; a digest must not push branches or merge",
  );
  assert.notDeepEqual(body.permissions, MINT_PERMISSIONS, "never the interactive set");
  assert.match(r.ledger, /"event":"token-mint"/);
  assert.match(r.ledger, /"requester":"timer:feedflag-digest"/, "ledger names the timer, not a human");
  assert.match(r.ledger, /feedflag/);
});

test("gh-token: a purpose cannot be pointed at another repo", () => {
  const r = runHelper(["--repo", "pizza-to-the-polls/pizzabase", "--purpose", "feedflag-digest"], {
    auth: { requester: "U2ZLJ2KBP", writeAllowed: true },
  });
  assert.equal(r.code, 6, "mismatch refuses even with write powers granted");
  assert.equal(r.calls.filter((c) => c.method === "POST").length, 0, "no mint POST");
  assert.equal(r.ledger, "", "no ledger entry for a refused mint");
});

test("gh-token: unknown or valueless --purpose refuses", () => {
  const unknown = runHelper(["--repo", "pizza-to-the-polls/feedflag", "--purpose", "deploy-everything"], {
    auth: { requester: "U2ZLJ2KBP", writeAllowed: true },
  });
  assert.equal(unknown.code, 6, "an undeclared purpose is not mintable");
  assert.equal(unknown.calls.filter((c) => c.method === "POST").length, 0);

  const valueless = runHelper(["--repo", "pizza-to-the-polls/feedflag", "--purpose"]);
  assert.equal(valueless.code, 6, "--purpose with no name refuses");
  assert.equal(valueless.calls.length, 0, "no GitHub calls");
});

test("gh-token: the purpose path still enforces the repo allowlist", () => {
  const r = runHelper(["--repo", "pizza-to-the-polls/feedflag", "--purpose", "feedflag-digest"], {
    env: { GITHUB_ALLOWED_REPOS: "pizza-to-the-polls/hotnready" },
  });
  assert.equal(r.code, 5, "allowlist refusal (5), not a purpose refusal (6)");
  assert.equal(r.calls.length, 0, "no GitHub calls for an off-allowlist repo");
});

test("gh-token: the interactive gate is unchanged by the purpose path", () => {
  // --repo with no --purpose must still require request-auth.json, still grant
  // the full MINT_PERMISSIONS, and still refuse without the case file.
  const noFile = runHelper(["--repo", "pizza-to-the-polls/feedflag"]);
  assert.equal(noFile.code, 3, "the case-file gate still refuses with 3, not 6");
  assert.equal(noFile.calls.length, 0);

  const gated = runHelper(["--repo", "pizza-to-the-polls/feedflag"], {
    auth: { requester: "U2ZLJ2KBP", writeAllowed: true },
  });
  assert.equal(gated.code, 0);
  const body = JSON.parse(gated.calls.find((c) => c.method === "POST")?.body ?? "{}");
  assert.deepEqual(body.permissions, MINT_PERMISSIONS, "interactive mints keep the full set");
  assert.match(gated.ledger, /"requester":"U2ZLJ2KBP"/, "a human requester, not a timer");
});

/**
 * Behavioral test for scripts/install-skills.sh (2026-11-02 skills-sync issue).
 * The script reads REPO_DIR and SKILL_TARGET from the environment
 * (PE_REPO_DIR / PE_SKILL_TARGET), so we can point it at a throwaway repo
 * tree without root or the real /home/pizza-eagle path. Because the harness
 * is not root, the script's ownership guard drops the -o/-g install flags
 * (it only uses them when running as root on the box).
 *
 * Covers the four acceptance-criteria behaviors:
 *   1. First run with a repo skill absent from the target → installed.
 *   2. Second run with no changes → no-op (no `updated:` lines, exit 0).
 *   3. Repo skill changed → re-installed, `updated:` logged.
 *   4. Box-side skill absent from the repo → untouched (never deleted).
 *   5. Repo subdirectory without SKILL.md → silently skipped.
 */
test("twilio-lookup normalizeNumber: E164 passthrough, US completion, junk rejected", () => {
  assert.equal(normalizeNumber("+15038938626"), "+15038938626");
  assert.equal(normalizeNumber("503-893-8626"), "+15038938626");
  assert.equal(normalizeNumber("1 503 893 8626"), "+15038938626");
  assert.equal(normalizeNumber("5038938626"), "+15038938626");
  assert.equal(normalizeNumber("12345"), null, "too short must be rejected, not guessed");
  assert.equal(normalizeNumber(""), null);
});

test("twilio-lookup sinceDaysAgo: Nd window (date-only, for DateSent>=), cap, and garbage rejection", () => {
  const seven = sinceDaysAgo("7d")!;
  assert.match(seven, /^\d{4}-\d{2}-\d{2}$/, "must be date-only — a full timestamp in DateSent= means an exact-second match");
  assert.ok(new Date(seven).getTime() <= Date.now() - 6.9 * 86_400_000);
  const capped = sinceDaysAgo("400d")!;
  assert.ok(new Date(capped).getTime() > Date.now() - 366 * 86_400_000, "window must cap at 365d");
  assert.equal(sinceDaysAgo("last week"), null);
});

test("twilio-lookup errorCodeMeaning: known codes translated, 0/unknown pass through", () => {
  assert.match(errorCodeMeaning("30006")!, /landline/);
  assert.match(errorCodeMeaning(30004)!, /blocked/);
  assert.equal(errorCodeMeaning(0), null, "0 is success, not an error");
  assert.equal(errorCodeMeaning(null), null);
  assert.match(errorCodeMeaning("99999")!, /99999/);
});

test("run-investigation-container.sh: repairs pre-isolation session perms before the drop (issue #54)", () => {
  // Defense in depth behind investigate.ts:ensureCaseWorkdirPerms — the
  // wrapper re-opens legacy (listener-owned 0644) session files for the
  // dropped user and pins the sessions dir setgid so new files land in
  // group pizza-eagle whatever uid creates them. Mode 3 (INV_USER points
  // at a missing user → no drop) exercises the same repair lines as the
  // box modes; PI_BIN=/bin/true keeps pi itself out of the test.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const script = join(repoRoot, "scripts", "run-investigation-container.sh");
  const tmp = mkdtempSync(join(tmpdir(), "pe-wrap-perms-"));
  try {
    mkdirSync(join(tmp, "sessions"), { recursive: true });
    const legacy = join(
      tmp, "sessions",
      "2026-10-31T00-00-00-000Z_00000000-0000-4000-8000-000000000000.jsonl",
    );
    writeFileSync(legacy, "{}\n");
    chmodSync(legacy, 0o644); // exact pre-isolation mode, umask-proof

    const r = spawnSync(
      "bash",
      [script, tmp, "11111111-1111-4111-8111-111111111111", "probe"],
      {
        cwd: tmp,
        env: {
          ...process.env,
          PI_BIN: spawnSync("bash", ["-c", "command -v true"], { encoding: "utf8" }).stdout.trim(),
          INV_USER: "no-such-inv-user",
          PI_AGENT_DIR: join(tmp, "no-agent-dir"),
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, `wrapper failed: ${r.stderr}`);
    assert.match(r.stderr, /mode 3 — NO ISOLATION/, "expected the mode-3 fallback");
    assert.equal(
      statSync(join(tmp, "sessions")).mode & 0o7777, 0o2770,
      "sessions dir must be setgid 2770",
    );
    assert.equal(
      statSync(legacy).mode & 0o777, 0o664,
      "legacy 0644 session file must gain group rw for the dropped user",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("install-skills.sh: installs new skills, no-ops on identical, re-installs on change, never deletes orphans", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const script = join(repoRoot, "scripts", "install-skills.sh");

  const tmp = mkdtempSync(join(tmpdir(), "pe-skills-"));
  const repoDir = join(tmp, "repo");
  const targetDir = join(tmp, "target");
  mkdirSync(join(repoDir, "skills", "ga"), { recursive: true });
  mkdirSync(targetDir, { recursive: true });

  // A real repo skill in the fake repo tree.
  writeFileSync(join(repoDir, "skills", "ga", "SKILL.md"), "# ga skill v1");
  // A box-side orphan that is NOT in the repo — must survive every run.
  writeFileSync(join(targetDir, "orphan-skill"), "should survive");

  const runScript = () =>
    spawnSync("bash", [script], {
      cwd: repoDir,
      env: { ...process.env, PE_REPO_DIR: repoDir, PE_SKILL_TARGET: targetDir },
      encoding: "utf8",
    });

  // Run 1: ga is absent from the target → installed, and logged.
  const r1 = runScript();
  assert.equal(r1.status, 0, `script failed: ${r1.stderr}`);
  assert.match(r1.stdout, /updated: ga\/SKILL\.md/, "first run must log the new skill");
  assert.equal(
    readFileSync(join(targetDir, "ga", "SKILL.md"), "utf8"),
    "# ga skill v1",
    "installed file must match the repo source",
  );

  // Run 2: nothing changed → no-op (no `updated:` line, but clean exit).
  const r2 = runScript();
  assert.equal(r2.status, 0, `script failed: ${r2.stderr}`);
  assert.doesNotMatch(r2.stdout, /updated:/, "unchanged skill must be skipped");
  assert.match(r2.stdout, /all skills current — no changes/, "no-op run must report no changes");

  // Run 3: the repo skill changed → re-installed and logged again.
  writeFileSync(join(repoDir, "skills", "ga", "SKILL.md"), "# ga skill v2");
  const r3 = runScript();
  assert.equal(r3.status, 0, `script failed: ${r3.stderr}`);
  assert.match(r3.stdout, /updated: ga\/SKILL\.md/, "changed skill must be re-installed and logged");
  assert.equal(
    readFileSync(join(targetDir, "ga", "SKILL.md"), "utf8"),
    "# ga skill v2",
    "changed skill must be updated in the target",
  );

  // Run 4: the box-side orphan survived every run (add/update only, no deletes).
  assert.equal(
    readFileSync(join(targetDir, "orphan-skill"), "utf8"),
    "should survive",
    "box-side skill absent from the repo must never be touched",
  );

  // Run 5: a repo subdirectory without SKILL.md is not a skill → skipped.
  mkdirSync(join(repoDir, "skills", "empty-dir"));
  const r5 = runScript();
  assert.equal(r5.status, 0, `script failed: ${r5.stderr}`);
  assert.doesNotMatch(r5.stdout, /updated:/, "subdir without SKILL.md must not be installed");
  assert.ok(!existsSync(join(targetDir, "empty-dir")), "subdir without SKILL.md must not appear in the target");
});
