import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory, piArgs } from "../src/investigate.js";
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

test("appendHistory: requester id rides into the case file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-inv-"));
  appendHistory(dir, "what changed?", "answer", "U2ZLJ2KBP");
  const out = readFileSync(join(dir, "case-history.md"), "utf8");
  assert.ok(out.includes("**Requester:** Slack member `U2ZLJ2KBP`"), "requester line present");
  assert.ok(out.includes("**Q:** what changed?"), "question preserved");
});

test("appendHistory: no requester means no requester line", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-inv-"));
  appendHistory(dir, "q", "a");
  const out = readFileSync(join(dir, "case-history.md"), "utf8");
  assert.ok(!out.includes("**Requester:**"), "no requester line");
});

test("piArgs: question rides as a positional after `--`", () => {
  const args = piArgs(cfg, { question: "why did upload 13297 fail?", sessionId: "1792954809.028629" });
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
  const args = piArgs(cfg, { question, sessionId: "s1" });
  const sep = args.indexOf("--");
  assert.equal(args[sep + 1], question, "question verbatim after --, not eaten as a flag");
  assert.equal(args.lastIndexOf(question), sep + 1, "dashed question sits after --");
});

test("piArgs: session routing and --approve still precede the separator", () => {
  const args = piArgs(cfg, { question: "q", sessionId: "thread-42" });
  const sep = args.indexOf("--");
  assert.deepEqual(args.slice(0, sep), [
    "--print",
    "--session-id", "thread-42",
    "--session-dir", "/var/lib/pizza-eagle/sessions",
    "--approve",
  ]);
});