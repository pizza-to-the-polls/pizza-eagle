import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendUsage, questionsToday, withinDailyCap } from "../src/usage.js";

const now = new Date("2026-10-24T12:00:00Z");

test("usage ledger: append + count today's questions per requester", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-usage-"));
  appendUsage(dir, { ts: "2026-10-24T09:00:00Z", event: "question", requester: "U1", channel: "C1" });
  appendUsage(dir, { ts: "2026-10-24T10:00:00Z", event: "question", requester: "U1", channel: "C1" });
  appendUsage(dir, { ts: "2026-10-23T09:00:00Z", event: "question", requester: "U1", channel: "C1" }); // yesterday
  appendUsage(dir, { ts: "2026-10-24T11:00:00Z", event: "token-mint", detail: "polls.pizza" });         // not a question
  assert.equal(questionsToday(dir, "U1", now), 2);
  assert.equal(questionsToday(dir, "U2", now), 0);
});

test("withinDailyCap: enforces, respects override, tolerates missing ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-usage-"));
  for (let i = 0; i < 3; i++) appendUsage(dir, { ts: "2026-10-24T09:00:00Z", event: "question", requester: "U1" });
  assert.deepEqual(withinDailyCap(dir, "U1", 3, now), { ok: false, used: 3, cap: 3 });
  assert.deepEqual(withinDailyCap(dir, "U1", 10, now), { ok: true, used: 3, cap: 10 });
  assert.deepEqual(withinDailyCap("/nonexistent", "U1", 25, now), { ok: true, used: 0, cap: 25 });
});

test("withinDailyCap: torn/tail lines are ignored, not fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-usage-"));
  writeFileSync(join(dir, "usage.jsonl"), '{"ts":"2026-10-24T09:00:00Z","event":"question","requester":"U1"}\n{"torn');
  assert.equal(questionsToday(dir, "U1", now), 1);
});

// ── answer events (issue #67) ─────────────────────────────────────────────
// Every question event must be paired with an answer event carrying
// durationMs / outcome / model, so a one-line jq over usage.jsonl answers
// "how long do answers take / what's the real failure rate". These test
// the ledger writer with the exact shapes the listener emits on each
// completion path (src/index.ts).

function lastEvent(dir: string): Record<string, unknown> {
  const lines = readFileSync(join(dir, "usage.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "exactly one ledger line written");
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

test("usage ledger: answer event on the ok path (durationMs, outcome, model)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-usage-"));
  appendUsage(dir, {
    ts: "2026-10-24T12:00:00Z",
    event: "answer",
    requester: "U1",
    channel: "C1",
    case: "0f1e2d3c",
    durationMs: 12_345,
    outcome: "ok",
    model: "or-pizza/qwen3-vl-32b-instruct",
  });
  const ev = lastEvent(dir);
  assert.equal(ev.event, "answer");
  assert.equal(ev.durationMs, 12_345);
  assert.equal(ev.outcome, "ok");
  assert.equal(ev.model, "or-pizza/qwen3-vl-32b-instruct");
  assert.equal(ev.requester, "U1");
  assert.equal(ev.case, "0f1e2d3c");
  assert.ok(!("errorTail" in ev), "ok runs carry no errorTail");
});

test("usage ledger: answer event on the error path carries a truncated errorTail", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-usage-"));
  const stderr = "x".repeat(500) + "rds data api unreachable";
  appendUsage(dir, {
    ts: "2026-10-24T12:00:01Z",
    event: "answer",
    requester: "U1",
    channel: "C1",
    case: "0f1e2d3c",
    durationMs: 98_765,
    outcome: "error",
    model: "or-pizza/qwen3-vl-32b-instruct",
    errorTail: stderr.slice(-200),
  });
  const ev = lastEvent(dir);
  assert.equal(ev.outcome, "error");
  assert.equal(ev.durationMs, 98_765);
  const tail = ev.errorTail as string;
  assert.ok(tail.length <= 200, "errorTail is at most ~200 chars");
  assert.ok(tail.endsWith("rds data api unreachable"), "errorTail keeps the END of stderr");
});

test("usage ledger: answer event on the timeout path reports outcome=timeout", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-usage-"));
  appendUsage(dir, {
    ts: "2026-10-24T12:20:00Z",
    event: "answer",
    requester: "U1",
    channel: "C1",
    case: "0f1e2d3c",
    durationMs: 1_200_000,
    outcome: "timeout",
  });
  const ev = lastEvent(dir);
  assert.equal(ev.outcome, "timeout");
  assert.equal(ev.durationMs, 1_200_000);
});

test("usage ledger: answer event without a model omits the key (JSON.stringify)", () => {
  // No PI_MODEL override on the box → cfg.piModel undefined → the field is
  // omitted rather than null, matching the existing ledger's sparse lines.
  const dir = mkdtempSync(join(tmpdir(), "pe-usage-"));
  appendUsage(dir, {
    ts: "2026-10-24T12:00:02Z",
    event: "answer",
    requester: "U1",
    channel: "C1",
    case: "0f1e2d3c",
    durationMs: 5_000,
    outcome: "ok",
    model: undefined,
  });
  const ev = lastEvent(dir);
  assert.ok(!("model" in ev), "undefined model is omitted, not null");
  assert.ok(!("tokens" in ev), "tokens stays reserved until pi exposes usage");
});

test("usage ledger: question and answer events pair into one record per case", () => {
  // The acceptance shape: every question line has a matching answer line.
  const dir = mkdtempSync(join(tmpdir(), "pe-usage-"));
  appendUsage(dir, { ts: "2026-10-24T12:00:00Z", event: "question", requester: "U1", channel: "C1", case: "0f1e2d3c" });
  appendUsage(dir, { ts: "2026-10-24T12:00:30Z", event: "answer", requester: "U1", channel: "C1", case: "0f1e2d3c", durationMs: 30_000, outcome: "ok" });
  const events = readFileSync(join(dir, "usage.jsonl"), "utf8")
    .split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { event: string; case?: string });
  const paired = events.filter((e) => e.event === "answer" && events.some((q) => q.event === "question" && q.case === e.case));
  assert.equal(paired.length, 1, "the answer event pairs with its question event");
  // questionsToday must still count only question events — answer events
  // share the requester field and must not inflate the daily cap.
  assert.equal(questionsToday(dir, "U1", now), 1, "answer events don't count toward the cap");
});
