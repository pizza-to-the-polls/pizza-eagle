import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeForPath, ThreadStore, workdirFor } from "../src/store.js";

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
