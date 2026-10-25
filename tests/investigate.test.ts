import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, closeHistory, openHistory, piArgs } from "../src/investigate.js";
import { stripMention } from "../src/slack.js";
import type { Config } from "../src/config.js";

const cfg = {
  slackAppToken: "xapp-test",
  slackBotToken: "xoxb-test",
  allowedChannels: new Set<string>(),
  allowedUsers: new Set<string>(),
  piBin: "/usr/local/bin/pi",
  stateDir: "/var/lib/pizza-eagle",
  agentDir: "/opt/pizza-eagle/agent",
  timeoutMs: 20 * 60_000,
  maxConcurrent: 2,
} satisfies Config;

test("case history: requester id rides in BEFORE the run (write-gate can verify on Q1)", () => {
  // 2026-10-25 #dev thread: a publish request rode a thread's FIRST question
  // and the gate found no entry — entries were only written after runs.
  const dir = mkdtempSync(join(tmpdir(), "pe-inv-"));
  openHistory(dir, "make a hotnready site", "U2ZLJ2KBP");
  const before = readFileSync(join(dir, "case-history.md"), "utf8");
  assert.ok(before.includes("**Requester:** Slack member `U2ZLJ2KBP`"), "requester line present pre-run");
  assert.ok(before.includes("**Q:** make a hotnready site"), "question preserved pre-run");
  assert.ok(!before.includes("---\n\n"), "entry not closed before the answer lands");
  closeHistory(dir, "answer");
  const after = readFileSync(join(dir, "case-history.md"), "utf8");
  assert.ok(after.includes("answer"), "answer appended");
  assert.ok(after.endsWith("---\n\n"), "entry closed with separator");
});

test("case history: no requester means no requester line", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-inv-"));
  openHistory(dir, "q");
  closeHistory(dir, "a");
  const out = readFileSync(join(dir, "case-history.md"), "utf8");
  assert.ok(!out.includes("**Requester:**"), "no requester line");
});

test("piArgs: question rides as a positional after `--`", () => {
  const args = piArgs(cfg, { question: "why did upload 13297 fail?", sessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
  const sep = args.indexOf("--");
  assert.ok(sep > 0, "`--` separator present");
  assert.equal(args[sep + 1], "why did upload 13297 fail?", "question is the sole positional");
  assert.equal(args.length, sep + 2, "nothing after the question");
  assert.equal(args[0], "--print", "still a print run");
});

test("piArgs: leading-dash question is not parsed as an option (2026-10-26 #dev thread)", () => {
  // Real failing case: mention-stripped text kept its leading dash and pi
  // exited 1 with `Error: Unknown option: - ...` → "Investigation failed."
  const question = stripMention(
    "<@U0CAH280B6E> - I just tried to submit a report and upload a photo",
  );
  assert.equal(question, "- I just tried to submit a report and upload a photo");
  const args = piArgs(cfg, { question, sessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
  const sep = args.indexOf("--");
  assert.equal(args[sep + 1], question, "question verbatim after --, not eaten as a flag");
  assert.equal(args.lastIndexOf(question), sep + 1, "dashed question sits after --");
});

test("piArgs: session routing and --no-approve precede the separator", () => {
  const args = piArgs(cfg, { question: "q", sessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
  const sep = args.indexOf("--");
  assert.deepEqual(args.slice(0, sep), [
    "--print",
    "--session-id", "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    "--session-dir", "/var/lib/pizza-eagle/sessions",
    "--no-approve",
  ]);
});

test("piArgs: --no-approve declines pi project trust (no --approve anywhere)", () => {
  // A planted .pi/extensions/*.ts in the pi-writable workdir executes on
  // the next `--approve` run (verified on pi 1.4.0). The bot never needs
  // project trust: AGENTS.md loads regardless of it.
  const args = piArgs(cfg, { question: "q", sessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
  assert.ok(!args.includes("--approve"), "--approve must not appear (exact match)");
  assert.ok(!args.some((a) => a.startsWith("--approve")), "no --approve/-a form either");
  assert.ok(args.includes("--no-approve"), "--no-approve present");
});

test("piArgs: non-UUID session id is rejected (threads.json is untrusted)", () => {
  for (const bad of ["--tools=*", "--print x", "1234", "", "../../etc"]) {
    assert.throws(
      () => piArgs(cfg, { question: "q", sessionId: bad }),
      /invalid session id/,
      `rejects ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => piArgs(cfg, { question: "   ", sessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" }), /empty question/);
});

test("childEnv: bot Slack credentials never reach the pi child env", () => {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/pizza-eagle",
    SLACK_APP_TOKEN: cfg.slackAppToken,
    SLACK_BOT_TOKEN: cfg.slackBotToken,
    SLACK_TOKEN_ALIAS: cfg.slackBotToken, // same value under a friendlier name
    OPENROUTER_KEY_PIZZA: "sk-or-xyz", // pi's model key — must pass
    AWS_PROFILE: "ptp-agent", // read-only triage — must pass
  };
  const out = childEnv(cfg, env);
  assert.equal(out.SLACK_APP_TOKEN, undefined, "app token stripped");
  assert.equal(out.SLACK_BOT_TOKEN, undefined, "bot token stripped");
  assert.equal(out.SLACK_TOKEN_ALIAS, undefined, "token alias stripped by value");
  assert.equal(out.OPENROUTER_KEY_PIZZA, "sk-or-xyz", "model key passes");
  assert.equal(out.AWS_PROFILE, "ptp-agent", "aws profile passes");
  assert.equal(out.PATH, "/usr/bin:/bin");
});

test("childEnv: cfg tokens are stripped even under unknown names", () => {
  const out = childEnv(cfg, { WHATEVER_HELPER: cfg.slackBotToken, KEEP: "1" });
  assert.equal(out.WHATEVER_HELPER, undefined, "value match strips aliases");
  assert.equal(out.KEEP, "1");
});