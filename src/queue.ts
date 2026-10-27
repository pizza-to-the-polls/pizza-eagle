/**
 * Run queue — global concurrency cap + strict per-key serialization.
 *
 * Red team 2026-10-27, finding 4: the old global FIFO let two mentions in
 * the SAME thread run concurrently. They share one case workdir
 * (case-history.md, thread-context.md) and one pi session, so overlapping
 * runs raced the session files — and a second request could become the
 * "newest requester" a still-running investigation had been told to trust.
 * One case = at most one in-flight run; the global cap still applies across
 * cases, and the waiting-room cap keeps a burst from stacking unbounded
 * promises in memory.
 */

/** Thrown when the waiting room is full — the caller should refuse politely. */
export class QueueFullError extends Error {}

export class RunQueue {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly perKey = new Map<string, Promise<unknown>>();

  constructor(
    private readonly max: number,
    private readonly maxWaiting = 32,
  ) {}

  private acquire(): Promise<void> {
    // Fast path only when nobody is waiting — otherwise arrivals could
    // jump the queue and over-book the cap.
    if (this.active < this.max && this.waiters.length === 0) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxWaiting) {
      throw new QueueFullError(
        `investigation queue is full (${this.waiters.length} waiting)`,
      );
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    }).then(() => {
      this.active++;
    });
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  /**
   * Run `job`, serialized against every other run with the same `key`
   * (one Slack thread = one case), under the global concurrency cap.
   * Rejections from `job` propagate to the caller; a failed job never
   * poisons its key — the next run for that key starts normally.
   */
  async run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.perKey.get(key) ?? Promise.resolve();
    const chained = prev.then(() =>
      (async () => {
        await this.acquire();
        try {
          return await job();
        } finally {
          this.release();
        }
      })(),
    );
    // Swallow rejection for chaining purposes only — the caller still
    // gets the real result (or rejection) from `chained` below.
    const tail = chained.catch(() => {});
    this.perKey.set(key, tail);
    try {
      return await chained;
    } finally {
      if (this.perKey.get(key) === tail) this.perKey.delete(key);
    }
  }
}