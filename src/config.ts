/**
 * Environment config. All values may be overridden via env vars or a local
 * `.env` file — see .env.example. On the ops box these come from the systemd
 * unit's EnvironmentFile (which bootstrap.sh populates from Secrets Manager);
 * locally, from .env / your shell.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  /** Slack app-level token (xapp-...) for Socket Mode */
  slackAppToken: string;
  /** Slack bot token (xoxb-...) */
  slackBotToken: string;
  /** channels the bot answers in (empty = answer anywhere it's added) */
  allowedChannels: Set<string>;
  /** if non-empty, only these user IDs may trigger investigations */
  allowedUsers: Set<string>;
  /** pi binary (also passed to the isolation wrapper for its fallback mode) */
  piBin: string;
  /**
   * Isolation wrapper for investigations (issue #5): investigate.ts spawns
   * this instead of pi directly — it drops to a separate OS user and, when
   * available, a rootless Podman container.
   */
  invWrapper: string;
  /** container image the wrapper runs (mode 1) */
  invImage: string;
  /** OS user investigations run as (modes 1+2) — NOT the listener's user */
  invUser: string;
  /** pi agent config dir (~/.pi/agent) staged into the run by the wrapper */
  piAgentDir: string;
  /** Per-run model override (--model <provider/id pattern>); unset = settings.json default */
  piModel?: string;
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

/**
 * Load a local .env file (KEY=VALUE lines). Values already set in the real
 * environment win — the file only fills gaps, so shell exports and the
 * systemd EnvironmentFile always take precedence.
 */
export function loadEnvFile(path: string): Record<string, string> {
  try {
    const raw = readFileSync(path, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {}; // no .env, or unreadable — fine, env-only mode
  }
}

/** Merge .env under the real environment (real env wins). */
export function mergedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...loadEnvFile(".env"), ...env };
}

/**
 * Apply .env values into process.env for keys not already set — so
 * passthrough vars (e.g. AWS_PROFILE) reach the pi subprocess and its
 * shell tools. Real environment always wins over the file.
 */
export function applyEnvFileToProcess(path = ".env"): void {
  const file = loadEnvFile(path);
  for (const [k, v] of Object.entries(file)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = mergedEnv(env);
  applyEnvFileToProcess();
  const slackAppToken = requireValue("SLACK_APP_TOKEN", e);
  const slackBotToken = requireValue("SLACK_BOT_TOKEN", e);
  if (!slackAppToken.startsWith("xapp-")) {
    throw new Error("SLACK_APP_TOKEN must be an app token (xapp-...)");
  }
  if (!slackBotToken.startsWith("xoxb-")) {
    throw new Error("SLACK_BOT_TOKEN must be a bot token (xoxb-...)");
  }
  return {
    slackAppToken,
    slackBotToken,
    allowedChannels: new Set(csv("ALLOWED_CHANNELS", e)),
    allowedUsers: new Set(csv("ALLOWED_USERS", e)),
    piBin: e.PI_BIN ?? "pi",
    // Absolute by construction: investigate.ts spawns the wrapper with
    // cwd = the case workdir, so a repo-relative path would resolve wrong.
    // import.meta.url keeps it correct both from src/ (tsx) and dist/ (box).
    invWrapper:
      e.INV_WRAPPER ??
      fileURLToPath(new URL("../scripts/run-investigation-container.sh", import.meta.url)),
    invImage: e.INV_IMAGE ?? "pizza-eagle-investigation",
    invUser: e.INV_USER ?? "pizza-eagle-inv",
    piAgentDir: e.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    piModel: e.PI_MODEL || undefined,
    stateDir: e.BOT_STATE_DIR ?? "./state",
    // repo-relative default: agent/ inside this repo (works from repo root
    // locally and from WorkingDirectory=/opt/pizza-eagle on the box)
    agentDir: e.AGENT_DIR ?? "./agent",
    timeoutMs: Number(e.INVESTIGATE_TIMEOUT_MS ?? 10 * 60_000),
    maxConcurrent: Math.max(1, Number(e.MAX_CONCURRENT ?? 2)),
  };
}