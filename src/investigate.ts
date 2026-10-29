/**
 * The investigation runner: one ISOLATED pi run per question (issue #5).
 *
 *   spawn(invWrapper, [workdir, sessionId, question])
 *     └─ scripts/run-investigation-container.sh
 *          └─ sudo -u pizza-eagle-inv podman run … pi --print …
 *
 * The pi child NO LONGER inherits the listener's OS user. The wrapper drops
 * to `pizza-eagle-inv` and (on the box) runs pi inside a rootless Podman
 * container — a prompt-injected investigation cannot read the listener's
 * /proc/<pid>/environ (different PID namespace + UID), ptrace/signal the
 * listener, or read state/ files outside its own case workdir. See the
 * wrapper header and RUNBOOK for the full boundary and its limits.
 *
 * Why a subprocess at all (unchanged since PR #3): a crashed/hung run can
 * never take down the listener, and each run gets a clean tool environment.
 * The session id is stable per Slack thread, so follow-ups resume context.
 * Sessions now live INSIDE the case workdir (<workdir>/sessions) — the only
 * host path the container can write — not under state/sessions.
 *
 * Credential boundary: this listener passes the wrapper an explicit
 * env ALLOWLIST (wrapperEnv below); Slack tokens are structurally absent.
 * Everything the run needs from the listener user's HOME (pi config, GA/
 * Bugsnag readonly creds) is staged per-run by the wrapper, never copied
 * into the workdir.
 */

import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
 * The question rides as the wrapper's argv[3] (its LAST argument — the
 * wrapper passes it to pi after `--`, end-of-options, so a question that
 * starts with "-" — Slack users write "<@Pizza Eagle> - question" — is not
 * parsed as a flag; 2026-10-26 #dev thread). argv, not stdin: the wrapper
 * validates it once and every isolation mode forwards it identically.
 *
 * The 32k cap is argv practicality (single exec argument, wrapper-side
 * check mirrors this one). A question long enough to trip this is abuse,
 * not investigation.
 */
export const MAX_QUESTION_CHARS = 32_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pre-spawn validation. Both values are untrusted: the session id
 * round-trips through state/threads.json, the question is raw Slack text.
 * The wrapper re-validates (defense in depth — it is also a standalone
 * boundary), but these throws happen BEFORE any process exists.
 */
export function validateRunInputs(opts: { question: string; sessionId: string }): void {
  if (!UUID_RE.test(opts.sessionId)) {
    throw new Error(`invalid session id: ${JSON.stringify(opts.sessionId.slice(0, 64))}`);
  }
  if (!opts.question.trim()) {
    throw new Error("empty question");
  }
  if (opts.question.length > MAX_QUESTION_CHARS) {
    throw new Error(`question exceeds ${MAX_QUESTION_CHARS} characters`);
  }
}

/**
 * The wrapper's env: an explicit ALLOWLIST, not a scrub list.
 *
 * The old childEnv() stripped Slack tokens from an inherited env — but the
 * child ran as the SAME OS user, so it could read the listener's own
 * /proc/<pid>/environ anyway; the scrub only protected the child's copy.
 * With the isolation boundary (different UID + PID namespace), the child
 * cannot reach the listener's env at all — so the env we SEND can be
 * minimal, and Slack tokens are absent by construction (an allowlist
 * cannot leak by omission, aliasing, or a future env var nobody
 * remembered to scrub).
 *
 * The wrapper itself forwards only this list (plus HOME/PATH it sets for
 * the dropped user) into every isolation mode.
 */
const WRAPPER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  // pi's env-keyed model credential (or-pizza provider — see pi-config)
  "OPENROUTER_KEY_PIZZA",
  // investigation data sources / helpers
  "GA_PROPERTY_ID", // ga.mjs default property
  "ZAPIER_MCP_URL", // zapier harness MCP endpoint
];

export function wrapperEnv(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const k of WRAPPER_ENV_ALLOWLIST) {
    const v = env[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  // Wrapper knobs from config (they originate in env via loadConfig, but
  // cfg is the single source of truth here).
  out.INV_IMAGE = cfg.invImage;
  out.INV_USER = cfg.invUser;
  out.PI_BIN = cfg.piBin;
  out.PI_AGENT_DIR = cfg.piAgentDir;
  return out;
}

export async function runInvestigation(
  cfg: Config,
  opts: { question: string; sessionId: string; workdir: string; requester?: string; writeAllowed?: boolean },
): Promise<InvestigationResult> {
  validateRunInputs(opts);

  // Absolute by construction. workdirFor() builds the case workdir from
  // cfg.stateDir, which defaults to "./state" (BOT_STATE_DIR unset — the
  // box). The wrapper resolves its <workdir> argv against ITS OWN cwd —
  // which the spawn below sets to the workdir itself — so a relative
  // workdir would fail the wrapper's -d check as
  // "workdir does not exist: state/work/…" (2026-10-29 #dev, two failed
  // investigations on the box after PR #27). Resolve once, use everywhere.
  const workdir = resolve(opts.workdir);

  mkdirSync(workdir, { recursive: true });
  // The case workdir is the exchange surface with the isolated
  // investigation user (member of group pizza-eagle — bootstrap.sh):
  // owner + group get rwx, world gets nothing. pi writes its session files
  // under <workdir>/sessions from inside the boundary.
  chmodSync(workdir, 0o770);

  // Listener-owned per-run authorization record (see writeRequestAuth):
  // written BEFORE the run so the operator prompt and the helper scripts
  // gate on Slack-authenticated identity, never on question text.
  writeRequestAuth(workdir, {
    requester: opts.requester,
    writeAllowed: opts.writeAllowed,
  });

  // Operator context rides along into every run (idempotent).
  try {
    copyFileSync(join(cfg.agentDir, "AGENTS.md"), join(workdir, "AGENTS.md"));
  } catch {
    console.warn(`[pizza-eagle] no AGENTS.md in AGENT_DIR (${cfg.agentDir}) — running bare`);
  }

  // Requester + question land in the case file BEFORE the pi run, so the
  // AGENTS.md write-gate can verify the requester from Slack event metadata
  // even on a thread's FIRST question. (2026-10-25 #dev thread: a publish
  // request rode Q1 and the gate found no entry — entries were previously
  // appended only after each run.) Best-effort: never fail a run over it.
  tryHistory(() => openHistory(workdir, opts.question, opts.requester));

  const started = Date.now();
  // The wrapper owns everything below this point: privilege drop, staging
  // (pi config + triage creds from the listener user's HOME), container
  // lifecycle, and pi's argv (including the `--` question separator). It
  // gets a THREE-argument argv and an allowlisted env — nothing else.
  const child = spawn(cfg.invWrapper, [workdir, opts.sessionId, opts.question], {
    cwd: workdir,
    env: wrapperEnv(cfg),
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
    tryHistory(() => closeHistory(workdir, "(timed out)"));
    throw new InvestigationError(
      `Investigation exceeded ${Math.round(cfg.timeoutMs / 60_000)} minutes and was stopped.`,
      stderr,
    );
  }
  if (code !== 0 || !answer) {
    tryHistory(() => closeHistory(workdir, answer || "(no output)"));
    const tail = stderr.trim().slice(-800);
    throw new InvestigationError(
      `pi exited with code ${code ?? "?"}${signal ? ` (${signal})` : ""}.`,
      tail,
    );
  }

  tryHistory(() => closeHistory(workdir, answer));
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
 * Since the issue #5 boundary the investigation runs as a DIFFERENT OS
 * user (pizza-eagle-inv, containerized) — but the case workdir remains
 * pi-writable by design (it is the run's only workspace), so a tool-level
 * compromise can still tamper with this file mid-run. The durable
 * mitigations are the helper scripts' own enforcement (gh-token.mjs,
 * publish-hotnready.sh re-read and independently act on it) and the usage
 * ledger; the container boundary's job is the LISTENER's env, memory and
 * state — not this file.
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
    // A wrapper that cannot be spawned (missing, not executable) emits only
    // 'error', never 'exit' — without this branch the run would hang forever
    // instead of failing the investigation. The null code is reported as
    // "pi exited with code ?." by the caller.
    child.on("error", () => resolve([null, null]));
  });
}