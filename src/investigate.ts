/**
 * The investigation runner: one pi subprocess per question.
 *
 *   pi --print --session-id <threadSessionId> --session-dir <state>/sessions "<question>"
 *     cwd = per-thread workdir (AGENTS.md operator context, case-history.md)
 *
 * Why subprocess rather than the SDK: a crashed/hung run can never take
 * down the listener, and each run gets a clean tool environment. The
 * session id is stable per Slack thread, so follow-ups resume context.
 *
 * Credential boundary: this process runs as the `pizza-eagle` OS user with
 * the instance role (read-only triage policy) — pi's shell tools inherit
 * that. There is deliberately no write path to the DB from here.
 */

import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

export interface InvestigationResult {
  answer: string;
  durationMs: number;
}

export class InvestigationError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

/**
 * In-flight investigation subprocesses, so a listener restart kills them
 * instead of orphaning them (an orphan keeps its parent env — including stale
 * AWS identity — and has previously self-served `aws login` into a browser
 * prompt; see the 2026-10-20 incident).
 */
export const activeInvestigations = new Set<ReturnType<typeof spawn>>();

/**
 * Build the argv for one pi run. The question rides as a single positional
 * Question text is user-controlled Slack input riding as the LAST argv
 * element AFTER `--` (end-of-options): it may itself start with "-"
 * (Slack users write "<@Pizza Eagle> - question" and stripMention keeps
 * the dash), and pi's CLI parser would otherwise reject it:
 * `Error: Unknown option: - ...` → exit 1 → "Investigation failed."
 * (2026-10-26 #dev thread).
 *
 * `--no-approve` DECLINES pi project trust: the cwd (the case workdir)
 * is pi-writable via pi's own write/bash tools, so a planted
 * `.pi/extensions/*.ts` would otherwise EXECUTE inside pi on the next
 * run (`--approve` trusted project-local files; verified on pi 1.4.0:
 * `pi --print --approve` runs `.pi/extensions` code, `--no-approve`
 * does not). Also declines project `.pi/mcp.json` (arbitrary MCP
 * server = subprocess), `.pi/settings.json`, `.pi/skills|prompts|themes`,
 * and ancestor `.agents/skills`. Operator context is unaffected:
 * AGENTS.md loads regardless of project trust (verified).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function piArgs(
  cfg: Config,
  opts: { question: string; sessionId: string },
): string[] {
  if (!UUID_RE.test(opts.sessionId)) {
    // Bot-generated (randomUUID) in practice, but the value round-trips
    // through state/threads.json — treat it as untrusted argv input.
    throw new Error(`invalid session id: ${JSON.stringify(opts.sessionId.slice(0, 64))}`);
  }
  if (!opts.question.trim()) {
    throw new Error("empty question");
  }
  return [
    "--print",
    "--session-id", opts.sessionId,
    "--session-dir", `${cfg.stateDir}/sessions`,
    "--no-approve", // decline project trust — see header note
    "--",
    opts.question,
  ];
}

/**
 * The pi child inherits this env — its bash tool runs as the bot OS user,
 * so anything here is one prompt-injected `printenv` away from a Slack
 * thread. Strip the listener's own Slack credentials (by name, and by
 * value so aliases can't smuggle them through). Everything else passes:
 * PATH/HOME, the AWS profile for read-only triage, and the env-keyed
 * model key pi needs (OPENROUTER_KEY_PIZZA).
 */
const BOT_SECRET_ENV = new Set(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);

export function childEnv(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (BOT_SECRET_ENV.has(k)) continue; // by name
    if (v === cfg.slackAppToken || v === cfg.slackBotToken) continue; // by value (aliases)
    out[k] = v;
  }
  return out;
}

export async function runInvestigation(
  cfg: Config,
  opts: { question: string; sessionId: string; workdir: string; requester?: string; writeAllowed?: boolean },
): Promise<InvestigationResult> {
  mkdirSync(opts.workdir, { recursive: true });

  // Listener-owned per-run authorization record (see writeRequestAuth):
  // written BEFORE the run so the operator prompt and the helper scripts
  // gate on Slack-authenticated identity, never on question text.
  writeRequestAuth(opts.workdir, {
    requester: opts.requester,
    writeAllowed: opts.writeAllowed,
  });

  // Operator context rides along into every run (idempotent).
  try {
    copyFileSync(join(cfg.agentDir, "AGENTS.md"), join(opts.workdir, "AGENTS.md"));
  } catch {
    console.warn(`[pizza-eagle] no AGENTS.md in AGENT_DIR (${cfg.agentDir}) — running bare`);
  }

  const sessionsDir = `${cfg.stateDir}/sessions`;
  mkdirSync(sessionsDir, { recursive: true });

  const args = piArgs(cfg, opts);

  // Requester + question land in the case file BEFORE the pi run, so the
  // AGENTS.md write-gate can verify the requester from Slack event metadata
  // even on a thread's FIRST question. (2026-10-25 #dev thread: a publish
  // request rode Q1 and the gate found no entry — entries were previously
  // appended only after each run.) Best-effort: never fail a run over it.
  tryHistory(() => openHistory(opts.workdir, opts.question, opts.requester));

  const started = Date.now();
  const child = spawn(cfg.piBin, args, {
    cwd: opts.workdir,
    env: childEnv(cfg),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  activeInvestigations.add(child);

  const timedOut = await new Promise<boolean>((resolve) => {
    const killer = setTimeout(() => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.on("exit", () => clearTimeout(force));
      resolve(true);
    }, cfg.timeoutMs);
    child.on("exit", () => {
      clearTimeout(killer);
      resolve(false);
    });
    child.on("error", () => {
      clearTimeout(killer);
      resolve(false);
    });
  });

  const [code, signal] = await exitOf(child);
  activeInvestigations.delete(child);
  const durationMs = Date.now() - started;
  const answer = stdout.trim();

  if (timedOut) {
    tryHistory(() => closeHistory(opts.workdir, "(timed out)"));
    throw new InvestigationError(
      `Investigation exceeded ${Math.round(cfg.timeoutMs / 60_000)} minutes and was stopped.`,
      stderr,
    );
  }
  if (code !== 0 || !answer) {
    tryHistory(() => closeHistory(opts.workdir, answer || "(no output)"));
    const tail = stderr.trim().slice(-800);
    throw new InvestigationError(
      `pi exited with code ${code ?? "?"}${signal ? ` (${signal})` : ""}.`,
      tail,
    );
  }

  tryHistory(() => closeHistory(opts.workdir, answer));
  return { answer, durationMs };
}

/**
 * Machine-readable per-run authorization, written by the LISTENER from
 * the Slack event's authenticated user metadata before each pi run.
 *
 * This is the ONLY requester signal the operator prompt and the helper
 * scripts (gh-token.mjs, publish-hotnready.sh) trust. The old scheme —
 * a `**Requester:**` line in the newest case-history.md entry — was
 * forgeable, because openHistory() appends the raw question into that
 * same file and a question can carry its own `---` + header + requester
 * line (red team 2026-10-27, finding 4: verified, and undetected by the
 * suspicion rules). case-history.md Requester lines stay as transcript;
 * they are no longer auth.
 *
 * A tool-level compromise could still rewrite this file (same OS user) —
 * the durable fix for that is the per-run sandbox follow-up, not this file.
 */
export function writeRequestAuth(
  workdir: string,
  auth: { requester?: string; writeAllowed?: boolean },
): void {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(
    join(workdir, "request-auth.json"),
    JSON.stringify(
      {
        requester: auth.requester ?? null,
        writeAllowed: Boolean(auth.writeAllowed),
        ts: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
}

/**
 * Durable per-thread case file — cheap context even if the session id breaks.
 * The requester's Slack member id rides along so AGENTS.md can gate
 * write-powers (PRs, hotnready publishes) to vetted humans while
 * investigations stay open to the whole workspace.
 *
 * Two halves: openHistory (Requester + Q) runs BEFORE the pi subprocess —
 * the write-gate checks the newest entry's Requester line, which must exist
 * during the run itself, first question included — and closeHistory (answer
 * + separator) after it. Both best-effort via tryHistory.
 */
export function openHistory(
  workdir: string,
  question: string,
  requester?: string,
): void {
  const stamp = new Date().toISOString();
  const who = requester ? `\n**Requester:** Slack member \`${requester}\`\n` : "\n";
  appendFileSync(`${workdir}/case-history.md`, `## ${stamp}\n${who}**Q:** ${question}\n\n`);
}

export function closeHistory(workdir: string, answer: string): void {
  appendFileSync(`${workdir}/case-history.md`, `${answer}\n\n---\n\n`);
}

/** Best-effort wrapper: a failed case-file write must never lose an answer. */
function tryHistory(write: () => void): void {
  try {
    write();
  } catch (e) {
    console.warn(`[pizza-eagle] case history write failed (continuing): ${(e as Error).message}`);
  }
}

function exitOf(child: ReturnType<typeof spawn>): Promise<[number | null, string | null]> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve([child.exitCode, child.signalCode]);
      return;
    }
    child.on("exit", (code, signal) => resolve([code, signal]));
  });
}