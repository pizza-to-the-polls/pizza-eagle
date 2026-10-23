import test from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, formatThreadMessages, react, stripMention, toSlackMrkdwn } from "../src/slack.js";

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

test("mrkdwn: markdown tables become code blocks (Slack can't render pipes)", () => {
  const out = toSlackMrkdwn("Summary:\n| File | Change |\n|---|---|\n| a.ts | red → blue |\nDone");
  assert.ok(out.includes("```"), "table gets fenced");
  assert.ok(out.includes("| File | Change |"), "table content preserved");
  assert.ok(!/\*File\*/.test(out), "table cells not mangled into bold");
});

test("mrkdwn: tables inside existing code fences stay untouched", () => {
  const md = "before\n```\n| a | b |\n|---|---|\n```\nafter";
  const out = toSlackMrkdwn(md);
  assert.equal(out.match(/```/g)?.length, 2, "no nested fencing");
});

test("formatThreadMessages: readable transcript with @mentions resolved", () => {
  const out = formatThreadMessages([
    { ts: "1792776633.189779", user: "U2ZLJ2KBP", text: "hey <@U0CAH280B6E> what's up with uploads?" },
    { ts: "1792777000.000001", username: "pizza_eagle", text: "checking…" },
  ]);
  assert.ok(out.includes("[17:30:33] U2ZLJ2KBP: hey @U0CAH280B6E what's up"), "user + mention resolved");
  assert.ok(out.includes("[17:36:40] pizza_eagle: checking"), "bot lines included");
});

test("react: add/remove calls, errors swallowed", async () => {
  const calls: string[] = [];
  const fake = {
    reactions: {
      add: async (a: Record<string, unknown>) => { calls.push(`add:${a.name}:${a.timestamp}`); },
      remove: async (a: Record<string, unknown>) => { calls.push(`remove:${a.name}`); },
    },
  } as unknown as import("../src/slack.js").WebClient;
  await react(fake, "C1", "123.456", "pizza-eagle-working", true);
  await react(fake, "C1", "123.456", "pizza-eagle-working", false);
  assert.deepEqual(calls, ["add:eyes:123.456", "remove:eyes"]);
  // a failing reaction must never throw
  const broken = {
    reactions: {
      add: async () => { throw new Error("nope"); },
      remove: async () => { throw new Error("nope"); },
    },
  } as unknown as import("../src/slack.js").WebClient;
  await react(broken, "C1", "1", "pizza-eagle-working", true); // no throw = pass
});
