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
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config.js";
import { writeCasebookDigest } from "./casebook.js";

export interface InvestigationResult {
  answer: string;
  durationMs: number;
}

export class InvestigationError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    /** Wall-clock run duration — feeds the usage ledger's answer event. */
    public readonly durationMs?: number,
    /** How the run ended (issue #67): timeout / error / killed by signal. */
    public readonly outcome?: "timeout" | "error" | "killed",
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
  // pi's env-keyed model credential (or-pizza provider — see pi-config).
  // BOTH names, whichever the environment provides: the box's pi-config
  // secret + .env key the provider as OPENROUTER_KEY_EAGLE, while laptop/dev
  // pi configs use OPENROUTER_KEY_PIZZA. Forwarding only one name silently
  // starved pi of its key (2026-10-29 #dev: "No API key found for the
  // selected model" from every box investigation after PR #27's allowlist).
  "OPENROUTER_KEY_EAGLE",
  "OPENROUTER_KEY_PIZZA",
  // investigation data sources / helpers
  "GA_PROPERTY_ID", // ga.mjs default property
  "ZAPIER_MCP_URL", // zapier harness MCP endpoint
  "GH_APP_ID", // gh-token.mjs — the listener injects it from .env (its header)
  "GITHUB_ALLOWED_REPOS", // gh-token.mjs mint allowlist — .env carries zapier; without
  // this the sandbox fell back to the script's 4-repo default and refused
  // pizza-to-the-polls/zapier mints (2026-11-12 #dev: Pizza Eagle reported
  // "the token gate refuses the zapier repo" — the allowlist was widened in
  // .env but never reached the dropped child)
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
  // Per-run model override (issue #34): forwarded only when set, so an
  // unset knob leaves pi's settings.json default untouched. The value
  // rides in as PI_MODEL; the wrapper turns it into pi's `--model` flag.
  if (cfg.piModel) out.PI_MODEL = cfg.piModel;
  return out;
}

/**
 * Per-run repair of the case workdir's session surface (2026-10-31
 * post-mortem, issue #54). The session id is stable per Slack thread, so
 * every follow-up RESUMES the same <workdir>/sessions/<file> — and every
 * file written before the uid boundary landed (the 2026-10-27…31 mode-3
 * era: pi ran as THIS listener user) is pizza-eagle-owned 0644. The
 * isolated child (pizza-eagle-inv) then got EACCES appending it, so EVERY
 * pre-isolation thread failed on its next reply while new threads kept
 * working. Repair, as the listener (owner of the legacy files):
 *   - sessions dir 2770: the setgid bit pins files created by EITHER uid
 *     to group pizza-eagle (bootstrap.sh puts pizza-eagle-inv in it), so
 *     resume-context keeps working across the boundary;
 *   - existing *.jsonl: add group rw (0644 → 0664) so the child can append.
 * Best-effort by design: files owned by other uids (inv-created, or
 * root-created by SSM verification runs) cannot be chmod'd here — those
 * are appendable by their owner; RUNBOOK.md carries the root-side
 * one-liner for the rest. The wrapper (run-investigation-container.sh)
 * mirrors both operations as defense in depth.
 */
export function ensureCaseWorkdirPerms(workdir: string): void {
  const sessions = join(workdir, "sessions");
  mkdirSync(sessions, { recursive: true });
  try {
    chmodSync(sessions, 0o2770);
  } catch {
    // Not our dir (root-owned) — RUNBOOK.md root-side repair.
  }
  for (const f of readdirSync(sessions)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(sessions, f);
    try {
      chmodSync(p, statSync(p).mode | 0o660); // add group rw, keep the rest
    } catch {
      // Owned by another uid — its owner can append it already.
    }
  }
}

export async function runInvestigation(
  cfg: Config,
  opts: {
    question: string;
    sessionId: string;
    workdir: string;
    requester?: string;
    requesterName?: string;
    writeAllowed?: boolean;
  },
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
  // Session-surface repair (issue #54): the isolated child RESUMES the
  // thread's session file — legacy listener-owned 0644 files must be
  // re-opened for it or every pre-isolation thread fails on its next reply.
  ensureCaseWorkdirPerms(workdir);

  // Listener-owned per-run authorization record (see writeRequestAuth):
  // written BEFORE the run so the operator prompt and the helper scripts
  // gate on Slack-authenticated identity, never on question text.
  writeRequestAuth(workdir, {
    requester: opts.requester,
    requesterName: opts.requesterName,
    writeAllowed: opts.writeAllowed,
  });

  // Operator context rides along into every run (idempotent).
  try {
    copyFileSync(join(cfg.agentDir, "AGENTS.md"), join(workdir, "AGENTS.md"));
  } catch {
    console.warn(`[pizza-eagle] no AGENTS.md in AGENT_DIR (${cfg.agentDir}) — running bare`);
  }

  // Casebook digest (fleet-dreaming phase 1): the agent's only cross-case
  // memory — recent questions + verdict excerpts. Listener-written here,
  // like AGENTS.md above, because the isolation boundary blocks the
  // worker from state/ (where the raw casebook shards live) entirely.
  // Idempotent overwrite: every run (incl. retries) sees the latest tail.
  writeCasebookDigest(cfg.stateDir, workdir);

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
    tryHistory(() => appendHistory(workdir, opts.question, "(timed out)", opts.requester, opts.requesterName));
    throw new InvestigationError(
      `Investigation exceeded ${Math.round(cfg.timeoutMs / 60_000)} minutes and was stopped.`,
      stderr,
      durationMs,
      "timeout",
    );
  }
  if (code !== 0 || !answer) {
    tryHistory(() => appendHistory(workdir, opts.question, answer || "(no output)", opts.requester, opts.requesterName));
    const tail = stderr.trim().slice(-800);
    throw new InvestigationError(
      `pi exited with code ${code ?? "?"}${signal ? ` (${signal})` : ""}.`,
      tail,
      durationMs,
      // A non-null signal means the wrapper died by signal (spawn 'error'
      // yields [null, null] — reported as "code ?" below) — call it killed,
      // everything else is an ordinary error.
      signal ? "killed" : "error",
    );
  }

  tryHistory(() => appendHistory(workdir, opts.question, answer, opts.requester, opts.requesterName));
  return { answer, durationMs };
}

/** Default pause between attempt 1's failure and the auto-retry. */
export const RETRY_BACKOFF_MS = 2_000;

export interface RetryOptions {
  /**
   * Called between the first failure and the retry — the listener updates
   * the Slack status ("first attempt failed (…) — retrying…") here.
   */
  onRetry?: (error: InvestigationError) => Promise<void> | void;
  /**
   * Last-word gate on whether to retry. Index.ts returns `!shuttingDown` so a
   * SIGTERM'd run (killed by our own restart) does not spawn a doomed second
   * attempt during the 2s shutdown window.
   */
  shouldRetry?: () => boolean;
  /** Backoff override (tests). */
  backoffMs?: number;
}

/**
 * Auto-retry a failed run ONCE, in the same session/workdir (issue #68).
 *
 * v1's ~11% transient failure rate (model API 429s, network blips) surfaced
 * as terminal bare ❌s. Transient causes usually resolve on a second
 * attempt, so a non-timeout InvestigationError gets exactly one retry with a
 * short backoff, reusing the identical run arguments (same pi session, same
 * case workdir — the retry is a continuation, not a new case).
 *
 * Timeouts are EXCLUDED: runInvestigation's wall-clock budget is per
 * attempt, and a run that consumed all of it would need the same budget
 * again for the same investigative scope — retrying just doubles the wait
 * before the same failure. The user still gets the terminal message + retry
 * offer.
 *
 * Only InvestigationError retries: validation/permission throws from
 * runInvestigation's setup are deterministic — a second attempt fails the
 * same way, so they surface immediately.
 */
export async function runWithRetry(
  cfg: Config,
  opts: {
    question: string;
    sessionId: string;
    workdir: string;
    requester?: string;
    requesterName?: string;
    writeAllowed?: boolean;
  },
  retry?: RetryOptions,
): Promise<InvestigationResult> {
  try {
    return await runInvestigation(cfg, opts);
  } catch (e) {
    const retriable =
      e instanceof InvestigationError &&
      e.outcome !== "timeout" &&
      (retry?.shouldRetry?.() ?? true);
    if (!retriable) throw e;
    const first = e as InvestigationError;
    await retry?.onRetry?.(first);
    await new Promise((r) => setTimeout(r, retry?.backoffMs ?? RETRY_BACKOFF_MS));
    return await runInvestigation(cfg, opts);
  }
}

/**
 * One-line human cause for the terminal-failure status edit (issue #68).
 *
 * runInvestigation's own message ("pi exited with code 1.") is rarely the
 * cause — the stderr tail usually carries it ("model API error: 429"). Take
 * the LAST error-ish stderr line: pi and its tools print the fatal one last.
 * Stripped of backticks/asterisks (Slack mrkdwn safety) and capped at 140
 * chars so the status edit stays one line.
 */
export function oneLinerCause(e: unknown): string {
  const clean = (s: string) =>
    s.replace(/[`*]/g, "").replace(/\s+/g, " ").trim().slice(0, 140) || "unknown error";
  if (e instanceof InvestigationError) {
    if (e.outcome === "timeout") return clean(e.message);
    if (e.outcome === "killed") return "investigation process was killed";
    const causeLine = e.stderr
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .reverse()
      .find((l) => /error|failed|429|rate.?limit|too many requests|unreachable|ECONN|ETIMEDOUT/i.test(l));
    return clean(causeLine ?? e.message);
  }
  return clean(`unexpected error: ${(e as Error)?.message ?? String(e)}`);
}

/**
 * Machine-readable per-run authorization, written by the LISTENER from
 * the Slack event's authenticated user metadata before each pi run.
 *
 * This is the ONLY requester signal the operator prompt and the helper
 * scripts (gh-token.mjs, publish-hotnready.sh) trust. The old scheme —
 * a `**Requester:**` line in the newest case-history.md entry — was
 * forgeable, because the question text lands in that same file and a
 * question can carry its own `---` + header + requester line (red team
 * 2026-10-27, finding 4: verified, and undetected by the suspicion
 * rules). case-history.md Requester lines stay as transcript; they are
 * no longer auth — and since issue #66 the worker no longer writes to
 * the file at all (the listener appends post-run), so request metadata
 * in it is structurally listener-only.
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
  auth: { requester?: string; requesterName?: string; writeAllowed?: boolean },
): void {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(
    join(workdir, "request-auth.json"),
    JSON.stringify(
      {
        requester: auth.requester ?? null,
        // Slack-resolved display name (users.info via the bot token, issue
        // #69). The ONLY authoritative name: AGENTS.md prose mappings are
        // decoration and must never be used to label a requester.
        requesterName: auth.requesterName ?? null,
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
 * The requester's Slack member id rides along so the transcript records who
 * asked, while investigations stay open to the whole workspace.
 *
 * Written entirely by the LISTENER after the run completes (issue #66): the
 * isolated worker has no write access to case-history.md at all, so request
 * metadata (timestamp, requester, question) is structurally separated from
 * anything the worker could forge, and the worker can never hit the
 * listener-owned file's permission wall mid-run. Best-effort via tryHistory.
 */
export function appendHistory(
  workdir: string,
  question: string,
  answer: string,
  requester?: string,
  requesterName?: string,
): void {
  const stamp = new Date().toISOString();
  const namePart = requesterName ? ` (${requesterName})` : "";
  const who = requester
    ? `\n**Requester:** Slack member \`${requester}\`${namePart}\n`
    : "\n";
  appendFileSync(
    `${workdir}/case-history.md`,
    `## ${stamp}${who}**Q:** ${question}\n\n${answer}\n\n---\n\n`,
  );
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