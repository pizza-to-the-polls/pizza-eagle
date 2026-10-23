import test from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, stripMention, toSlackMrkdwn } from "../src/slack.js";

test("mrkdwn: ATX headers become bold lines", () => {
  assert.equal(toSlackMrkdwn("## Report status\n### Details"), "*Report status*\n*Details*");
});

test("mrkdwn: **bold** becomes *bold*", () => {
  assert.equal(toSlackMrkdwn("this is **important** news"), "this is *important* news");
});

test("mrkdwn: bullets become •", () => {
  assert.equal(toSlackMrkdwn("- one\n- two\n* three"), "• one\n• two\n• three");
});

test("mrkdwn: markdown links become Slack links", () => {
  assert.equal(
    toSlackMrkdwn("see [the docs](https://example.com/x) for more"),
    "see <https://example.com/x|the docs> for more",
  );
});

test("mrkdwn: code fences and inline code are untouched", () => {
  const md = "before\n```js\nconst x = **not bold**;\n```\nafter `**also not bold**` done";
  const out = toSlackMrkdwn(md);
  assert.ok(out.includes("const x = **not bold**;"), "fence content preserved");
  assert.ok(out.includes("`**also not bold**`"), "inline code preserved");
});

test("stripMention: removes leading @mention", () => {
  assert.equal(stripMention("<@U0CAH280B6E> why did upload 13297 fail?"), "why did upload 13297 fail?");
  assert.equal(stripMention("<@U0CAH280B6E>: what's the last zap?"), "what's the last zap?");
  assert.equal(stripMention("hello <@U0CAH280B6E>"), "hello <@U0CAH280B6E>");
  assert.equal(stripMention("  <@U12345>   "), "");
});

test("chunkMarkdown: short text stays single chunk", () => {
  assert.deepEqual(chunkMarkdown("short", 3800), ["short"]);
});

test("chunkMarkdown: long text chunks respect the limit and split on boundaries", () => {
  const para = "paragraph of finding text that keeps going\n".repeat(30);
  const text = Array.from({ length: 12 }, (_, i) => `## Section ${i}\n${para}`).join("\n\n");
  const chunks = chunkMarkdown(text, 3800);
  assert.ok(chunks.length > 1, "expected multiple chunks");
  for (const c of chunks) assert.ok(c.length <= 3800, `chunk too long: ${c.length}`);
  // content survives: whitespace-insensitive reassembly (the splitter
  // trims boundary newlines, so exact join differs by \n's only)
  assert.equal(
    chunks.join("\n\n").replace(/\s+/g, ""),
    text.replace(/\s+/g, ""),
    "chunks preserve all content",
  );
});
