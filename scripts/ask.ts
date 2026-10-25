/**
 * Slack-free interface to the investigation runner — for testing agent
 * quality/timing without wiring Slack:
 *
 *   npm run ask -- "why does upload 13280 have no report?"
 *   npm run ask -- --session my-case "follow-up question"   # resume a case
 *
 * Prints the answer to stdout. Same code path as the listener:
 * AGENTS.md context, case-history.md, pi --session-id.
 */
import { randomUUID, createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { runInvestigation } from "../src/investigate.js";
import { workdirFor } from "../src/store.js";

/** --session labels are for humans; sessions are UUIDs. Stable per label. */
function sessionFromLabel(label: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(label)) {
    return label; // already a UUID (e.g. resuming a printed session id)
  }
  const h = createHash("sha256").update(`ask:${label}`).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let session: string | undefined;
  const args = argv.filter((a) => {
    if (a === "--session") return false;
    if (argv[argv.indexOf(a) - 1] === "--session") {
      session = a;
      return false;
    }
    return true;
  });
  const question = args.join(" ").trim();
  if (!question) {
    console.log(
      [
        "usage: npm run ask -- [--session <id>] \"<question>\"",
        "",
        "Each run gets a new session id unless --session is given;",
        "print it below to resume a case across runs.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const cfg = loadConfig();
  const sessionId = session ? sessionFromLabel(session) : randomUUID();
  const workdir = workdirFor(cfg.stateDir, `ask_${sessionId.slice(0, 12)}`);

  const { answer, durationMs } = await runInvestigation(cfg, {
    question,
    sessionId,
    workdir,
  });

  console.log(answer);
  console.error(
    `\n[session ${sessionId} · ${Math.round(durationMs / 1000)}s · workdir ${workdir}]`,
  );
}

void main().catch((e) => {
  console.error("[ask] failed:", e);
  process.exit(1);
});