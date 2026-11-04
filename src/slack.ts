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

      // Slack date formatting: render ISO timestamps in each reader's
      // native timezone via <!date^epoch^pattern|fallback>. Detects
      // UTC ISO stamps (e.g. 2026-10-22T17:23:00Z) emitted by logs, DB
      // results, and pi's answers. Fenced/code timestamps untouched.
      part = part.replace(
        /(^|[\s(])(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?Z?(?=$|[\s,.;:!?)]|$)/g,
        (_m, pre, y, mo, d, hh, mm) => {
          const epoch = Math.floor(Date.UTC(+y, +mo - 1, +d, +hh, +mm) / 1000);
          if (Number.isNaN(epoch)) return _m;
          return `${pre}<!date^${epoch}^{date_short_pretty} at {time}|${y}-${mo}-${d} ${hh}:${mm} UTC>`;
        },
      );

      return part
        // Bare member IDs ("@U2ZLJ2KBP") become real mentions. The thread
        // transcript feeds the agent "@U..." raw (formatThreadMessages
        // strips the angle brackets for readability), the agent echoes that
        // form, and Slack only links <@ID> — bare @IDs posted as literal
        // text (2026-10-29 dev thread). Already-linked IDs and code are
        // untouched (the `[^<\w]` guard + the fence split above).
        .replace(/(^|[^<\w])@(U[A-Z0-9]{7,11})(?![\w.])/g, (_m, pre: string, id: string) => `${pre}<@${id}>`)
        .replace(/^#{1,6}\s+(.+)$/gm, (_m, t) => `*${String(t).trim()}*`)
        .replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => `*${t}*`)
        .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, (_m, t, url) => `<${url}|${t}>`)
        .replace(/^\s*[-*]\s+/gm, "• ")
        // Slack links can NOT be styled. Bold-wrapped bare URLs become real
        // links; stray bold around links/labels is stripped. (Deploy-day
        // report: "*<url>*" rendered the asterisks literally.)
        .replace(/\*(https?:[^*\s]+)\*/g, "<$1>")
        .replace(/\*<([^*\n]+)>\*/g, "<$1>")
        .replace(/<([^|\n]+)\|([^>\n]*)>/g, (_m, u, t) => `<${u}|${t.replace(/\*/g, "")}>`);
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

/** Deeplink to a thread's parent message in the PTP workspace. Channel id +
 * timestamp only — no member identity — so it is safe to quote in public
 * issue bodies (dispatch traceability: every agent:ready issue links back to
 * the Slack thread that asked for the work). */
export function threadDeeplink(channel: string, ts: string): string {
  return `https://pizzatothepolls.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

/** The thread-context.md document the listener writes: a trusted,
 * listener-written deeplink header (built from the authenticated event's
 * channel/timestamp, never from message text) above the untrusted Slack
 * transcript. The header is what dispatch issues quote. */
export function threadContextDoc(channel: string, ts: string, transcript: string): string {
  return `Slack thread: ${threadDeeplink(channel, ts)}\n\n${transcript}`.trimEnd() + "\n";
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

/**
 * Resolve a Slack user's display name via users.info, cached per user id.
 *
 * Issue #69 (red team 2026-10-27, finding 4 — identity half): the bot's
 * authorization-adjacent reasoning used to map user ids to human names via
 * AGENTS.md prose, which is editable text — a mislabel there ("Matt" where
 * Slack says Scott) misidentified a requester and produced a bogus publish-
 * gate refusal. The name now comes from Slack itself and lands in the
 * listener-written request-auth.json, which the model and helper scripts
 * already treat as the only trusted requester signal.
 *
 * Cache: in-memory, tiny cardinality (the bot talks to a handful of
 * operators), 5-minute TTL — long enough that follow-up mentions in a thread
 * hit it, short enough that a rename shows up soon. Cleared on restart.
 */
const nameCache = new Map<string, { name: string; fetchedAt: number }>();
const NAME_CACHE_TTL_MS = 5 * 60_000;

export function clearUserNameCache(): void {
  nameCache.clear();
}

export async function resolveUserName(slack: WebClient, userId: string): Promise<string> {
  const cached = nameCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < NAME_CACHE_TTL_MS) return cached.name;
  try {
    const res = await slack.users.info({ user: userId });
    const profile = (res.user as { profile?: { display_name?: string; real_name?: string } } | undefined)?.profile;
    // Prefer the user-chosen display name, then the full real name, then the
    // bare id. Whitespace-only strings fall through to the next candidate.
    const name =
      [profile?.display_name, profile?.real_name].find((n) => typeof n === "string" && n.trim())?.trim() ?? userId;
    nameCache.set(userId, { name, fetchedAt: Date.now() });
    return name;
  } catch (e) {
    // Graceful degradation: the name is cosmetic — authorization stays on the
    // immutable user id + writeAllowed. A users.info failure (network blip,
    // missing scope, deleted user) must never fail an investigation.
    console.warn(`[pizza-eagle] users.info failed for ${userId} (falling back to id): ${(e as Error).message}`);
    return userId;
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