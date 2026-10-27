/**
 * Real-time suspicion detector — deterministic heuristics over each
 * incoming mention. The audit LEDGER records what happened; this records
 * what looks wrong and pings the operator WHILE it happens.
 *
 * Noise discipline: first offenses are ledger-only (silent); repetition
 * alerts. Cap-refusals always alert (they're rare and already mean someone
 * probed a limit). Alerts dedupe per requester+rule per hour.
 */
import { readFileSync } from "node:fs";

// Write-power gate (keep in sync with AGENTS.md — the instruction-level
// gate; this is the detection mirror of it)
export const WRITE_GATE = ["U2ZLJ2KBP", "U0B740NG8E6", "U01CQKPAT35"];

const PII_HARVEST = [
  /list of ((all |the )*)(donor|donor'?s?|voter|voters?)\s*emails/i,
  /emails? of ((all |the )*)(donors?|voters?|reporters?)/i,
  /phone numbers? of ((all |the )*)(donors?|voters?|reporters?|subscribers?)/i,
  /show me ((all |the )*)(donors?|voters?)\b(?!\s*(how many|count|total|by amount|amounts|totals))/i,
  /export ((the |all )*)(donations|reports|donors|contacts?|subscribers?)\b/i,
  /dump ((the |all )*)(donations|reports|donors|banned)/i,
  /contact (info|details|information) (for|of) ((every|all|the )*)(donor|voter|reporter)/i,
  // Credential storage (red team 2026-10-27): api_keys holds usable API
  // keys and integration_sessions holds social OAuth tokens — ptp_ro could
  // read both until the DB revocation landed. Any read attempt gets flagged
  // (and AGENTS.md forbids the query outright).
  /\b(select|read|dump|export|list|show|grab|pull|query)\b[^.\n]{0,50}\b(api_keys|integration_sessions)\b/i,
  /\b(api_keys|integration_sessions)\b\s+(table|keys?|credentials?)/i,
];

const WRITE_ATTEMPT = [
  /\b(publish|push|deploy|merge)\b.*\b(hotnready|to (main|master)|to the site)\b/i,
  /\bopen (a )?(pull request|pr)\b/i,
  /\b(create|open) (me )?a (draft )?(pr|pull request)\b/i,
  /\bforce[- ]?push/i,
];

// Secrets-probe phrasing: attempts to make the investigator dump its own
// credentials (env, .env, /proc environ, token files). These are the
// prompt-injection precursors to exfiltration; the argv/env hardening in
// investigate.ts is the boundary, this surfaces the attempt to the operator.
const SECRETS_PROBE = [
  /\bprintenv\b/i,
  /\/proc\/[^\s\/]*\/environ/i,
  /(^|[^\w])\.env\b/i, // "cat the .env" — not "environment" words
  /\bshow (me |us )?(the |all |your )*(env(ironment)? vars?|secrets?|tokens?|api keys?)\b/i,
  /\b(dump|print|reveal|exfiltrate)\b[^.]{0,40}\b(env(ironment)?|secrets?|tokens?|credentials)\b/i,
  /\bEnvironmentFile\b/i,
];

// Don't let ops-y phrasing trip SECRETS_PROBE: gated requesters asking
// "which env var holds X" is legitimate triage, not an exfil attempt.
// (Rule still ledger-flags so a pattern of probes is visible.)

export interface Suspicion {
  rule: "cap" | "pii-harvest" | "write-attempt" | "burst" | "secrets-probe";
  reasons: string[];
  alert: boolean; // false = ledger-only (first offense / deduped)
}

interface LedgerEvent { ts: string; event: string; requester?: string; detail?: string; rule?: string }

function readLedger(stateDir: string): LedgerEvent[] {
  try {
    return readFileSync(`${stateDir}/usage.jsonl`, "utf8").split("\n")
      .filter(Boolean)
      .flatMap((l) => { try { return [JSON.parse(l) as LedgerEvent]; } catch { return []; } });
  } catch { return []; }
}

const within = (ev: LedgerEvent, ms: number) => Date.now() - new Date(ev.ts).getTime() < ms;

/** Count this requester's prior silent flags for a rule in a window. */
function priorFlags(stateDir: string, rule: Suspicion["rule"], requester: string, windowMs: number): number {
  return readLedger(stateDir)
    .filter((e) => e.event === "flag" && e.rule === rule && e.requester === requester && within(e, windowMs))
    .length;
}

export function evaluateSuspicion(
  stateDir: string,
  requester: string,
  question: string,
  opts: { capRefusal?: boolean; burstWindowMs?: number; burstMax?: number } = {},
): Suspicion | null {
  const reasons: string[] = [];

  if (opts.capRefusal) {
    return { rule: "cap", reasons: ["hit the daily question cap"], alert: true };
  }

  if (PII_HARVEST.some((re) => re.test(question))) {
    reasons.push("PII-seeking phrasing (donor emails / contact dumps)");
    const prior = priorFlags(stateDir, "pii-harvest", requester, 24 * 3600_000);
    return { rule: "pii-harvest", reasons, alert: prior >= 1 }; // 1st silent, 2nd+ alerts
  }

  if (SECRETS_PROBE.some((re) => re.test(question))) {
    reasons.push("secrets-probe phrasing (env/.env/token dumps)");
    const prior = priorFlags(stateDir, "secrets-probe", requester, 24 * 3600_000);
    return { rule: "secrets-probe", reasons, alert: prior >= 1 }; // 1st silent, 2nd+ alerts
  }

  if (!WRITE_GATE.includes(requester) && WRITE_ATTEMPT.some((re) => re.test(question))) {
    reasons.push("write-power request from a non-gated requester");
    const prior = priorFlags(stateDir, "write-attempt", requester, 24 * 3600_000);
    return { rule: "write-attempt", reasons, alert: prior >= 1 };
  }

  // burst: many questions in a short window (ledger question events)
  const windowMs = opts.burstWindowMs ?? 10 * 60_000;
  const max = opts.burstMax ?? 6;
  const burst = readLedger(stateDir)
    .filter((e) => e.event === "question" && e.requester === requester && within(e, windowMs))
    .length;
  if (burst >= max) {
    const recentAlert = priorFlags(stateDir, "burst", requester, 3600_000);
    return { rule: "burst", reasons: [`${burst} questions in the last ${windowMs / 60_000} min`], alert: recentAlert === 0 };
  }

  return null;
}
