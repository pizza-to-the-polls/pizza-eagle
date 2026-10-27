import test from "node:test";
import assert from "node:assert/strict";
import { RunQueue, QueueFullError } from "../src/queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("RunQueue: same key never overlaps — one thread = one in-flight case", async () => {
  // Red team 2026-10-27 finding 4: two mentions in one Slack thread used to
  // run concurrently against the same workdir + session.
  const q = new RunQueue(4);
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const job = (id: string) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`start-${id}`);
    await sleep(15);
    order.push(`end-${id}`);
    active--;
  };
  await Promise.allSettled([
    q.run("p1234.0001", job("a")),
    q.run("p1234.0001", job("b")),
    q.run("p1234.0001", job("c")),
  ]);
  assert.equal(maxActive, 1, "same-key jobs must serialize");
  assert.deepEqual(order, [
    "start-a", "end-a",
    "start-b", "end-b",
    "start-c", "end-c",
  ]);
});

test("RunQueue: different keys run concurrently up to the global cap", async () => {
  const q = new RunQueue(2);
  let active = 0;
  let maxActive = 0;
  const job = () => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(15);
    active--;
  };
  await Promise.allSettled([
    q.run("a", job()),
    q.run("b", job()),
    q.run("c", job()),
  ]);
  assert.equal(maxActive, 2, "global cap applies across cases");
});

test("RunQueue: waiting-room cap rejects bursts with QueueFullError; later runs recover", async () => {
  const q = new RunQueue(1, 1);
  const results = await Promise.allSettled([
    q.run("a", async () => {
      await sleep(30);
      return "a";
    }),
    q.run("b", async () => "b"), // waits behind a — allowed (room for 1)
    q.run("c", async () => "c"), // waiting room full — rejected
    q.run("a", async () => "a2"), // queued behind key a — must still work
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[2].status, "rejected");
  assert.ok(
    results[2].reason instanceof QueueFullError,
    "burst rejection is QueueFullError",
  );
  assert.equal(results[3].status, "fulfilled", "queue recovers after a burst rejection");
  assert.equal((results[3] as PromiseFulfilledResult<string>).value, "a2");
});

test("RunQueue: a failed job never poisons its key", async () => {
  const q = new RunQueue(2);
  await assert.rejects(
    q.run("k", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const seen: string[] = [];
  await q.run("k", async () => {
    seen.push("after");
  });
  assert.deepEqual(seen, ["after"]);
});

test("RunQueue: rejections still release their concurrency slot", async () => {
  const q = new RunQueue(1, 2);
  const blowUp = async () => {
    await sleep(10);
    throw new Error("nope");
  };
  await Promise.allSettled([
    q.run("x", blowUp),
    q.run("x", blowUp),
    q.run("y", async () => "ok"),
  ]);
  // If failed jobs leaked their slot, "ok" would deadlock; a 5s test timeout
  // (node:test default) makes a leak show up as a hang/failure.
  const ok = await q.run("y", async () => "ok2");
  assert.equal(ok, "ok2");
});