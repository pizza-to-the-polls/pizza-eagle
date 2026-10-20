/**
 * ptp-bot — Slack front-end around a pi agent session.
 *
 * @ptp-bot <question>  →  ack "🔎 investigating…"  →  pi subprocess  →
 * findings posted to the same thread. Follow-ups in the thread resume
 * the thread's pi session.
 */

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { ThreadStore, workdirFor, type ThreadRecord } from "./store.js";
import { editStatus, postFindings, postStatus, stripMention } from "./slack.js";
import { InvestigationError, runInvestigation } from "./investigate.js";

interface MentionEvent {
  channel: string;
  user: string;
  text: string;
  thread_ts?: string;
  ts: string;
  bot_id?: string;
}

/** Minimal FIFO with concurrency cap — jobs are async, acks are instant. */
class Queue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.stateDir, { recursive: true });
  const store = new ThreadStore(join(cfg.stateDir, "threads.json"));
  const slack = new WebClient(cfg.slackBotToken);
  const queue = new Queue(cfg.maxConcurrent);
  let shuttingDown = false;

  const socket = new SocketModeClient({ appToken: cfg.slackAppToken });

  socket.on("app_mention", async ({ body, ack }) => {
    // Ack FIRST — Slack redelivers unacked events, and our handler does
    // network work (status post) before the actual investigation runs.
    try {
      await ack?.();
    } catch (e) {
      console.error("[ptp-bot] ack failed:", e);
    }
    const event = (body as { event?: MentionEvent })?.event;
    console.log(`[ptp-bot] app_mention received — channel=${event?.channel ?? "?"} user=${event?.user ?? "?"} thread=${event?.thread_ts ?? "(new)"}`);
    if (!event || event.bot_id) return; // no payload, or bot-sourced mention
    try {
      await handle(event);
    } catch (e) {
      console.error("[ptp-bot] handler error:", e);
    }
  });

  async function handle(event: MentionEvent): Promise<void> {
    const question = stripMention(event.text);
    if (!question) return;

    // Allowlists: channels (if configured) and users (if configured).
    if (cfg.allowedChannels.size && !cfg.allowedChannels.has(event.channel)) {
      console.log(`[ptp-bot] ignored mention in un-allowlisted channel ${event.channel}`);
      return;
    }
    if (cfg.allowedUsers.size && !cfg.allowedUsers.has(event.user)) {
      await postStatus(
        slack,
        event.channel,
        event.thread_ts ?? event.ts,
        `:no_entry: <@${event.user}> isn't on the bot's allowlist. Ask an admin to add you.`,
      );
      return;
    }

    const threadTs = event.thread_ts ?? event.ts; // first mention starts a case
    let record: ThreadRecord =
      store.get(threadTs) ??
      ({
        sessionId: randomUUID(),
        channel: event.channel,
        workdir: workdirFor(cfg.stateDir, threadTs),
        questionCount: 0,
        lastRunAt: new Date().toISOString(),
        lastAnswer: null,
      } as ThreadRecord);

    const statusTs = await postStatus(
      slack,
      event.channel,
      threadTs,
      `:mag_right: Investigating — findings land in this thread when it finishes (case \`${record.sessionId.slice(0, 8)}\`, question #${record.questionCount + 1}).`,
    );

    void queue.run(async () => {
      if (shuttingDown) return;
      try {
        const { answer } = await runInvestigation(cfg, {
          question,
          sessionId: record.sessionId,
          workdir: record.workdir,
        });
        if (statusTs) {
          await editStatus(slack, event.channel, statusTs, ":white_check_mark: Investigation finished.");
        }
        await postFindings(slack, event.channel, threadTs, answer);
        record = {
          ...record,
          questionCount: record.questionCount + 1,
          lastRunAt: new Date().toISOString(),
          lastAnswer: answer.slice(0, 500),
        };
        store.put(threadTs, record);
      } catch (e) {
        const detail =
          e instanceof InvestigationError
            ? `${e.message}\n\`\`\`${e.stderr.slice(0, 500)}\n\`\`\``
            : `Unexpected error: ${(e as Error).message}`;
        if (statusTs) {
          await editStatus(slack, event.channel, statusTs, ":x: Investigation failed.");
        }
        await postFindings(slack, event.channel, threadTs, `:x: ${detail}`);
        console.error("[ptp-bot] investigation failed:", e);
      }
    });
  }

  const shutdown = () => {
    shuttingDown = true;
    console.log("[ptp-bot] shutting down");
    void socket.disconnect();
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const slackClientForAuthCheck = new WebClient(cfg.slackBotToken);
  try {
    const me = await slackClientForAuthCheck.auth.test();
    console.log(`[ptp-bot] token ok — bot: @${me.user as string} (${me.user_id}) team: ${me.team as string}`);
  } catch (e) {
    console.warn(`[ptp-bot] bot token failed auth.test: ${(e as Error).message}`);
  }

  socket.on("connecting", () => console.log("[ptp-bot] socket: connecting…"));
  socket.on("connected", () => console.log("[ptp-bot] socket: connected"));
  socket.on("disconnect", () => console.log("[ptp-bot] socket: DISCONNECTED"));
  socket.on("reconnecting", () => console.log("[ptp-bot] socket: reconnecting…"));

  await socket.start();
  console.log(
    `[ptp-bot] up — channels=${cfg.allowedChannels.size || "any"} users=${cfg.allowedUsers.size || "any"} concurrency=${cfg.maxConcurrent}`,
  );
}

main().catch((e) => {
  console.error("[ptp-bot] fatal:", e);
  process.exit(1);
});