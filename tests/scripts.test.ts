import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, b64url as ghB64 } from "../scripts/gh-token.mjs";
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
