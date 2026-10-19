/**
 * Smoke test — exercises everything except Slack itself:
 *   1. config validation errors
 *   2. thread store roundtrip
 *   3. markdown chunking
 *   4. a real end-to-end pi subprocess investigation (skip with SMOKE_SKIP_PI=1)
 *
 * Run: npm run smoke
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { ThreadStore, workdirFor } from "../src/store.js";
import { chunkMarkdown, stripMention } from "../src/slack.js";
import { runInvestigation } from "../src/investigate.js";

let failed = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${name}`);
  if (!cond) failed++;
};

async function main(): Promise<void> {
  // 1. config validation
  try {
    loadConfig({});
    ok("config rejects missing tokens", false);
  } catch (e) {
    ok(`config rejects missing tokens (${(e as Error).message.split(":")[0]})`, true);
  }

  // 2. store roundtrip
  const tmp = mkdtempSync(join(tmpdir(), "ptp-bot-smoke-"));
  const store = new ThreadStore(join(tmp, "threads.json"));
  store.put("1234.0001", {
    sessionId: "test-session",
    channel: "C1",
    workdir: join(tmp, "w"),
    questionCount: 1,
    lastRunAt: new Date().toISOString(),
    lastAnswer: "yes",
  });
  const reloaded = new ThreadStore(join(tmp, "threads.json")).get("1234.0001");
  ok("thread store roundtrip", reloaded?.sessionId === "test-session");

  // 3. chunking
  const long = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n\n");
  const chunks = chunkMarkdown(long, 3800);
  ok(
    `chunking (${chunks.length} chunks, all ≤3800)`,
    chunks.every((c) => c.length <= 3800) && chunks.join("").length > 0,
  );
  ok("short text stays single chunk", chunkMarkdown("hello", 3800).length === 1);
  ok(
    "stripMention",
    stripMention("<@U0BOT123> why is upload 13280 orphaned?") === "why is upload 13280 orphaned?",
  );

  // 4. end-to-end pi subprocess (uses the real pi on PATH + real ~/.pi)
  if (!process.env.SMOKE_SKIP_PI) {
    const cfg = loadConfig({
      ...process.env,
      SLACK_APP_TOKEN: "xapp-smoke",
      SLACK_BOT_TOKEN: "xoxb-smoke",
      BOT_STATE_DIR: tmp,
      AGENT_DIR: join(process.cwd(), "agent"),
      INVESTIGATE_TIMEOUT_MS: String(120_000),
    });
    const sessionId = `smoke-${Date.now()}`;
    const workdir = workdirFor(tmp, "9999.0001");
    const { answer } = await runInvestigation(cfg, {
      question: "Reply with exactly the word OK and nothing else.",
      sessionId,
      workdir,
    });
    ok(`pi subprocess roundtrip (answer: ${answer.slice(0, 40)})`, answer.length > 0);
    ok(
      "AGENTS.md copied into workdir",
      existsSync(join(workdir, "AGENTS.md")),
    );
    ok(
      "case-history.md written",
      readFileSync(join(workdir, "case-history.md"), "utf8").includes("Reply with exactly"),
    );

    // follow-up in the same "thread" resumes the same session
    const { answer: second } = await runInvestigation(cfg, {
      question: "What did I just ask you to reply with? Answer in one word.",
      sessionId,
      workdir,
    });
    ok(
      `session resume across follow-ups (answer: ${second.slice(0, 40)})`,
      /ok/i.test(second),
    );
  } else {
    console.log("− pi subprocess skipped (SMOKE_SKIP_PI=1)");
  }

  rmSync(tmp, { recursive: true, force: true });
  if (failed) {
    console.error(`\n${failed} smoke checks failed`);
    process.exit(1);
  }
  console.log("\nall smoke checks passed");
}

void main();