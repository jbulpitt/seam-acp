import { describe, expect, it } from "vitest";
import { SerialQueue } from "../packages/core/src/core/serial-queue.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("SerialQueue", () => {
  it("runs tasks in FIFO order even when earlier tasks take longer", async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const p1 = q.run(async () => {
      await tick(20);
      order.push(1);
    });
    const p2 = q.run(async () => {
      await tick(5);
      order.push(2);
    });
    const p3 = q.run(() => {
      order.push(3);
    });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("returns each task's own result to its caller", async () => {
    const q = new SerialQueue();
    const [a, b] = await Promise.all([
      q.run(async () => {
        await tick(10);
        return "a";
      }),
      q.run(() => "b"),
    ]);
    expect([a, b]).toEqual(["a", "b"]);
  });

  it("does not let a rejecting task poison the queue", async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    const failing = q.run(async () => {
      throw new Error("boom");
    });
    const after = q.run(() => {
      order.push("after");
      return "ok";
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
    expect(order).toEqual(["after"]);
  });

  it("idle() resolves only after all queued work settles", async () => {
    const q = new SerialQueue();
    let done = false;
    q.run(async () => {
      await tick(15);
      done = true;
    });
    await q.idle();
    expect(done).toBe(true);
  });

  // --- Regression: the seam-acp streaming reorder bug. -----------------------
  // The ACP SDK dispatches session-update notifications concurrently (its read
  // loop calls the handler without awaiting it), so a later chunk's handler can
  // run while an earlier one is parked on an await — e.g. a chunk whose first
  // segment is a code-fence send, with trailing prose right after it — and
  // append its text to the shared buffer FIRST. That is exactly how a paragraph
  // rendered out of order (a middle clause jumped ahead of the opening one).

  it("reproduces the unserialized append reorder (control — documents the bug)", async () => {
    let buffer = "";
    // Chunk whose prose append is gated behind an await (the fence-close send).
    const sendFenceThenAppend = async (s: string) => {
      await tick(10);
      buffer += s;
    };
    // A plain prose chunk appends immediately.
    const appendProse = async (s: string) => {
      buffer += s;
    };
    // Concurrent dispatch: the second handler is NOT awaited after the first.
    await Promise.all([sendFenceThenAppend("A"), appendProse("B")]);
    // "B" overtakes the parked "A" → scrambled. This is the failure mode.
    expect(buffer).toBe("BA");
  });

  it("serializing the same handlers restores arrival order (the fix)", async () => {
    const q = new SerialQueue();
    let buffer = "";
    const sendFenceThenAppend = async (s: string) => {
      await tick(10);
      buffer += s;
    };
    const appendProse = async (s: string) => {
      buffer += s;
    };
    // Same concurrent dispatch, but funnelled through the queue.
    await Promise.all([
      q.run(() => sendFenceThenAppend("A")),
      q.run(() => appendProse("B")),
    ]);
    expect(buffer).toBe("AB");
  });
});
