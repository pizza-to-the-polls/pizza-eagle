/**
 * Slack helpers: ack-fast, answer-async.
 *
 * Slack Event API deliveries must be acked ~3s — investigations take
 * minutes. So every job starts by posting a status message, does the
 * work, then posts findings as threaded replies and edits the status.
 */

import type { WebClient } from "@slack/web-api";

const MAX_CHUNK = 3800; // Slack posts cap at ~4000 chars with formatting

export function stripMention(text: string): string {
  // "<@U12345> why is upload 13280 orphaned?" -> "why is upload 13280 orphaned?"
  return text.replace(/^\s*<@[A-Z0-9]+>\s*/u, "").trim();
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
  const trimmed = text.trim();
  if (!trimmed) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "_Investigation finished with no output._",
    });
    return;
  }
  for (const chunk of chunkMarkdown(trimmed, MAX_CHUNK)) {
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