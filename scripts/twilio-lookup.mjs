#!/usr/bin/env node
/**
 * twilio-lookup.mjs — read-only Twilio message delivery lookups for
 * pizza-eagle / Pizza Eagle.
 *
 * "Was the pizza text to this number actually delivered?" — this answers
 * it straight from the Twilio Messages API instead of inferring from
 * status callbacks. The credential is the pizza-eagle read-only API key
 * (Restricted key, Messaging read only): this script is GET-only by
 * construction — there is no code path that can send, edit, or delete
 * anything. If someone needs write access, that is a different tool with
 * a different credential.
 *
 * Credential path: TWILIO_RO_JSON, default ~/.config/ptp/twilio-readonly.json
 * (bootstrap.sh §5d writes it on the ops box from Secrets Manager
 * `ptp/prod/pizza-eagle/twilio-readonly`).
 *
 * Usage:
 *   node twilio-lookup.mjs to <E164-number> [--since Nd]
 *       recent messages involving that number (both directions), newest
 *       first; --since 7d limits the window (default 30d)
 *   node twilio-lookup.mjs show <MessageSid>
 *       one message in full, with the error code translated to English
 *   node twilio-lookup.mjs codes
 *       the delivery error-code cheat sheet
 *
 * Output: JSON on stdout (envelope { query, count, messages }). Set
 * HUMAN=1 for the indented quick-read format Pizza Eagle pastes into
 * Slack. Keep usage modest — the Messages list API is not paginated
 * beyond --limit here (default 25, max 100).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

// Twilio delivery error codes (30001–30008 family + the classic
// 21xxx API rejections seen at send time). Anything else prints as-is.
export const ERROR_CODES = {
  21211: "invalid 'To' phone number",
  21606: "'To' number is not a valid mobile number",
  21608: "'To' number is not SMS-capable on this 'From' number",
  21610: "queue full — message not sent",
  21612: "'To' number is not a valid mobile number",
  21614: "'To' number is a landline or non-mobile",
  30001: "carrier connection failed (often transient — retry)",
  30002: "number cannot be routed (invalid/unallocated)",
  30003: "destination handset unreachable (off/out of coverage)",
  30004: "blocked by recipient's carrier or spam filter",
  30005: "unknown destination handset",
  30006: "landline — cannot receive SMS",
  30007: "message filtered by carrier (content policy violation)",
  30008: "unknown carrier error",
};

export function errorCodeMeaning(code) {
  if (code == null || code === 0 || code === "0") return null;
  const n = Number(code);
  return ERROR_CODES[n] ?? `Twilio error code ${n}`;
}

export function normalizeNumber(raw) {
  // Accept +1503..., 503... (assume US +1), and 1-503-... forms; return
  // E164 or null (caller decides how loud to complain).
  const digits = String(raw ?? "").replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

export function sinceDaysAgo(since) {
  // "--since 7d" -> YYYY-MM-DD for the DateSent>= filter. Accepts Nd only.
  // Twilio quirk (verified live): the operator belongs in the parameter NAME
  // (DateSent>=), and a full timestamp in DateSent= means "sent at this
  // exact second" — a silent zero. Date-only + >= is the window form.
  const m = /^(\d+)d$/.exec(String(since ?? "30d"));
  if (!m) return null;
  const days = Math.min(Number(m[1]), 365);
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function usage(code = 1) {
  console.log(`usage:
  twilio-lookup.mjs to <E164-number> [--since Nd] [--limit N]
  twilio-lookup.mjs show <MessageSid>
  twilio-lookup.mjs codes

env:
  TWILIO_RO_JSON  credential JSON path (default ~/.config/ptp/twilio-readonly.json)
  HUMAN=1         indented human format instead of raw JSON`);
  process.exit(code);
}

function loadCreds() {
  const p = process.env.TWILIO_RO_JSON ?? `${homedir()}/.config/ptp/twilio-readonly.json`;
  let creds;
  try {
    creds = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`cannot read credential at ${p}: ${e.message}`);
    console.error("(bootstrap.sh §5d provisioned it — is the secret present?)");
    process.exit(2);
  }
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"]) {
    if (!creds[k]) {
      console.error(`credential at ${p} is missing ${k}`);
      process.exit(2);
    }
  }
  return creds;
}

async function twilioGet(creds, params) {
  // The ONLY API code path in this file: GET /Messages.json. Read-only
  // credential + read-only verb — the belt-and-suspenders pair.
  const qs = new URLSearchParams(params);
  const res = await fetch(`${API_BASE}/${creds.TWILIO_ACCOUNT_SID}/Messages.json?${qs}`, {
    method: "GET", // never anything else
    headers: {
      Authorization: "Basic " + Buffer.from(
        `${creds.TWILIO_API_KEY_SID}:${creds.TWILIO_API_KEY_SECRET}`).toString("base64"),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`Twilio API HTTP ${res.status}: ${body}`);
    process.exit(3);
  }
  return JSON.parse(body);
}

function human(messages) {
  const lines = [];
  for (const m of messages) {
    const when = (m.date_sent ?? m.date_created ?? "?").replace(" +0000", "");
    const err = errorCodeMeaning(m.error_code);
    const price = Math.abs(Number(m.price ?? 0));
    lines.push(
      `${when}  ${m.direction.padEnd(13)} ${m.status.padEnd(11)} ` +
      `to=${m.to ?? "?"} from=${m.from ?? "?"} ` +
      `err=${m.error_code ?? "-"}${err ? ` (${err})` : ""} ` +
      `price=$${price.toFixed(4)}`,
    );
  }
  return lines;
}

function printResult(query, body, limit) {
  const messages = body.messages ?? [];
  const result = { query, count: messages.length, messages };
  if (process.env.HUMAN === "1") {
    console.log(`query: ${query} (${messages.length} message${messages.length === 1 ? "" : "s"})`);
    if (messages.length === 0) console.log("no messages found");
    else for (const l of human(messages)) console.log("  " + l);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "codes") {
    for (const [code, meaning] of Object.entries(ERROR_CODES)) {
      console.log(`${code.padEnd(6)} ${meaning}`);
    }
    process.exit(0);
  }
  const creds = loadCreds();

  if (cmd === "to") {
    const number = normalizeNumber(rest[0]);
    if (!number) { console.error(`'${rest[0] ?? ""}' is not a phone number I can normalize`); usage(); }
    const flags = {};
    for (let i = 1; i < rest.length; i += 2) {
      flags[String(rest[i]).replace(/^--/, "")] = rest[i + 1];
    }
    const since = sinceDaysAgo(flags.since);
    if (flags.since && !since) { console.error(`--since must be like 7d (days), got '${flags.since}'`); usage(); }
    const limit = Math.min(Number(flags.limit ?? 25), 100);
    const params = { To: number, PageSize: limit, ...(since && { "DateSent>=": since }) };
    const body = await twilioGet(creds, params);
    // To= misses outbound-reply: a number can appear in either field.
    if (body.messages?.length === 0) {
      const fromBody = await twilioGet(creds, { From: number, PageSize: limit, ...(since && { "DateSent>=": since }) });
      if (fromBody.messages?.length === 0 && process.env.HUMAN === "1") {
        console.log(`query: ${number} since ${since ?? "30d"} (checked To and From) — no messages found`);
      } else {
        printResult(`from ${number} since ${since ?? "30d"}`, fromBody, limit);
      }
    } else {
      printResult(`to ${number} since ${since ?? "30d"}`, body, limit);
    }
  } else if (cmd === "show") {
    const sid = rest[0];
    if (!sid || !sid.startsWith("SM")) { console.error("need a MessageSid (SM...)"); usage(); }
    const page = await fetch(
      `${API_BASE}/${creds.TWILIO_ACCOUNT_SID}/Messages/${sid}.json`, {
        method: "GET",
        headers: {
          Authorization: "Basic " + Buffer.from(
            `${creds.TWILIO_API_KEY_SID}:${creds.TWILIO_API_KEY_SECRET}`).toString("base64"),
        },
      });
    if (!page.ok) {
      console.error(`Twilio API HTTP ${page.status}: ${await page.text()}`);
      process.exit(3);
    }
    const m = await page.json();
    const meaning = errorCodeMeaning(m.error_code);
    console.log(JSON.stringify(
      { sid: m.sid, ...m, ...(meaning && { error_meaning: meaning }) }, null, 2));
  } else {
    usage();
  }
}

// Skip the CLI when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("twilio-lookup.mjs")) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
