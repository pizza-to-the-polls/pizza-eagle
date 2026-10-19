/**
 * Environment config. All values may be overridden via env vars —
 * see .env.example. On the ops box these come from the systemd unit's
 * EnvironmentFile, which bootstrap.sh populates from Secrets Manager.
 */

export interface Config {
  /** Slack app-level token (xapp-...) for Socket Mode */
  slackAppToken: string;
  /** Slack bot token (xoxb-...) */
  slackBotToken: string;
  /** channels the bot answers in (empty = answer anywhere it's added) */
  allowedChannels: Set<string>;
  /** if non-empty, only these user IDs may trigger investigations */
  allowedUsers: Set<string>;
  /** pi binary */
  piBin: string;
  /** root for thread map, per-thread workdirs, pi session files */
  stateDir: string;
  /** operator context (AGENTS.md) copied into each workdir */
  agentDir: string;
  /** wall-clock cap on a single investigation */
  timeoutMs: number;
  /** concurrent investigations */
  maxConcurrent: number;
}

function csv(name: string, env: NodeJS.ProcessEnv): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function requireValue(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const slackAppToken = requireValue("SLACK_APP_TOKEN", env);
  const slackBotToken = requireValue("SLACK_BOT_TOKEN", env);
  if (!slackAppToken.startsWith("xapp-")) {
    throw new Error("SLACK_APP_TOKEN must be an app token (xapp-...)");
  }
  if (!slackBotToken.startsWith("xoxb-")) {
    throw new Error("SLACK_BOT_TOKEN must be a bot token (xoxb-...)");
  }
  return {
    slackAppToken,
    slackBotToken,
    allowedChannels: new Set(csv("ALLOWED_CHANNELS", env)),
    allowedUsers: new Set(csv("ALLOWED_USERS", env)),
    piBin: env.PI_BIN ?? "pi",
    stateDir: env.BOT_STATE_DIR ?? "./state",
    agentDir: env.AGENT_DIR ?? "../agent",
    timeoutMs: Number(env.INVESTIGATE_TIMEOUT_MS ?? 10 * 60_000),
    maxConcurrent: Math.max(1, Number(env.MAX_CONCURRENT ?? 2)),
  };
}