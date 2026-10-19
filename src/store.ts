/**
 * Thread → session map. Durable, tiny, one JSON file.
 *
 * Each Slack thread gets one pi session ID and one workdir
 * (AGENTS.md operator context + case-history.md). Follow-up
 * @mentions in the same thread resume the same pi session
 * (`pi --session-id <id>` creates if missing), so context carries.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ThreadRecord {
  /** pi session id, stable for the life of the thread */
  sessionId: string;
  channel: string;
  workdir: string;
  questionCount: number;
  lastRunAt: string;
  lastAnswer: string | null;
}

export class ThreadStore {
  private readonly file: string;
  private data: Record<string, ThreadRecord>;

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      this.data = JSON.parse(readFileSync(file, "utf8"));
    } else {
      this.data = {};
    }
  }

  get(threadTs: string): ThreadRecord | undefined {
    return this.data[threadTs];
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