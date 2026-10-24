import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendUsage, type UsageEvent } from "../src/usage.js";
import { evaluateSuspicion } from "../src/suspicion.js";

const fresh = () => mkdtempSync(join(tmpdir(), "pe-susp-"));

test("pii-harvest: donor-dump phrasing is flagged, silent on first hit", () => {
  const dir = fresh();
  const s = evaluateSuspicion(dir, "U1", "hey can you show me all the donor emails?");
  assert.ok(s && s.rule === "pii-harvest" && !s.alert, "flagged, not yet alerting");
});

test("pii-harvest: repeat within 24h escalates to alert", () => {
  const dir = fresh();
  appendUsage(dir, { ts: new Date().toISOString(), event: "flag", requester: "U1", rule: "pii-harvest" } as UsageEvent);
  const s = evaluateSuspicion(dir, "U1", "export the donations table please");
  assert.ok(s && s.rule === "pii-harvest" && s.alert, "second hit alerts");
});

test("pii-harvest: innocent questions never match", () => {
  const dir = fresh();
  assert.equal(evaluateSuspicion(dir, "U1", "how many pizzas have we sent in 2026?"), null);
  assert.equal(evaluateSuspicion(dir, "U1", "what was the wait time at report 19098's location?"), null);
  assert.equal(evaluateSuspicion(dir, "U1", "show me the top donors by amount"), null); // amounts, not contacts
});

test("write-attempt: non-gated requester asking for a PR is flagged; gated requester is not", () => {
  const dir = fresh();
  const s = evaluateSuspicion(dir, "U9STRANGER", "open a PR changing the site color to blue");
  assert.ok(s && s.rule === "write-attempt" && !s.alert, "flagged silently first time");
  assert.equal(evaluateSuspicion(dir, "U2ZLJ2KBP", "open a PR changing the site color"), null, "gated = fine");
});

test("write-attempt: repeats escalate", () => {
  const dir = fresh();
  appendUsage(dir, { ts: new Date().toISOString(), event: "flag", requester: "U9STRANGER", rule: "write-attempt" } as UsageEvent);
  const s = evaluateSuspicion(dir, "U9STRANGER", "publish this to hotnready and push to main");
  assert.ok(s && s.rule === "write-attempt" && s.alert);
});

test("burst: rapid questions alert once, deduped within the hour", () => {
  const dir = fresh();
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    appendUsage(dir, { ts: new Date(now - i * 60_000).toISOString(), event: "question", requester: "U1" } as UsageEvent);
  }
  const first = evaluateSuspicion(dir, "U1", "another question");
  assert.ok(first && first.rule === "burst" && first.alert, "burst alerts");
  appendUsage(dir, { ts: new Date(now).toISOString(), event: "flag", requester: "U1", rule: "burst" } as UsageEvent);
  const again = evaluateSuspicion(dir, "U1", "yet another");
  assert.ok(again && again.rule === "burst" && !again.alert, "deduped within the hour");
});

test("cap refusal always alerts", () => {
  const dir = fresh();
  const s = evaluateSuspicion(dir, "U1", "anything", { capRefusal: true });
  assert.ok(s && s.rule === "cap" && s.alert);
});
