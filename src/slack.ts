/**
 * Slack helpers: ack-fast, answer-async.
 *
 * Slack Event API deliveries must be acked ~3s — investigations take
 * minutes. So every job starts by posting a status message, does the
 * work, then posts findings as threaded replies and edits the status.
 */

import type { WebClient } from "@slack/web-api";

const MAX_CHUNK = 3800; // Slack posts cap at ~4000 chars with formatting

/**
 * Standard markdown (what pi emits) → Slack mrkdwn.
 *
 * Slack mrkdwn is NOT markdown: **bold** renders literally, ### headers
 * render literally, [text](url) renders literally. Convert:
 *   - ``` fenced blocks stay verbatim (Slack renders them)
 *   - **bold** → *bold*  (but never inside code fences/inline code)
 *   - ### ATX headers → *bold lines*
 *   - - /* bullets → •
 *   - [text](url) → <url|text>
 * Inline `code` is untouched (same syntax in both).
 */
export function toSlackMrkdwn(md: string): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]+`)/g); // fences + inline code verbatim
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // inside fence/inline code — leave alone
      // Markdown tables render as raw pipes in Slack — fence them instead.
      part = part.replace(
        /(?:^|\n)((?:[ \t]*\|[^\n]*\|[ \t]*(?:\n|$))+)/g,
        (block) => `\n\`\`\`\n${block.trim()}\n\`\`\`\n`,
      );
      return part
        .replace(/^#{1,6}\s+(.+)$/gm, (_m, t) => `*${String(t).trim()}*`)
        .replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => `*${t}*`)
        .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, (_m, t, url) => `<${url}|${t}>`)
        .replace(/^\s*[-*]\s+/gm, "• ");
    })
    .join("");
}

/** Thread review: format Slack replies as a readable transcript. */
export function formatThreadMessages(
  messages: Array<{ ts?: string; user?: string; username?: string; text?: string }>,
): string {
  return messages
    .map((m) => {
      const clock = m.ts ? new Date(Number(m.ts) * 1000).toISOString().slice(11, 19) : "--:--:--";
      const who = m.username ?? m.user ?? "?";
      const text = (m.text ?? "").replace(/<@([A-Z0-9]+)>/g, "@$1");
      return `[${clock}] ${who}: ${text}`;
    })
    .join("\n");
}

/** Fetch the full thread the bot was tagged in (needs channels:history). */
export async function fetchThreadContext(
  slack: WebClient,
  channel: string,
  threadTs: string,
): Promise<string> {
  const res = await slack.conversations.replies({ channel, ts: threadTs, limit: 200 });
  return formatThreadMessages(
    (res.messages ?? []) as Array<{ ts?: string; user?: string; username?: string; text?: string }>,
  );
}

/** Toggle an emoji reaction on a message. Never throws — it's cosmetic
 * state (working/done), and a reaction failure must never fail a run. */
export async function react(
  client: WebClient,
  channel: string,
  ts: string,
  emoji: string,
  on: boolean,
): Promise<void> {
  try {
    const args = { channel, timestamp: ts, name: emoji };
    await (on ? client.reactions.add(args) : client.reactions.remove(args));
  } catch (e) {
    console.warn(`[pizza-eagle] reaction ${on ? "add" : "remove"} ${emoji} (cosmetic): ${(e as Error).message}`);
  }
}

export function stripMention(text: string): string {
  // "<@U12345> why is upload 13280 orphaned?" -> "why is upload 13280 orphaned?"
  // IDs can contain digits + letters; tolerate a trailing colon/label forms.
  return text.replace(/^\s*<@[A-Za-z0-9]+>\s*:?(?=\s|$)/, "").trim();
}

export async function postStatus(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<string | undefined> {
  const res = await client.chat.postMessage({ channel, thread_ts: threadTs, text });
  return res.ts;
}

export async function editStatus(
  client: WebClient,
  channel: string,
  statusTs: string,
  text: string,
): Promise<void> {
  await client.chat.update({ channel, ts: statusTs, text });
}

/** Split long findings into threaded posts that respect Slack's length cap. */
export async function postFindings(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  const mrkdwn = toSlackMrkdwn(text.trim());
  if (!mrkdwn) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "_Investigation finished with no output._",
    });
    return;
  }
  for (const chunk of chunkMarkdown(mrkdwn, MAX_CHUNK)) {
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
  }
}

export function chunkMarkdown(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // Prefer splitting on blank lines, then newlines, then hard-wrap.
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}