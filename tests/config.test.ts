import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadEnvFile, mergedEnv } from "../src/config.js";

const validEnv = {
  SLACK_APP_TOKEN: "xapp-1-A0TEST-123-abcdef",
  SLACK_BOT_TOKEN: "xoxb-102285951-123-KOxTest",
  ALLOWED_CHANNELS: "C01DY42HH96,C02TEST",
  ALLOWED_USERS: "U2ZLJ2KBP",
} as NodeJS.ProcessEnv;

test("loadEnvFile: parses comments, blanks, and quoted values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-cfg-"));
  const f = join(dir, "env");
  writeFileSync(f, '# comment\nA=1\n\nB="two words"\nC=\'sq\'\nNOEQ\n');
  const parsed = loadEnvFile(f);
  assert.deepEqual(parsed, { A: "1", B: "two words", C: "sq" });
});

test("loadEnvFile: missing file yields empty object", () => {
  assert.deepEqual(loadEnvFile("/nonexistent/nope.env"), {});
});

test("mergedEnv: real env wins over file values", () => {
  // mergedEnv reads ./.env from cwd (tests run in a clean checkout; .env is
  // gitignored) — create one temporarily and clean up.
  writeFileSync(".env", "X=filevalue\nY=filevalue\n");
  try {
    const merged = mergedEnv({ X: "envvalue" } as NodeJS.ProcessEnv);
    assert.equal(merged.X, "envvalue");
    assert.equal(merged.Y, "filevalue");
  } finally {
    rmSync(".env");
  }
});

test("loadConfig: applies defaults", () => {
  const cfg = loadConfig({ ...validEnv } as NodeJS.ProcessEnv);
  assert.equal(cfg.piBin, "pi");
  assert.equal(cfg.stateDir, "./state");
  assert.equal(cfg.agentDir, "./agent");
  assert.equal(cfg.timeoutMs, 10 * 60_000);
  assert.equal(cfg.maxConcurrent, 2);
});

test("loadConfig: parses comma-separated allowlists into sets", () => {
  const cfg = loadConfig({ ...validEnv } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.allowedChannels, new Set(["C01DY42HH96", "C02TEST"]));
  assert.deepEqual(cfg.allowedUsers, new Set(["U2ZLJ2KBP"]));
});

test("loadConfig: rejects wrong token types", () => {
  assert.throws(() => loadConfig({ ...validEnv, SLACK_APP_TOKEN: "xoxb-wrong" } as NodeJS.ProcessEnv), /app token/);
  assert.throws(() => loadConfig({ ...validEnv, SLACK_BOT_TOKEN: "xapp-wrong" } as NodeJS.ProcessEnv), /bot token/);
});

test("loadConfig: missing required vars throw", () => {
  assert.throws(() => loadConfig({ SLACK_BOT_TOKEN: "xoxb-1" } as NodeJS.ProcessEnv), /Missing required env var/);
});
