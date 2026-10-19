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
 * Credential boundary: this process runs as the `ptp-bot` OS user with
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

export async function runInvestigation(
  cfg: Config,
  opts: { question: string; sessionId: string; workdir: string },
): Promise<InvestigationResult> {
  mkdirSync(opts.workdir, { recursive: true });

  // Operator context rides along into every run (idempotent).
  try {
    copyFileSync(join(cfg.agentDir, "AGENTS.md"), join(opts.workdir, "AGENTS.md"));
  } catch {
    console.warn(`[ptp-bot] no AGENTS.md in AGENT_DIR (${cfg.agentDir}) — running bare`);
  }

  const sessionsDir = `${cfg.stateDir}/sessions`;
  mkdirSync(sessionsDir, { recursive: true });

  const args = [
    "--print",
    "--session-id", opts.sessionId,
    "--session-dir", sessionsDir,
    "--approve", // workdir contains only bot-written context files
    opts.question,
  ];

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
  const durationMs = Date.now() - started;
  const answer = stdout.trim();

  if (timedOut) {
    appendHistory(opts.workdir, opts.question, "(timed out)");
    throw new InvestigationError(
      `Investigation exceeded ${Math.round(cfg.timeoutMs / 60_000)} minutes and was stopped.`,
      stderr,
    );
  }
  if (code !== 0 || !answer) {
    appendHistory(opts.workdir, opts.question, answer || "(no output)");
    const tail = stderr.trim().slice(-800);
    throw new InvestigationError(
      `pi exited with code ${code ?? "?"}${signal ? ` (${signal})` : ""}.`,
      tail,
    );
  }

  appendHistory(opts.workdir, opts.question, answer);
  return { answer, durationMs };
}

/** Durable per-thread case file — cheap context even if the session id breaks. */
function appendHistory(workdir: string, question: string, answer: string): void {
  const stamp = new Date().toISOString();
  appendFileSync(
    `${workdir}/case-history.md`,
    `## ${stamp}\n\n**Q:** ${question}\n\n${answer}\n\n---\n\n`,
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