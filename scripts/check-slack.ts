/**
 * Pre-flight check for local dev — validates everything Slack-side before
 * you start the listener:
 *
 *   1. bot token (auth.test)          → prints bot name/team
 *   2. Socket Mode (hello)            → app token connects
 *   3. each ALLOWED_CHANNELS           → bot can post there (i.e. it's invited)
 *
 * Run: npm run check:slack   (reads .env like the listener does)
 */
import { WebClient } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
import { loadConfig } from "../src/config.js";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
};

async function main(): Promise<void> {
  const cfg = loadConfig();

  // 1. bot token
  const slack = new WebClient(cfg.slackBotToken);
  try {
    const me = await slack.auth.test();
    ok(
      "bot token (auth.test)",
      true,
      `@${me.user as string} on workspace ${me.team as string}`,
    );
  } catch (e) {
    ok("bot token (auth.test)", false, (e as Error).message);
    process.exit(1);
  }

  // 2. Socket Mode / app token — connect, wait for the connect event, disconnect
  try {
    const socket = new SocketModeClient({ appToken: cfg.slackAppToken });
    // socket-mode v2 emits "connected" (v1 emitted "hello") — accept both.
    const hello = new Promise<boolean>((resolve) => {
      socket.on("connected", () => resolve(true));
      socket.on("hello", () => resolve(true));
      setTimeout(() => resolve(false), 10_000);
    });
    await socket.start();
    const connected = await hello;
    void socket.disconnect();
    ok("app token (Socket Mode connected)", connected);
  } catch (e) {
    ok("app token (Socket Mode connected)", false, (e as Error).message);
    process.exit(1);
  }

  // 3. allowlisted channels — can the bot post? (= was it invited)
  if (cfg.allowedChannels.size === 0) {
    console.log("− ALLOWED_CHANNELS empty — bot answers in any channel it joins");
  } else {
    for (const channel of cfg.allowedChannels) {
      try {
        await slack.chat.postMessage({
          channel,
          text: ":white_check_mark: ptp-bot setup check — you can delete this.",
        });
        ok(`channel ${channel}`, true, "bot posted (invited)");
      } catch (e) {
        const err = e as { data?: { error?: string } };
        const code = err.data?.error ?? "unknown";
        const hint =
          code === "not_in_channel"
            ? "invite the bot: /invite @<app name>"
            : code === "channel_not_found"
              ? "bad channel ID (should start with C...)"
              : code === "missing_scope"
                ? "add chat:write scope"
                : code;
        ok(`channel ${channel}`, false, `${code} — ${hint}`);
      }
    }
  }

  // 4. allowlisted users — plausible IDs only (can't verify without users:read)
  if (cfg.allowedUsers.size) {
    for (const user of cfg.allowedUsers) {
      const plausible = /^U[A-Za-z0-9]{5,}$/.test(user);
      ok(
        `user ${user}`,
        plausible,
        plausible ? "format ok (full check needs users:read)" : "should look like U…",
      );
    }
  } else {
    console.log("− ALLOWED_USERS empty — anyone can trigger investigations");
  }

  console.log(failed ? `\n${failed} checks failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

void main();