/**
 * Thread → session map. Durable, tiny, one JSON file.
 *
 * Each Slack thread gets one pi session ID and one workdir
 * (AGENTS.md operator context + case-history.md). Follow-up
 * @mentions in the same thread resume the same pi session
 * (`pi --session-id <id>` creates if missing), so context carries.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ThreadRecord {
  /** pi session id, stable for the life of the thread */
  sessionId: string;
  channel: string;
  workdir: string;
  questionCount: number;
  lastRunAt: string;
  lastAnswer: string | null;
  /** Slack `ts` of the current 🔎 status message — lets a restart requeue edit it. */
  statusTs?: string;
  /**
   * Question text of the run currently executing (issue #68). Set when a run
   * starts, CLEARED when it finishes — success or terminal failure (both
   * inform the user). A record still carrying it after a listener restart is
   * a run that died mid-flight and gets requeued exactly once.
   */
  lastQuestion?: string;
  /** Slack user id of the most recent requester (for restart requeue). */
  lastRequester?: string;
  /** Slack-resolved display name of the most recent requester. */
  lastRequesterName?: string;
  /** True while an investigation for this thread is running. */
  inFlight?: boolean;
}

/**
 * Should a listener restart requeue this record's interrupted run? (issue #68)
 *
 * True only when a run was in flight AND never completed: `lastQuestion` is
 * cleared on every completion (success posts the answer; terminal failure
 * posts the cause + retry offer), so a record that still carries it died
 * mid-run. A record that completed but crashed before its `finally` cleared
 * `inFlight` dedupes out here — its answer was already posted.
 */
export function needsRestartRequeue(r: ThreadRecord): boolean {
  return Boolean(r.inFlight) && Boolean(r.lastQuestion);
}

export class ThreadStore {
  private readonly file: string;
  private data: Record<string, ThreadRecord>;

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        // A corrupt threads.json shouldn't take the listener down — start
        // fresh; the pi session files under state/work still carry context.
        console.warn(`[pizza-eagle] ${file} unreadable (${(e as Error).message}) — starting empty`);
        this.data = {};
      }
    } else {
      this.data = {};
    }
  }

  get(threadTs: string): ThreadRecord | undefined {
    return this.data[threadTs];
  }

  /** All records currently marked in-flight — the restart-requeue scan. */
  getInFlight(): Array<[string, ThreadRecord]> {
    return Object.entries(this.data).filter(([, r]) => Boolean(r.inFlight));
  }

  put(threadTs: string, record: ThreadRecord): void {
    this.data[threadTs] = record;
    this.flush();
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file); // atomic
  }
}

/** Slack thread_ts values look like "1234567890.123456" — safe as a dir name. */
export function sanitizeForPath(threadTs: string): string {
  return threadTs.replace(/[^0-9.]/g, "").replace(/\./g, "_");
}

export function workdirFor(stateDir: string, threadTs: string): string {
  return join(stateDir, "work", sanitizeForPath(threadTs));
}