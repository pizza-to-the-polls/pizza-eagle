import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCasebook,
  casebookPath,
  readCasebook,
  renderCasebookDigest,
  writeCasebookDigest,
  CASEBOOK_QUESTION_MAX,
  CASEBOOK_ANSWER_MAX,
  CASEBOOK_DIGEST_ANSWER_MAX,
} from "../src/casebook.js";

const oct = new Date("2026-10-24T12:00:00Z");
const nov = new Date("2026-11-02T12:00:00Z");
const sid = "01234567-89ab-cdef-0123-456789abcdef";

test("appendCasebook lands in the monthly shard with clipped content", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-casebook-"));
  const question = "q".repeat(CASEBOOK_QUESTION_MAX + 100);
  const answer = "a".repeat(CASEBOOK_ANSWER_MAX + 100);
  appendCasebook(dir, { ts: oct.toISOString(), sessionId: sid, question, answer, outcome: "ok" }, oct);
  const path = casebookPath(dir, oct);
  assert.ok(path.endsWith("casebook-202610.jsonl"), `shard per month, got ${path}`);
  const e = JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof readCasebook>[number];
  assert.equal(e.sessionId, sid);
  assert.equal(e.question.length, CASEBOOK_QUESTION_MAX + 1); // clip + ellipsis
  assert.ok(e.question.endsWith("…"));
  assert.equal(e.answer!.length, CASEBOOK_ANSWER_MAX + 1);
  assert.ok(e.answer!.endsWith("…"));
});

test("appendCasebook is best-effort — a bad path never throws", () => {
  assert.doesNotThrow(() =>
    appendCasebook("/nonexistent-pe-dir", { ts: oct.toISOString(), sessionId: sid, question: "q", outcome: "error" }),
  );
});

test("readCasebook walks shards oldest→newest and ignores torn tail lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-casebook-"));
  appendCasebook(dir, { ts: nov.toISOString(), sessionId: sid, question: "nov case", answer: "nov verdict", outcome: "ok" }, nov);
  appendCasebook(dir, { ts: oct.toISOString(), sessionId: sid, question: "oct case", answer: "oct verdict", outcome: "ok" }, oct);
  appendFileSync(casebookPath(dir, oct), '{"torn'); // crash mid-append is not fatal to reads
  const all = readCasebook(dir);
  assert.deepEqual(all.map((e) => e.question), ["oct case", "nov case"]); // name-sorted shards
});

test("readCasebook tolerates a missing state dir", () => {
  assert.deepEqual(readCasebook("/nonexistent-pe-dir"), []);
});

test("digest: last N entries only, newest last, excerpt-capped", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-casebook-"));
  for (let i = 0; i < 25; i++) {
    appendCasebook(
      dir,
      {
        ts: nov.toISOString(),
        sessionId: sid,
        question: `question number ${i}`,
        answer: `verdict number ${i} — ${"x".repeat(400)}`,
        outcome: "ok",
      },
      nov,
    );
  }
  const d = renderCasebookDigest(dir, 10);
  assert.ok(d.includes("question number 15") && d.includes("question number 24"));
  assert.ok(!d.includes("question number 5\n") && !d.includes("question number 14")); // sliced off
  // excerpt cap keeps the digest a pointer, not a second copy
  assert.ok(!d.includes("x".repeat(CASEBOOK_DIGEST_ANSWER_MAX + 1)));
});

test("digest marks failures distinctly (outcome + error tail)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-casebook-"));
  appendCasebook(
    dir,
    { ts: oct.toISOString(), sessionId: sid, question: "why no report", outcome: "timeout", durationMs: 900_000 },
    oct,
  );
  const d = renderCasebookDigest(dir);
  assert.ok(d.includes("**Outcome:** timeout (15m)")); // duration surfaced
});

test("digest with no history says so", () => {
  assert.ok(renderCasebookDigest("/nonexistent-pe-dir").includes("(no prior cases)"));
});

test("writeCasebookDigest drops a listener-owned casebook.md into the workdir", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-casebook-"));
  appendCasebook(dir, { ts: oct.toISOString(), sessionId: sid, question: "why upload 13280", answer: "no report: deleted", outcome: "ok", requesterName: "Scott" }, oct);
  const wd = mkdtempSync(join(tmpdir(), "pe-workdir-"));
  writeCasebookDigest(dir, wd);
  const md = readFileSync(join(wd, "casebook.md"), "utf8");
  assert.ok(md.startsWith("# Casebook"));
  assert.ok(md.includes("why upload 13280"));
  assert.ok(md.includes("Scott"));
  // idempotent overwrite — a second write replaces, not appends
  writeCasebookDigest(dir, wd);
  assert.equal(readFileSync(join(wd, "casebook.md"), "utf8"), md);
});
