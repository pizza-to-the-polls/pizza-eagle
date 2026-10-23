/**
 * pizza-eagle — Slack front-end around a pi agent session.
 *
 * @pizza-eagle <question>  →  ack "🔎 investigating…"  →  pi subprocess  →
 * findings posted to the same thread. Follow-ups in the thread resume
 * the thread's pi session.
 */

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { ThreadStore, workdirFor, type ThreadRecord } from "./store.js";
import Bugsnag from "@bugsnag/js";
import { editStatus, fetchThreadContext, postFindings, postStatus, react, stripMention } from "./slack.js";
import { InvestigationError, runInvestigation, activeInvestigations } from "./investigate.js";

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

function report(e: unknown): void {
  // no-op until Bugsnag.start() ran (no key configured → local-only errors).
  // Cast: @bugsnag/js's dual-mode .d.ts types mis-resolve under NodeNext;
  // the runtime default export has .notify (verified by the Bugsnag smoke).
  const bs = Bugsnag as unknown as { notify?: (e: unknown) => void };
  try { bs.notify?.(e); } catch { /* not started */ }
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
      console.error("[pizza-eagle] ack failed:", e);
    }
    const event = (body as { event?: MentionEvent })?.event;
    console.log(`[pizza-eagle] app_mention received — channel=${event?.channel ?? "?"} user=${event?.user ?? "?"} thread=${event?.thread_ts ?? "(new)"}`);
    if (!event || event.bot_id) return; // no payload, or bot-sourced mention
    try {
      await handle(event);
    } catch (e) {
      console.error("[pizza-eagle] handler error:", e);
    }
  });

  async function handle(event: MentionEvent): Promise<void> {
    const question = stripMention(event.text);
    if (!question) return;

    // Allowlists: channels (if configured) and users (if configured).
    if (cfg.allowedChannels.size && !cfg.allowedChannels.has(event.channel)) {
      console.log(`[pizza-eagle] ignored mention in un-allowlisted channel ${event.channel}`);
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

    // Thread review: pull the whole conversation the mention landed in so
    // the investigation sees prior discussion (needs channels:history on the
    // app; degrades to empty + warn until that scope is granted).
    let threadContext = "";
    if (event.thread_ts) {
      try {
        threadContext = await fetchThreadContext(slack, event.channel, event.thread_ts);
      } catch (e) {
        console.warn("[pizza-eagle] thread context unavailable:", (e as Error).message);
      }
    }

    const statusTs = await postStatus(
      slack,
      event.channel,
      threadTs,
      `:mag_right: Investigating — findings land in this thread when it finishes (case \`${record.sessionId.slice(0, 8)}\`, question #${record.questionCount + 1}).`,
    );

    void queue.run(async () => {
      if (shuttingDown) return;
      // :pizza-eagle-working: on the thread parent while we're working; removed when done
      // (success or failure) — a visible "in progress" marker next to the
      // message itself, independent of the status reply below.
      await react(slack, event.channel, threadTs, "pizza-eagle-working", true);
      try {
        if (threadContext) {
          // refresh on every run so follow-ups see the newest replies
          writeFileSync(join(record.workdir, "thread-context.md"), threadContext + "\n");
        }
        const { answer } = await runInvestigation(cfg, {
          question,
          sessionId: record.sessionId,
          workdir: record.workdir,
          requester: event.user,
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
        console.error("[pizza-eagle] investigation failed:", e);
        report(e);
      } finally {
        // :pizza-eagle-working: off when done — success OR failure
        await react(slack, event.channel, threadTs, "pizza-eagle-working", false);
      }
    });
  }

  const shutdown = () => {
    shuttingDown = true;
    console.log("[pizza-eagle] shutting down");
    for (const child of activeInvestigations) {
      // Kill in-flight investigations — do not orphan them across restarts.
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    activeInvestigations.clear();
    void socket.disconnect();
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const slackClientForAuthCheck = new WebClient(cfg.slackBotToken);
  try {
    const me = await slackClientForAuthCheck.auth.test();
    console.log(`[pizza-eagle] token ok — bot: @${me.user as string} (${me.user_id}) team: ${me.team as string}`);
  } catch (e) {
    console.warn(`[pizza-eagle] bot token failed auth.test: ${(e as Error).message}`);
  }

  socket.on("connecting", () => console.log("[pizza-eagle] socket: connecting…"));
  socket.on("connected", () => console.log("[pizza-eagle] socket: connected"));
  socket.on("disconnect", () => console.log("[pizza-eagle] socket: DISCONNECTED"));
  socket.on("reconnecting", () => console.log("[pizza-eagle] socket: reconnecting…"));

  // Liveness heartbeat: one CloudWatch datapoint every 5 minutes so an
  // alarm on absence (stack: HeartbeatAlarm) catches a silently-dead
  // process or hung socket — "systemd active" alone can lie.
  const heartbeat = setInterval(() => {
    execFile("aws", [
      "cloudwatch", "put-metric-data",
      "--namespace", "pizza-eagle",
      "--metric-data", "MetricName=Heartbeat,Value=1",
      "--region", "us-west-2",
    ], (e) => {
      if (e) console.warn("[pizza-eagle] heartbeat emit failed (will retry):", (e as Error).message);
      else console.log("[pizza-eagle] heartbeat");
    });
  }, 5 * 60_000);
  heartbeat.unref?.();

  await socket.start();
  console.log(
    `[pizza-eagle] up — channels=${cfg.allowedChannels.size || "any"} users=${cfg.allowedUsers.size || "any"} concurrency=${cfg.maxConcurrent}`,
  );
}

main().catch((e) => {
  console.error("[pizza-eagle] fatal:", e);
  report(e);
  process.exit(1);
});