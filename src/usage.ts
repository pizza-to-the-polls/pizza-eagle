/**
 * Usage ledger — one JSON line per event in state/usage.jsonl.
 *
 * The audit trail for "is this being abused?": every question (requester,
 * channel, case) and every write-power use (token mints — the choke point
 * through which ALL GitHub writes must pass) lands here. Every question
 * event is paired with an answer event (issue #67) carrying the run's
 * duration, outcome, and model — so latency, real failure rate, and volume
 * are a one-line jq over this file, not log archaeology. The daily
 * self-check digests it; the retention prune ages it out with everything
 * else (1-year class per PTP policy).
 */
import { appendFileSync, readFileSync } from "node:fs";

export interface UsageEvent {
  ts: string;          // ISO
  event: "question" | "answer" | "token-mint" | "publish" | "flag";
  requester?: string;   // Slack member id (questions/answers) — mints carry the repo
  channel?: string;
  case?: string;        // case id prefix
  detail?: string;      // repo / slug for mints + publishes; reasons for flags
  rule?: string;        // suspicion rule name (flag events)
  // ── answer-event fields (issue #67): the completion half of every
  // question event.
  /** Wall-clock duration of the run in milliseconds. */
  durationMs?: number;
  /** How the run ended: ok / timeout / error / killed (by signal). */
  outcome?: "ok" | "timeout" | "error" | "killed";
  /** Resolved per-run model (PI_MODEL override or the staged default). */
  model?: string;
  /** Last ~200 chars of stderr on a failed run — triage without the logs. */
  errorTail?: string;
  /** Reserved: token usage once pi exposes it (e.g. --print JSON footer). */
  tokens?: unknown;
}

export function appendUsage(stateDir: string, ev: UsageEvent): void {
  try {
    appendFileSync(`${stateDir}/usage.jsonl`, JSON.stringify(ev) + "\n");
  } catch (e) {
    console.warn("[pizza-eagle] usage ledger append failed:", (e as Error).message);
  }
}

/** Count a requester's questions today (UTC) from the ledger. */
export function questionsToday(stateDir: string, requester: string, now = new Date()): number {
  let n = 0;
  const today = now.toISOString().slice(0, 10);
  try {
    for (const line of readFileSync(`${stateDir}/usage.jsonl`, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as UsageEvent;
        if (ev.event === "question" && ev.requester === requester && ev.ts.slice(0, 10) === today) n++;
      } catch { /* torn tail line — ignore */ }
    }
  } catch { /* no ledger yet */ }
  return n;
}

/** The anti-abuse guardrail: daily per-requester cap (default 25). */
export function withinDailyCap(
  stateDir: string,
  requester: string,
  cap = Number(process.env.MAX_PER_USER_PER_DAY ?? 25),
  now = new Date(),
): { ok: boolean; used: number; cap: number } {
  const used = questionsToday(stateDir, requester, now);
  return { ok: used < Math.max(1, cap), used, cap: Math.max(1, cap) };
}
