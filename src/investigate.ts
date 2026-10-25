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
import { appendFileSync, copyFileSync, mkdirSync } from "node:fs";
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
 * AFTER `--`: question text may itself start with "-" (Slack users write
 * "<@Pizza Eagle> - question" and stripMention keeps the dash), and pi's
 * CLI parser would otherwise reject it: `Error: Unknown option: - ...` →
 * exit 1 → "Investigation failed." (2026-10-26 #dev thread). `--` ends
 * option parsing, so the question is taken verbatim however it starts.
 */
export function piArgs(
  cfg: Config,
  opts: { question: string; sessionId: string },
): string[] {
  return [
    "--print",
    "--session-id", opts.sessionId,
    "--session-dir", `${cfg.stateDir}/sessions`,
    "--approve", // workdir contains only bot-written context files
    "--",
    opts.question,
  ];
}

export async function runInvestigation(
  cfg: Config,
  opts: { question: string; sessionId: string; workdir: string; requester?: string },
): Promise<InvestigationResult> {
  mkdirSync(opts.workdir, { recursive: true });

  // Operator context rides along into every run (idempotent).
  try {
    copyFileSync(join(cfg.agentDir, "AGENTS.md"), join(opts.workdir, "AGENTS.md"));
  } catch {
    console.warn(`[pizza-eagle] no AGENTS.md in AGENT_DIR (${cfg.agentDir}) — running bare`);
  }

  const sessionsDir = `${cfg.stateDir}/sessions`;
  mkdirSync(sessionsDir, { recursive: true });

  const args = piArgs(cfg, opts);

  const started = Date.now();
  const child = spawn(cfg.piBin, args, {
    cwd: opts.workdir,
    env: process.env,
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
    appendHistory(opts.workdir, opts.question, "(timed out)", opts.requester);
    throw new InvestigationError(
      `Investigation exceeded ${Math.round(cfg.timeoutMs / 60_000)} minutes and was stopped.`,
      stderr,
    );
  }
  if (code !== 0 || !answer) {
    appendHistory(opts.workdir, opts.question, answer || "(no output)", opts.requester);
    const tail = stderr.trim().slice(-800);
    throw new InvestigationError(
      `pi exited with code ${code ?? "?"}${signal ? ` (${signal})` : ""}.`,
      tail,
    );
  }

  appendHistory(opts.workdir, opts.question, answer, opts.requester);
  return { answer, durationMs };
}

/**
 * Durable per-thread case file — cheap context even if the session id breaks.
 * The requester's Slack member id rides along so AGENTS.md can gate
 * write-powers (PRs, hotnready publishes) to vetted humans while
 * investigations stay open to the whole workspace.
 */
export function appendHistory(
  workdir: string,
  question: string,
  answer: string,
  requester?: string,
): void {
  const stamp = new Date().toISOString();
  const who = requester ? `\n**Requester:** Slack member \`${requester}\`\n` : "\n";
  appendFileSync(
    `${workdir}/case-history.md`,
    `## ${stamp}\n${who}**Q:** ${question}\n\n${answer}\n\n---\n\n`,
  );
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