/**
 * pizza-eagle — Slack front-end around a pi agent session.
 *
 * @pizza-eagle <question>  →  ack "🔎 investigating…"  →  pi subprocess  →
 * findings posted to the same thread. Follow-ups in the thread resume
 * the thread's pi session.
 */

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";  // mkdir: thread-context writes precede runInvestigation's own mkdir
import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { appendUsage, withinDailyCap } from "./usage.js";
import { evaluateSuspicion, WRITE_GATE } from "./suspicion.js";

// File logs (bot.log) carry no journald timestamps — stamp our own.
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { ThreadStore, workdirFor, type ThreadRecord } from "./store.js";
import Bugsnag from "@bugsnag/js";
import { editStatus, fetchThreadContext, postFindings, postStatus, react, stripMention } from "./slack.js";
import { InvestigationError, runInvestigation, activeInvestigations } from "./investigate.js";
import { downloadAttachments, type SlackFile } from "./attachments.js";
import { RunQueue, QueueFullError } from "./queue.js";

interface MentionEvent {
  channel: string;
  user: string;
  text: string;
  thread_ts?: string;
  ts: string;
  bot_id?: string;
  /** Slack message attachments (images, PDFs, …). Downloaded into the case
   * workdir and referenced as @file <name> so vision-capable runs can see
   * them (issue #34). */
  files?: SlackFile[];
}

/** Minimal FIFO with concurrency cap — jobs are async, acks are instant. → moved to src/queue.ts (2026-10-27) */

function report(e: unknown): void {
  // no-op until Bugsnag.start() ran (no key configured → local-only errors).
  // Cast: @bugsnag/js's dual-mode .d.ts types mis-resolve under NodeNext;
  // the runtime default export has .notify (verified by the Bugsnag smoke).
  const bs = Bugsnag as unknown as { notify?: (e: unknown) => void };
  try { bs.notify?.(e); } catch { /* not started */ }
}

/** Post a real-time suspicious-request alert to the ops channel. */
async function alertSuspicious(
  slack: import("@slack/web-api").WebClient,
  cfg: Config,
  event: { user: string; channel: string; ts: string },
  sus: import("./suspicion.js").Suspicion,
): Promise<void> {
  const alertChannel = process.env.SLACK_ALERT_CHANNEL;
  if (!alertChannel) return;
  const permalink = `https://pizzatothepolls.slack.com/archives/${event.channel}/p${event.ts.replace(".", "")}`;
  try {
    await slack.chat.postMessage({
      channel: alertChannel,
      text:
        `:rotating_light: <@U2ZLJ2KBP> *suspicious request* from <@${event.user}>` +
        ` — \`${sus.rule}\`: ${sus.reasons.join("; ")}
${permalink}`,
    });
  } catch (e) {
    console.warn("[pizza-eagle] suspicion alert post failed:", (e as Error).message);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.stateDir, { recursive: true });
  const store = new ThreadStore(join(cfg.stateDir, "threads.json"));
  const slack = new WebClient(cfg.slackBotToken);
  // Per-thread serialized, globally capped run queue (src/queue.ts) —
  // same-thread runs must never overlap (shared case workdir + session).
  const queue = new RunQueue(cfg.maxConcurrent);
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
    // A mention with only an attachment (no text) is still a run: the
    // download below turns it into an @file-only prompt.
    const question = stripMention(event.text);
    const hasFiles = Boolean(event.files?.length);
    if (!question && !hasFiles) return;

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
    const existing = store.get(threadTs);
    let record: ThreadRecord =
      existing ??
      ({
        sessionId: randomUUID(),
        channel: event.channel,
        workdir: workdirFor(cfg.stateDir, threadTs),
        questionCount: 0,
        lastRunAt: new Date().toISOString(),
        lastAnswer: null,
      } as ThreadRecord);
    // Persist at CREATION, not first success: two mentions landing while a
    // run is in flight used to each mint a separate case (fresh sessionId,
    // same workdir) and race the session + case-history files.
    if (!existing) store.put(threadTs, record);

    // Usage ledger + anti-abuse guardrail: one line per question (audit
    // trail), and a polite in-thread refusal past the daily per-user cap.
    // WRITE_GATE operators are exempt from the cap (they run the bot —
    // incident triage legitimately blows past 25/day; 2026-10-29 the
    // cap+burst flags policed Scott's own triage). See suspicion.ts.
    const cap = WRITE_GATE.includes(event.user)
      ? { ok: true, used: 0, cap: Number.POSITIVE_INFINITY }
      : withinDailyCap(cfg.stateDir, event.user);
    if (!cap.ok) {
      await postStatus(
        slack,
        event.channel,
        event.thread_ts ?? event.ts,
        `:zzz: <@${event.user}> you've hit today's question cap (${cap.cap}/day) — back tomorrow, or ask an admin to raise it.`,
      );
      const capFlag = evaluateSuspicion(cfg.stateDir, event.user, question, { capRefusal: true });
      if (capFlag) {
        appendUsage(cfg.stateDir, { ts: new Date().toISOString(), event: "flag",
          requester: event.user, rule: "cap", detail: capFlag.reasons.join("; ") });
        void alertSuspicious(slack, cfg, event, capFlag);
      }
      return;
    }
    appendUsage(cfg.stateDir, {
      ts: new Date().toISOString(),
      event: "question",
      requester: event.user,
      channel: event.channel,
      case: record.sessionId.slice(0, 8),
    });

    // Real-time suspicion detector: ledger-only on first offense, alerts on
    // repetition (or always for cap probes). The behavioral layer (masking,
    // refusals) answers the requester; this tells the operator.
    const sus = evaluateSuspicion(cfg.stateDir, event.user, question);
    if (sus) {
      appendUsage(cfg.stateDir, { ts: new Date().toISOString(), event: "flag",
        requester: event.user, rule: sus.rule, detail: sus.reasons.join("; ") });
      if (sus.alert) void alertSuspicious(slack, cfg, event, sus);
    }

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

    queue.run(threadTs, async () => {
      if (shuttingDown) return;
      // :pizza-eagle-working: on the thread parent while we're working; removed when done
      // (success or failure) — a visible "in progress" marker next to the
      // message itself, independent of the status reply below.
      await react(slack, event.channel, threadTs, "pizza-eagle-working", true);
      // Attachment downloads (issue #34) are per-run scratch: downloaded into
      // the case workdir before the run, deleted in the finally below so they
      // never outlive it — success, failure, or early death. (The nightly
      // backup tar also excludes `attachment-*`, so even a mid-run backup
      // never ships one to S3.)
      const attachmentPaths: string[] = [];
      try {
        if (threadContext) {
          // refresh on every run so follow-ups see the newest replies.
          // mkdir first: a thread reply can be the FIRST mention of a case
          // (e.g. replying to the self-check digest) — the workdir doesn't
          // exist until runInvestigation creates it, and writeFileSync
          // cannot create parents (ENOENT crash, found in the wild).
          mkdirSync(record.workdir, { recursive: true });
          writeFileSync(join(record.workdir, "thread-context.md"), threadContext + "\n");
        }
        // Vision runs (issue #34): download Slack files into the case workdir
        // and reference them as @file … in the question. Best-effort — a
        // failed download skips the file and the run proceeds text-only.
        let runQuestion = question;
        if (event.files?.length) {
          const dl = await downloadAttachments(cfg, record.workdir, event.files);
          attachmentPaths.push(...dl.paths);
          const runQ = [dl.args.join(" "), question].filter(Boolean).join(" ");
          if (runQ) runQuestion = runQ;
        }
        const { answer } = await runInvestigation(cfg, {
          question: runQuestion,
          sessionId: record.sessionId,
          workdir: record.workdir,
          requester: event.user,
          // Slack-authenticated gate — lands in request-auth.json in the
          // case workdir, which the operator prompt + helper scripts trust.
          writeAllowed: WRITE_GATE.includes(event.user),
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
        const msg = detail.includes("code 143")
          ? ":x: Investigation timed out (20-minute limit). If this was a multi-repo or multi-PR ask, try asking for one piece at a time — I keep full thread context between requests."
          : `:x: ${detail}`;
        await postFindings(slack, event.channel, threadTs, msg);
        console.error("[pizza-eagle] investigation failed:", e);
        report(e);
      } finally {
        // :pizza-eagle-working: off when done — success OR failure
        await react(slack, event.channel, threadTs, "pizza-eagle-working", false);
        // Per-run attachment scratch (issue #34): delete the downloads so
        // they never outlive the run. Best-effort; the backup tar's
        // `attachment-*` exclude is the backstop for mid-run crashes.
        for (const p of attachmentPaths) {
          try {
            rmSync(p, { force: true });
          } catch {
            /* best-effort */
          }
        }
      }
    }).catch((e: unknown) => {
      // The job body never rejects (own try/catch) — a rejection here means
      // the queue refused the job: waiting room full (burst protection).
      if (e instanceof QueueFullError) {
        void postStatus(
          slack,
          event.channel,
          threadTs,
          ":hourglass_flowing_sand: Too many investigations queued right now — try again in a few minutes.",
        ).catch(() => { /* cosmetic */ });
        return;
      }
      console.error("[pizza-eagle] queue failure:", e);
      report(e);
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
  // process or hung socket — "systemd active" alone can lie. The same
  // call carries MemoryPercent (stack: OpsMemoryAlarm): on 2026-10-31 an
  // election-night feedflag leg OOM'd the whole box (SSM agent + eagle
  // dead, Retool tunnel stranded) with no memory signal anywhere — this
  // pages at 85% before the OOM, and it rides the existing
  // HeartbeatAlarmTopic → #dev plumbing with no instance dimension, so
  // it survives ASG replacement.
  const heartbeat = setInterval(() => {
    const memPct = Math.round(100 * (1 - freemem() / totalmem()));
    execFile("aws", [
      "cloudwatch", "put-metric-data",
      "--namespace", "pizza-eagle",
      "--metric-data", "MetricName=Heartbeat,Value=1",
      "--metric-data", `MetricName=MemoryPercent,Value=${memPct}`,
      "--region", "us-west-2",
    ], (e) => {
      if (e) console.warn("[pizza-eagle] heartbeat emit failed (will retry):", (e as Error).message);
      else log("[pizza-eagle] heartbeat");
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