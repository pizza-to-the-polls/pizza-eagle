/**
 * pizza-eagle — Slack front-end around a pi agent session.
 *
 * @pizza-eagle <question>  →  ack "🔎 investigating…"  →  pi subprocess  →
 * findings posted to the same thread. Follow-ups in the thread resume
 * the thread's pi session.
 *
 * Issue #68: a failed run auto-retries ONCE in the same session/workdir
 * before surfacing failure, and the terminal failure is never a bare ❌ —
 * the status message carries the duration, the one-line cause, and a retry
 * offer. Runs killed by a listener restart are requeued once on boot.
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
import { ThreadStore, needsRestartRequeue, workdirFor, type ThreadRecord } from "./store.js";
import Bugsnag from "@bugsnag/js";
import { editStatus, fetchThreadContext, postFindings, postStatus, react, resolveUserName, stripMention, threadContextDoc, threadDeeplink } from "./slack.js";
import { InvestigationError, oneLinerCause, runWithRetry, activeInvestigations } from "./investigate.js";
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
  const permalink = threadDeeplink(event.channel, event.ts);
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
      await executeRun(event, record, threadTs, threadContext, statusTs, question);
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

  /**
   * One investigation execution — the body of a queue slot. Extracted from
   * the anonymous queue.run closure (issue #68) so the startup restart
   * requeue can submit the very same run path; both callers go through
   * queue.run, so same-thread runs stay serialized. `event` may be a
   * synthetic reconstruction when the original mention died with the old
   * process (see requeueInterrupted below).
   */
  async function executeRun(
    event: MentionEvent,
    record: ThreadRecord,
    threadTs: string,
    threadContext: string,
    statusTs: string | undefined,
    question: string,
  ): Promise<void> {
    if (shuttingDown) return;
    const runStarted = Date.now();
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
    // In-flight marker (issue #68): persisted BEFORE the run so a listener
    // restart that kills this process mid-run leaves a durable record of the
    // interrupted question for the next boot's one-time requeue. Cleared when
    // the run FINISHES (finally below) — success posts the answer, terminal
    // failure posts the cause + retry offer — so only a run that never
    // finished still carries it, which is exactly the requeue criterion.
    record.inFlight = true;
    record.lastQuestion = question;
    record.lastRequester = event.user;
    record.statusTs = statusTs;
    store.put(threadTs, record);
    try {
      // Refreshed on every run so follow-ups see the newest replies. Written
      // even when the thread has no replies yet: the first line is the
      // listener-written Slack thread deeplink (trusted authenticated
      // metadata — like request-auth.json, a question cannot forge it)
      // that dispatch issues quote back into their bodies.
      // mkdir first: a thread reply can be the FIRST mention of a case
      // (e.g. replying to the self-check digest) — the workdir doesn't
      // exist until runInvestigation creates it, and writeFileSync
      // cannot create parents (ENOENT crash, found in the wild).
      mkdirSync(record.workdir, { recursive: true });
      writeFileSync(
        join(record.workdir, "thread-context.md"),
        threadContextDoc(event.channel, threadTs, threadContext),
      );
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
      // Issue #69: resolve the requester's display name from Slack itself
      // (users.info, cached per id) so request-auth.json carries the
      // authoritative name — the model never maps ids to names via
      // AGENTS.md prose, which once mislabeled an admin "Matt" and
      // produced a bogus publish-gate refusal.
      const requesterName = await resolveUserName(slack, event.user);
      record.lastRequesterName = requesterName;
      store.put(threadTs, record);
      // Issue #68: auto-retry ONCE in the same session/workdir before
      // surfacing failure — v1's ~11% transient failures (model API 429s,
      // network blips) surfaced as bare ❌s the user could only escape by
      // re-asking in a fresh thread. Timeouts are excluded by runWithRetry:
      // a run that consumed the whole wall-clock budget would need it all
      // again for the same scope. A shutdown mid-run must not spawn a doomed
      // second attempt, hence the shouldRetry gate.
      const { answer, durationMs } = await runWithRetry(
        cfg,
        {
          question: runQuestion,
          sessionId: record.sessionId,
          workdir: record.workdir,
          requester: event.user,
          requesterName,
          // Slack-authenticated gate — lands in request-auth.json in the
          // case workdir, which the operator prompt + helper scripts trust.
          writeAllowed: WRITE_GATE.includes(event.user),
        },
        {
          shouldRetry: () => !shuttingDown,
          onRetry: async (firstError) => {
            const cause = oneLinerCause(firstError);
            console.warn(`[pizza-eagle] attempt 1 failed (${cause}) — auto-retrying once in the same session`);
            if (statusTs) {
              await editStatus(
                slack,
                event.channel,
                statusTs,
                `:mag_right: First attempt failed (${cause}) — retrying…`,
              ).catch(() => { /* cosmetic — never block the retry on Slack */ });
            }
          },
        },
      );
      // Usage ledger (issue #67): the completion half of the question
      // event. Duration/outcome/model turn "how long do answers take? /
      // what's the real failure rate?" into a one-line jq over
      // usage.jsonl. cfg.piModel is undefined without a PI_MODEL override
      // — the field is then omitted from the JSON line (model unknown).
      // tokens stays reserved until pi exposes per-run usage.
      appendUsage(cfg.stateDir, {
        ts: new Date().toISOString(),
        event: "answer",
        requester: event.user,
        channel: event.channel,
        case: record.sessionId.slice(0, 8),
        durationMs,
        outcome: "ok",
        model: cfg.piModel,
      });
      if (statusTs) {
        await editStatus(slack, event.channel, statusTs, ":white_check_mark: Investigation finished.");
      }
      await postFindings(slack, event.channel, threadTs, answer);
      record.questionCount = record.questionCount + 1;
      record.lastRunAt = new Date().toISOString();
      record.lastAnswer = answer.slice(0, 500);
      store.put(threadTs, record);
    } catch (e) {
      // Usage ledger (issue #67): failed runs still pair their question
      // event with an answer event — outcome + duration + a truncated
      // stderr tail, so the failure rate in the ledger matches reality.
      const inv = e instanceof InvestigationError ? e : undefined;
      appendUsage(cfg.stateDir, {
        ts: new Date().toISOString(),
        event: "answer",
        requester: event.user,
        channel: event.channel,
        case: record.sessionId.slice(0, 8),
        durationMs: inv?.durationMs,
        outcome: inv?.outcome ?? "error",
        model: cfg.piModel,
        errorTail: inv?.stderr?.length ? inv.stderr.slice(-200) : undefined,
      });
      const detail =
        e instanceof InvestigationError
          ? `${e.message}\n\`\`\`${e.stderr.slice(0, 500)}\n\`\`\``
          : `Unexpected error: ${(e as Error).message}`;
      // Issue #68: the status edit carries the one-line cause + the retry
      // offer — NEVER a bare ❌. v1's ":x: Investigation failed." told the
      // user nothing and left re-asking in a fresh thread (duplicated cases,
      // lost context) as the only recourse.
      const durationMin = Math.max(1, Math.ceil((Date.now() - runStarted) / 60_000));
      if (statusTs) {
        await editStatus(
          slack,
          event.channel,
          statusTs,
          `:x: Investigation failed after ${durationMin}m — ${oneLinerCause(e)}. Reply "retry" to try again.`,
        ).catch(() => { /* the in-thread detail below still lands */ });
      }
      const msg = detail.includes("code 143")
        ? ":x: Investigation timed out (20-minute limit). If this was a multi-repo or multi-PR ask, try asking for one piece at a time — I keep full thread context between requests."
        : `:x: ${detail}`;
      await postFindings(slack, event.channel, threadTs, msg);
      console.error("[pizza-eagle] investigation failed:", e);
      report(e);
    } finally {
      // Run finished — success or terminal failure. Clear the in-flight
      // marker AND the pending question: both outcomes already reached the
      // user, so a restart must never requeue this run (the restart-requeue
      // dedupe keys on lastQuestion still being set — see store.ts).
      record.inFlight = false;
      record.lastQuestion = undefined;
      store.put(threadTs, record);
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
  }

  /**
   * Issue #68: find investigations that died with the previous process and
   * requeue them, ONCE. A restart SIGTERMs every in-flight run (shutdown
   * above); the new process has no memory of them — except threads.json,
   * where executeRun persisted the in-flight marker + question before the
   * run started. Runs that completed before the crash cleared lastQuestion
   * and dedupe out via needsRestartRequeue (an answer must never post
   * twice); runs whose terminal failure already reached the user ditto.
   */
  async function requeueInterrupted(): Promise<void> {
    const interrupted = store.getInFlight();
    if (interrupted.length === 0) return;
    console.log(
      `[pizza-eagle] ${interrupted.length} in-flight thread(s) from a previous process — requeueing once`,
    );
    for (const [threadTs, record] of interrupted) {
      try {
        if (!needsRestartRequeue(record)) {
          // Completed before the crash (answer posted) or nothing re-runnable
          // recorded — clear the stale flag so it never comes back, skip.
          console.log(`[pizza-eagle] ${threadTs}: in-flight flag set but run already completed — skipping requeue`);
          record.inFlight = false;
          store.put(threadTs, record);
          continue;
        }
        // Clear the flag BEFORE submitting: a crash during requeue must not
        // turn this into a re-requeue loop — each interrupted run is retried
        // exactly once, then it is executeRun's job to keep the flag honest.
        record.inFlight = false;
        store.put(threadTs, record);

        const question = record.lastQuestion!;
        const event: MentionEvent = {
          channel: record.channel,
          user: record.lastRequester ?? "?",
          text: question,
          thread_ts: threadTs,
          ts: threadTs,
        };
        // Allowlists and the daily cap are NOT re-checked: the original
        // mention already passed both, and its question event is already in
        // the usage ledger — this is a retry of the same question, not a
        // new one.
        let threadContext = "";
        try {
          threadContext = await fetchThreadContext(slack, record.channel, threadTs);
        } catch (e) {
          console.warn("[pizza-eagle] thread context unavailable for requeue:", (e as Error).message);
        }
        const statusTs = await postStatus(
          slack,
          record.channel,
          threadTs,
          `:mag_right: The listener restarted mid-investigation — re-running this question automatically (case \`${record.sessionId.slice(0, 8)}\`).`,
        );
        queue.run(threadTs, async () => {
          await executeRun(event, record, threadTs, threadContext, statusTs, question);
        }).catch((e: unknown) => {
          if (e instanceof QueueFullError) {
            void postStatus(
              slack,
              record.channel,
              threadTs,
              ':hourglass_flowing_sand: The listener restarted and the investigation queue is full — reply "retry" in a few minutes.',
            ).catch(() => { /* cosmetic */ });
            return;
          }
          console.error("[pizza-eagle] requeue failure:", e);
          report(e);
        });
      } catch (e) {
        // One bad record must not stop the others.
        console.error(`[pizza-eagle] restart requeue failed for ${threadTs}:`, e);
        report(e);
      }
    }
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
  // tick also carries MemoryPercent (stack: OpsMemoryAlarm): on
  // 2026-10-31 an election-night feedflag leg OOM'd the whole box (SSM
  // agent + eagle dead, Retool tunnel stranded) with no memory signal
  // anywhere — this pages at 85% before the OOM, and it rides the existing
  // HeartbeatAlarmTopic → #dev plumbing with no instance dimension, so
  // it survives ASG replacement.
  //
  // NB: TWO SEPARATE put calls, never two --metric-data entries — aws-cli
  // (verified 2.36 + 2.38, 2026-10-31) publishes only the LAST entry of
  // repeated --metric-data flags and still exits 0. The dual-entry form
  // this replaced silently dropped every Heartbeat datapoint
  // (MemoryPercent kept landing) and the liveness alarm stayed ALARM
  // over a healthy bot — caught live on the t4g.medium rebirth.
  const emitMetric = (metricData: string, name: string) =>
    execFile("aws", [
      "cloudwatch", "put-metric-data",
      "--namespace", "pizza-eagle",
      "--metric-data", metricData,
      "--region", "us-west-2",
    ], (e) => {
      if (e) console.warn(`[pizza-eagle] ${name} emit failed (will retry):`, (e as Error).message);
      else log(`[pizza-eagle] ${name}`);
    });
  const heartbeat = setInterval(() => {
    emitMetric("MetricName=Heartbeat,Value=1", "heartbeat");
    const memPct = Math.round(100 * (1 - freemem() / totalmem()));
    emitMetric(`MetricName=MemoryPercent,Value=${memPct}`, "memory");
  }, 5 * 60_000);
  heartbeat.unref?.();

  // Issue #68: investigations killed by a listener restart used to vanish —
  // the new process had no memory of them and the thread sat with a stale
  // 🔎 forever (2026-10-26: Nina's partners-page question, SIGTERM'd at
  // 20:24, never answered). Requeue each interrupted run once BEFORE the
  // socket accepts new events, so the requeue scan cannot race a fresh
  // mention for the same thread.
  await requeueInterrupted();

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