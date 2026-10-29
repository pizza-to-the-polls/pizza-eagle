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

test("loadConfig: absent allowlists mean open access (empty sets)", () => {
  const cfg = loadConfig({
    SLACK_APP_TOKEN: "xapp-1-A0TEST-123-abcdef",
    SLACK_BOT_TOKEN: "xoxb-102285951-123-KOxTest",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.allowedChannels.size, 0);
  assert.equal(cfg.allowedUsers.size, 0);
});

test("loadConfig: missing required vars throw", () => {
  assert.throws(() => loadConfig({ SLACK_BOT_TOKEN: "xoxb-1" } as NodeJS.ProcessEnv), /Missing required env var/);
});

// Issue #5 (durable investigation isolation): the listener spawns an isolation
// wrapper instead of pi directly — these keys parameterize the boundary.

test("loadConfig: investigation isolation keys default to the repo wrapper / image / inv user", () => {
  const cfg = loadConfig({ ...validEnv } as NodeJS.ProcessEnv);
  assert.match(
    cfg.invWrapper,
    /scripts[/\\]run-investigation-container\.sh$/,
    "default wrapper is the repo isolation script (absolute — the spawn cwd is the case workdir)",
  );
  assert.equal(cfg.invImage, "pizza-eagle-investigation");
  assert.equal(cfg.invUser, "pizza-eagle-inv", "investigations never run as the listener's OS user");
  assert.ok(cfg.piAgentDir.length > 0, "pi agent config dir has a default");
});

test("loadConfig: investigation isolation keys are env-overridable", () => {
  const cfg = loadConfig({
    ...validEnv,
    INV_WRAPPER: "/custom/wrapper.sh",
    INV_IMAGE: "custom-image",
    INV_USER: "custom-inv",
    PI_AGENT_DIR: "/custom/agent",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.invWrapper, "/custom/wrapper.sh");
  assert.equal(cfg.invImage, "custom-image");
  assert.equal(cfg.invUser, "custom-inv");
  assert.equal(cfg.piAgentDir, "/custom/agent");
});

test("loadConfig: PI_MODEL maps to piModel; unset or blank keeps the settings.json default (issue #34)", () => {
  const withModel = loadConfig({ ...validEnv, PI_MODEL: "or-pizza/z-ai/glm-5v-turbo" } as NodeJS.ProcessEnv);
  assert.equal(withModel.piModel, "or-pizza/z-ai/glm-5v-turbo", "PI_MODEL read into cfg.piModel");

  // Blank (like an empty .env line) is treated as unset — no `--model ""` runs.
  const blank = loadConfig({ ...validEnv, PI_MODEL: "" } as NodeJS.ProcessEnv);
  assert.equal(blank.piModel, undefined, "blank PI_MODEL is undefined, not an empty string");

  const unset = loadConfig(validEnv);
  assert.equal(unset.piModel, undefined, "no PI_MODEL key when unset");
});
