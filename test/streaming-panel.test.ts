import { describe, expect, it } from "vitest";
import { StreamingPanel } from "../packages/core/src/core/streaming-panel.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

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

  it("throttles bursts into fewer renders than chunks", async () => {
    const { renders, render } = recorder();
    const p = new StreamingPanel(render, 40);
    // Ten chunks in a tight burst — well within one debounce window.
    for (let i = 0; i < 10; i++) p.append(`x${i}`);
    await tick(0);
    await p.finalize();
    // First chunk edits immediately, the rest coalesce; never one-edit-per-chunk.
    expect(renders.length).toBeLessThan(10);
    // The final render still carries the complete text.
    expect(renders[renders.length - 1]!.text).toBe(
      "x0x1x2x3x4x5x6x7x8x9"
    );
  });

  it("serializes renders so a slow edit is never overtaken", async () => {
    const order: string[] = [];
    const p = new StreamingPanel(async (text, done) => {
      // The first (progressive) render is slow; the terminal render must still
      // run strictly after it, never interleaving.
      if (!done) {
        order.push(`start:${text}`);
        await tick(30);
        order.push(`end:${text}`);
      } else {
        order.push(`done:${text}`);
      }
    }, 5);

    p.append("one");
    await tick(0);
    p.append("two"); // within the debounce window → coalesced into the terminal edit
    await p.finalize();

    expect(order).toEqual(["start:one", "end:one", "done:onetwo"]);
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
