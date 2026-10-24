import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
