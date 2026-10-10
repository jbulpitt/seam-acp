import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";

afterEach(() => vi.useRealTimers());

describe("Google Chat shared space writes", () => {
  it("shares a one-per-second create/patch/delete lane across threads, but not spaces", async () => {
    const { SpaceWriteQueue } = await import("../packages/core/src/platforms/google-chat/write-queue.js");
    vi.useFakeTimers(); vi.setSystemTime(0);
    const queue = new SpaceWriteQueue({ logger: pino({ level: "silent" }), intervalMs: 1000 });
    const seen: [string, number][] = [];
    const write = (name: string) => async () => { seen.push([name, Date.now()]); return name; };
    const jobs = [queue.enqueue("spaces/A", write("create thread 1")), queue.enqueue("spaces/A", write("patch thread 2"), "edit"),
      queue.enqueue("spaces/A", write("delete")), queue.enqueue("spaces/B", write("other space"))];
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([["create thread 1", 0], ["other space", 0]]);
    await vi.advanceTimersByTimeAsync(2000); await Promise.all(jobs);
    expect(seen.slice(2)).toEqual([["patch thread 2", 1000], ["delete", 2000]]);
  });

  it("coalesces pending status edits to the latest state, resolves every waiter, and never drops creates", async () => {
    const { SpaceWriteQueue } = await import("../packages/core/src/platforms/google-chat/write-queue.js");
    vi.useFakeTimers(); vi.setSystemTime(0);
    const queue = new SpaceWriteQueue({ logger: pino({ level: "silent" }), intervalMs: 1000 });
    const seen: string[] = [];
    const write = (s: string) => async () => { seen.push(s); };
    const jobs = [queue.enqueue("A", write("create1")), queue.enqueue("A", write("Working"), "status1"),
      queue.enqueue("A", write("create2")), queue.enqueue("A", write("Done"), "status1")];
    await vi.advanceTimersByTimeAsync(2000); await Promise.all(jobs);
    expect(seen).toEqual(["create1", "Done", "create2"]);
  });

  it("retries a 429 without dropping the create, while a permanent failure preserves its cause", async () => {
    const { SpaceWriteQueue } = await import("../packages/core/src/platforms/google-chat/write-queue.js");
    vi.useFakeTimers(); vi.setSystemTime(0);
    const queue = new SpaceWriteQueue({ logger: pino({ level: "silent" }), intervalMs: 1000 });
    const run = vi.fn().mockRejectedValueOnce({ response: { status: 429 } }).mockResolvedValue("posted");
    const job = queue.enqueue("A", run);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await job).toBe("posted"); expect(run).toHaveBeenCalledTimes(2);
    const cause = Object.assign(new Error("unknown space"), { response: { status: 404 } });
    const failed = expect(queue.enqueue("A", async () => { throw cause; })).rejects.toBe(cause);
    await vi.advanceTimersByTimeAsync(2000); await failed;
  });
});
