import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsRestartRequeue, sanitizeForPath, ThreadStore, workdirFor } from "../src/store.js";

const rec = {
  sessionId: "abc-123",
  channel: "C01DY42HH96",
  workdir: "/tmp/w",
  questionCount: 2,
  lastRunAt: new Date().toISOString(),
  lastAnswer: "42 pizzas",
};

test("ThreadStore: roundtrip through disk survives", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-store-"));
  const file = join(dir, "threads.json");
  const s1 = new ThreadStore(file);
  s1.put("1792731089.063839", rec);
  const s2 = new ThreadStore(file); // fresh instance = reads from disk
  assert.equal(s2.get("1792731089.063839")?.sessionId, "abc-123");
  assert.equal(s2.get("1792731089.063839")?.questionCount, 2);
});

test("ThreadStore: corrupt file degrades to empty, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-store-"));
  const file = join(dir, "threads.json");
  writeFileSync(file, "{not json");
  const s = new ThreadStore(file);
  assert.equal(s.get("anything"), undefined);
});

test("sanitizeForPath: dots become underscores, junk stripped", () => {
  assert.equal(sanitizeForPath("1792731089.063839"), "1792731089_063839");
  assert.equal(sanitizeForPath("123.456/../../etc"), "123_456____");
});

test("workdirFor: nests under state/work with sanitized ts", () => {
  assert.equal(workdirFor("/opt/pizza-eagle/state", "1.2"), "/opt/pizza-eagle/state/work/1_2");
});

// ── In-flight tracking + restart requeue (issue #68) ─────────────────────────

const base = {
  sessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
  channel: "C01DY42HH96",
  workdir: "/tmp/w",
  questionCount: 1,
  lastRunAt: new Date().toISOString(),
  lastAnswer: null,
};

test("getInFlight: returns only records marked in-flight, as [threadTs, record] pairs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-store-"));
  const s = new ThreadStore(join(dir, "threads.json"));
  s.put("1.1", { ...base, inFlight: true });
  s.put("2.2", { ...base }); // never marked
  s.put("3.3", { ...base, inFlight: false }); // explicitly cleared
  const inflight = s.getInFlight();
  assert.equal(inflight.length, 1, "only the in-flight record is returned");
  assert.equal(inflight[0][0], "1.1");
  assert.equal(inflight[0][1].inFlight, true);
});

test("getInFlight: survives a disk roundtrip (the restart-requeue scan reads a fresh instance)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-store-"));
  const file = join(dir, "threads.json");
  const s1 = new ThreadStore(file);
  s1.put("1.1", {
    ...base,
    inFlight: true,
    statusTs: "1792731089.999888",
    lastQuestion: "how many pizzas did we send in 2026?",
    lastRequester: "U0B740NG8E6",
    lastRequesterName: "Nina",
  });
  s1.put("2.2", { ...base });
  const s2 = new ThreadStore(file); // fresh instance = the next process
  const inflight = s2.getInFlight();
  assert.equal(inflight.length, 1);
  const [ts, rec] = inflight[0];
  assert.equal(ts, "1.1");
  assert.equal(rec.statusTs, "1792731089.999888");
  assert.equal(rec.lastQuestion, "how many pizzas did we send in 2026?");
  assert.equal(rec.lastRequester, "U0B740NG8E6");
  assert.equal(rec.lastRequesterName, "Nina");
});

test("needsRestartRequeue: true only for runs that were in flight and never completed", () => {
  // A run that died mid-flight: flag set, question still pending → requeue.
  assert.equal(
    needsRestartRequeue({ ...base, inFlight: true, lastQuestion: "q" }),
    true,
    "interrupted run must be requeued",
  );
  // Completed (answer posted) but the finally that cleared inFlight never ran
  // (crash between answer and cleanup): must NOT requeue — no double answers.
  assert.equal(
    needsRestartRequeue({ ...base, inFlight: true, lastQuestion: undefined, lastAnswer: "done" }),
    false,
    "completed run must dedupe out of the requeue",
  );
  // Terminal failure already reported to the user (retry offer posted):
  // lastQuestion cleared, flag may still linger → not requeued either.
  assert.equal(
    needsRestartRequeue({ ...base, inFlight: true }),
    false,
    "flag without a pending question is stale, not requeueable",
  );
  // A live run in THIS process: inFlight set by executeRun at startup — but
  // getInFlight() during a RESTART scan cannot see those (new process), and
  // after a crash without inFlight there is nothing to clean up.
  assert.equal(needsRestartRequeue({ ...base, lastQuestion: "q" }), false);
  assert.equal(needsRestartRequeue(base), false);
});

test("backward compatibility: a pre-issue-68 threads.json (no optional fields) loads and never requeues", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-store-"));
  const file = join(dir, "threads.json");
  writeFileSync(
    file,
    JSON.stringify({ "1.1": { ...base } }, null, 2), // no statusTs/lastQuestion/inFlight
  );
  const s = new ThreadStore(file);
  assert.equal(s.get("1.1")?.sessionId, base.sessionId); // loads fine
  assert.deepEqual(s.getInFlight(), [], "no phantom in-flight records from old files");
});
