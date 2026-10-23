import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory } from "../src/investigate.js";

test("appendHistory: requester id rides into the case file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-inv-"));
  appendHistory(dir, "what changed?", "answer", "U2ZLJ2KBP");
  const out = readFileSync(join(dir, "case-history.md"), "utf8");
  assert.ok(out.includes("**Requester:** Slack member `U2ZLJ2KBP`"), "requester line present");
  assert.ok(out.includes("**Q:** what changed?"), "question preserved");
});

test("appendHistory: no requester means no requester line", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-inv-"));
  appendHistory(dir, "q", "a");
  const out = readFileSync(join(dir, "case-history.md"), "utf8");
  assert.ok(!out.includes("**Requester:**"), "no requester line");
});
