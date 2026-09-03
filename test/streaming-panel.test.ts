import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingPanel } from "../packages/core/src/core/streaming-panel.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A promise plus its resolver — the test, not the scheduler, decides when. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Record every render (text snapshot + done flag) the panel issues. */
function recorder() {
  const renders: Array<{ text: string; done: boolean }> = [];
  const render = async (text: string, done: boolean) => {
    renders.push({ text, done });
  };
  return { renders, render };
}

describe("StreamingPanel", () => {
  it("renders the first chunk immediately and finalizes with done=true", async () => {
    const { renders, render } = recorder();
    const p = new StreamingPanel(render, 20);

    p.append("hello");
    // The first chunk always lands an edit immediately (queued this tick).
    await tick(0);
    expect(renders.length).toBe(1);
    expect(renders[0]).toEqual({ text: "hello", done: false });

    await p.finalize();
    // Terminal render with the full text and done=true.
    const last = renders[renders.length - 1]!;
    expect(last.done).toBe(true);
    expect(last.text).toBe("hello");
    // The panel was edited more than once (progressive + terminal).
    expect(p.renderCount).toBeGreaterThan(1);
  });

  it("accumulates the full text losslessly regardless of throttling", async () => {
    const { render } = recorder();
    const p = new StreamingPanel(render, 50);
    for (const c of ["a", "b", "c", "d", "e"]) p.append(c);
    await p.finalize();
    expect(p.text).toBe("abcde");
  });

  /**
   * The serialization guarantee, driven by an explicit gate instead of a clock.
   *
   * This previously used a 5ms debounce plus `await tick(0)` and asserted an
   * exact render transcript — which encodes a render COUNT, not an ordering.
   * That left a ~2ms margin: when a loaded scheduler let `setTimeout(…, 0)` run
   * past 5ms, the second append legitimately took the immediate branch, emitted
   * one extra (correctly ordered) progressive render, and the assertion failed.
   * Measured at 27/40 failures under CPU load and 0/20 idle — noise on the test
   * guarding a real hazard, which is the worst kind (#172).
   *
   * Now the first render parks on a promise only this test can resolve, so
   * "a later render was queued while an earlier slow one was still in flight"
   * is CONSTRUCTED rather than hoped for, and the assertions are the invariants
   * the title actually claims: no overlap, no reordering, monotonic snapshots,
   * terminal render last. How many progressive renders happen along the way is
   * a throttling question, covered separately below under fake timers.
   */
  it("serializes renders so a slow edit is never overtaken", async () => {
    const order: string[] = [];
    const snapshots: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let rendersStarted = 0;

    const firstStarted = deferred();
    const releaseFirst = deferred();

    const p = new StreamingPanel(async (text, done) => {
      // Never assert in here: a progressive render is enqueued with `void`
      // (streaming-panel.ts `append`), so a throw would be swallowed and the
      // test would pass vacuously. Record, and assert after finalize.
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      rendersStarted += 1;
      order.push(`start:${text}`);
      snapshots.push(text);
      if (rendersStarted === 1) {
        firstStarted.resolve();
        await releaseFirst.promise; // held open until this test says so
      }
      order.push(`${done ? "done" : "end"}:${text}`);
      inFlight -= 1;
    }, 5);

    p.append("one");
    await firstStarted.promise; // render #1 is provably running and parked

    p.append("two");
    // `finalize` enqueues its terminal render synchronously, before its first
    // await — so the queue now holds a render behind the parked one.
    const finalized = p.finalize();

    // Nothing may have run while render #1 holds the queue. This is the
    // "never overtaken" property itself, and it makes the test non-vacuous:
    // a panel that failed to serialize would already show a second render.
    expect(order).toEqual(["start:one"]);

    releaseFirst.resolve();
    await finalized;

    // 1. No two renders were ever in flight at once.
    expect(maxInFlight).toBe(1);

    // 2. Every render ran to completion before the next one started.
    for (let i = 0; i < order.length; i += 2) {
      const open = order[i]!;
      expect(open.startsWith("start:"), `expected a start at ${i}: ${open}`).toBe(true);
      const body = open.slice("start:".length);
      expect(order[i + 1], `render "${body}" was interleaved`).toMatch(
        new RegExp(`^(end|done):${body}$`)
      );
    }

    // 3. Snapshots never went backwards — no stale text landed after newer text.
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i]!.startsWith(snapshots[i - 1]!), `${snapshots[i - 1]} -> ${snapshots[i]}`).toBe(true);
    }

    // 4. The terminal render ran last, after the slow one, with the full text.
    expect(order[order.length - 1]).toBe("done:onetwo");
    expect(order.indexOf("done:onetwo")).toBeGreaterThan(order.indexOf("end:one"));
    expect(snapshots[snapshots.length - 1]).toBe("onetwo");
    expect(p.text).toBe("onetwo");
  });

  /**
   * Throttling, with both `setTimeout` AND `Date.now()` under the test's
   * control — the panel reads the clock directly (`append` compares
   * `Date.now() - lastEditAt` against the debounce), so faking only timers
   * would leave the branch decision on the wall clock and the flake intact.
   *
   * The system time is set to a real epoch rather than 0 on purpose: the panel
   * seeds `lastEditAt = 0` as its "never edited" sentinel, so at a mocked
   * time of 0 the very first chunk would fall into the debounce branch instead
   * of rendering immediately, and the test would be exercising behaviour that
   * cannot occur in production.
   */
  describe("debounce and coalescing (fake timers)", () => {
    const START = Date.UTC(2026, 0, 1);
    const DEBOUNCE = 1_000;

    afterEach(() => vi.useRealTimers());

    it("coalesces a burst into one trailing edit once the window elapses", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(START);
      const { renders, render } = recorder();
      const p = new StreamingPanel(render, DEBOUNCE);

      // First chunk always edits immediately.
      p.append("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(renders.map((r) => r.text)).toEqual(["a"]);

      // Two more chunks inside the window: coalesced, not rendered.
      await vi.advanceTimersByTimeAsync(100);
      p.append("b");
      await vi.advanceTimersByTimeAsync(100);
      p.append("c");
      expect(renders.map((r) => r.text)).toEqual(["a"]);

      // Still inside the window. The trailing edit was armed at START + 100
      // for the remaining 900ms, so it is due at START + 1000; the clock is
      // at START + 200, and this lands it one millisecond short.
      await vi.advanceTimersByTimeAsync(799);
      expect(renders.map((r) => r.text)).toEqual(["a"]);

      // Window elapses: exactly ONE trailing edit, carrying both chunks.
      await vi.advanceTimersByTimeAsync(1);
      expect(renders.map((r) => r.text)).toEqual(["a", "abc"]);
      expect(renders.every((r) => r.done === false)).toBe(true);

      // Three appends produced two edits — the point of the throttle.
      expect(p.renderCount).toBe(2);
      expect(p.text).toBe("abc");
    });

    it("edits again immediately once the window has already elapsed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(START);
      const { renders, render } = recorder();
      const p = new StreamingPanel(render, DEBOUNCE);

      p.append("a");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      p.append("b"); // due now — no trailing timer needed
      await vi.advanceTimersByTimeAsync(0);

      expect(renders.map((r) => r.text)).toEqual(["a", "ab"]);
    });

    it("finalize cancels the pending trailing edit and coalesces it into the terminal render", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(START);
      const { renders, render } = recorder();
      const p = new StreamingPanel(render, DEBOUNCE);

      p.append("one");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      p.append("two"); // inside the window → a trailing edit is armed

      await p.finalize();
      expect(renders).toEqual([
        { text: "one", done: false },
        { text: "onetwo", done: true },
      ]);

      // The cancelled timer must never fire, however long we wait.
      await vi.advanceTimersByTimeAsync(10 * DEBOUNCE);
      expect(renders.length).toBe(2);
    });
  });

  it("ignores appends after finalize and stays idempotent", async () => {
    const { renders, render } = recorder();
    const p = new StreamingPanel(render, 20);
    p.append("done-body");
    await p.finalize();
    const countAfterFinalize = renders.length;

    p.append(" IGNORED");
    await p.finalize(); // second finalize is a no-op edit-wise
    await tick(30);

    expect(p.text).toBe("done-body");
    expect(renders.length).toBe(countAfterFinalize);
  });
});
