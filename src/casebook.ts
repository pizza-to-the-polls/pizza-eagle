/**
 * Casebook — the eagle's long-term episodic memory (fleet-dreaming phase 1).
 *
 * One JSON line per COMPLETED investigation in state/casebook-YYYYMM.jsonl:
 * what was asked, what was concluded, how it ended. Where usage.jsonl is a
 * metadata-only audit trail (who/when/how long — anti-abuse, suspicion
 * rules, 1-year prune), the casebook carries CONTENT: question + answer
 * excerpts, so a distiller (dream shift) can pattern-match across cases
 * without re-reading session transcripts. It stays listener-owned and
 * append-only — the isolated worker never touches it; the FIFO queue is
 * the single writer, so no locks.
 *
 * Privacy split: raw casebook lives only in state/ (group 0770 workdirs
 * aside, state/ is the box's own surface) and the S3 backup tar; Slack gets
 * only distilled dream output, never raw entries (questions/answers can
 * carry report phone numbers).
 *
 * The digest (renderCasebookDigest) rides into each case workdir as
 * casebook.md before every run — the agent's ONLY sight of past cases,
 * since the isolation boundary (issue #5) blocks it from state/ entirely.
 * Written by the listener, like AGENTS.md and request-auth.json, so it is
 * structurally unforgeable by the worker.
 */
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One completed investigation. Retries land as one entry (final outcome). */
export interface CasebookEntry {
  ts: string; // ISO — completion time
  sessionId: string; // case id (full UUID, stable per Slack thread)
  threadTs?: string; // Slack thread ts
  channel?: string; // Slack channel id
  requester?: string; // Slack member id
  requesterName?: string; // Slack-resolved display name
  question: string; // the ask, truncated
  /** Answer excerpt on success — the verdict usually leads. */
  answer?: string;
  /** Stderr tail on failure — pairs with usage.jsonl's errorTail. */
  errorTail?: string;
  outcome: "ok" | "timeout" | "error" | "killed";
  durationMs?: number;
  model?: string; // per-run PI_MODEL override, if any
}

/** Question cap: full question text — dream food, and 32k argv cap already bounds it. */
export const CASEBOOK_QUESTION_MAX = 4_000;
/** Answer excerpt cap: the verdict leads; 1500 chars carries it plus key evidence. */
export const CASEBOOK_ANSWER_MAX = 1_500;
/** Digest: past entries the agent sees per run. Enough for "seen this before". */
export const CASEBOOK_DIGEST_ENTRIES = 20;
/** Digest line caps — a digest is a pointer to history, not a second copy. */
export const CASEBOOK_DIGEST_QUESTION_MAX = 240;
export const CASEBOOK_DIGEST_ANSWER_MAX = 320;

/** Monthly shard name: keeps files small and lets the prune age by month. */
export function casebookPath(stateDir: string, now = new Date()): string {
  // toISOString() starts "YYYY-MM-…" — strip the dash for a true YYYYMM stem
  // (the reader's regex is /^casebook-\d{6}\.jsonl$/).
  const ym = now.toISOString().slice(0, 7).replace("-", "");
  return join(stateDir, `casebook-${ym}.jsonl`);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * Append one completed investigation. Best-effort like appendUsage: a
 * casebook failure must never take an answer down with it.
 */
export function appendCasebook(stateDir: string, entry: CasebookEntry, now = new Date()): void {
  try {
    appendFileSync(
      casebookPath(stateDir, now),
      JSON.stringify({
        ...entry,
        question: clip(entry.question, CASEBOOK_QUESTION_MAX),
        answer: entry.answer ? clip(entry.answer, CASEBOOK_ANSWER_MAX) : undefined,
      }) + "\n",
    );
  } catch (e) {
    console.warn("[pizza-eagle] casebook append failed (continuing):", (e as Error).message);
  }
}

interface StoredEntry extends CasebookEntry {
  ts: string;
  question: string;
  outcome: CasebookEntry["outcome"];
}

/** Read every casebook shard, oldest→newest, torn tail lines ignored. */
export function readCasebook(stateDir: string): StoredEntry[] {
  const out: StoredEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(stateDir)
      .filter((f) => /^casebook-\d{6}\.jsonl$/.test(f))
      .sort();
  } catch {
    return out; // no state dir yet — no history
  }
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(stateDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as StoredEntry);
      } catch {
        /* torn tail line — the append is not atomic */
      }
    }
  }
  return out;
}

/**
 * Compact digest of the last N cases, rendered into each case workdir as
 * casebook.md (listener-written pre-spawn, next to AGENTS.md). This is the
 * investigation agent's only cross-case memory: recent questions + verdict
 * excerpts, so repeat patterns get faster answers and "what have I been
 * getting wrong" is answerable in-run.
 */
export function renderCasebookDigest(stateDir: string, n = CASEBOOK_DIGEST_ENTRIES): string {
  const entries = readCasebook(stateDir).slice(-n);
  const lines = [
    "# Casebook — recent investigations",
    "",
    `Last ${n} completed cases (newest last). Same-workspace questions you may`,
    "be able to answer from these directly, or flag as recurring. Excerpts only —",
    `the full log is in state/casebook-*.jsonl on the box (read it via ops, not here).`,
    "",
  ];
  if (entries.length === 0) {
    lines.push("_(no prior cases)_", "");
  }
  for (const e of entries) {
    const who = e.requesterName ? ` — ${e.requesterName}` : e.requester ? ` — ${e.requester}` : "";
    const dur = e.durationMs != null ? ` (${Math.round(e.durationMs / 60000) || "<1"}m)` : "";
    lines.push(
      `## ${e.ts}${who}`,
      "",
      `**Q:** ${clip(e.question, CASEBOOK_DIGEST_QUESTION_MAX)}`,
      "",
      e.outcome === "ok"
        ? `**A:** ${clip(e.answer ?? "(no excerpt)", CASEBOOK_DIGEST_ANSWER_MAX)}`
        : `**Outcome:** ${e.outcome}${dur}${e.errorTail ? ` — ${clip(e.errorTail, 160)}` : ""}`,
      "",
    );
  }
  return lines.join("\n");
}

/**
 * Write the digest into a case workdir (pre-spawn, idempotent overwrite).
 * Listener-owned like AGENTS.md; the isolated worker reads but never writes it.
 */
export function writeCasebookDigest(stateDir: string, workdir: string): void {
  try {
    writeFileSync(join(workdir, "casebook.md"), renderCasebookDigest(stateDir) + "\n");
  } catch (e) {
    console.warn("[pizza-eagle] casebook digest write failed (continuing):", (e as Error).message);
  }
}