import { describe, it, expect } from "vitest";
import { StreamingMessageRenderer } from "../src/core/streaming-message-renderer.js";

/** Collects every posted message, in order. */
function collector() {
  const sent: string[] = [];
  const send = async (text: string) => {
    sent.push(text);
  };
  return { sent, send };
}

describe("StreamingMessageRenderer (real FenceStream + splitForFlush + SerialQueue)", () => {
  it("emits MULTIPLE messages at clean paragraph boundaries with linebreaks preserved", async () => {
    const { sent, send } = collector();
    const r = new StreamingMessageRenderer(send);
    // Each paragraph is past SOFT_MIN (800) so the boundary soft-flushes mid-stream,
    // and each carries an internal "\n" so we can prove linebreaks survive.
    const p1 = "First.\n" + "a".repeat(900);
    const p2 = "Second.\n" + "b".repeat(900);
    const p3 = "Third.";

    // Await between feeds to mirror real streamed arrival — a gap between chunks
    // lets the queued soft-flush run before the next chunk lands.
    r.feed(`${p1}\n\n`);
    await r.whenIdle();
    r.feed(`${p2}\n\n`);
    await r.whenIdle();
    r.feed(p3);
    await r.whenIdle();

    // The first two paragraphs already flushed as their own messages mid-stream
    // (before finalize) — this is streaming, not an end-of-turn dump.
    expect(sent).toEqual([p1, p2]);
    expect(sent[0]).toContain("First.\n");
    expect(sent[1]).toContain("Second.\n");

    await r.finalize();
    // finalize drains the remainder (the short trailing paragraph).
    expect(sent).toEqual([p1, p2, p3]);
  });

  it("force-drains a long unbroken buffer into multiple messages at the hard cap", async () => {
    const { sent, send } = collector();
    const r = new StreamingMessageRenderer(send);
    const big = "x".repeat(5000); // no boundaries anywhere
    r.feed(big);
    await r.finalize();

    expect(sent.length).toBe(Math.ceil(big.length / 1800));
    expect(sent.join("")).toBe(big); // lossless
    expect(sent.every((m) => m.length <= 1800)).toBe(true);
  });

  it("keeps a code fence intact as ONE message across flushes", async () => {
    const { sent, send } = collector();
    const r = new StreamingMessageRenderer(send);
    const code = "const a = 1;\nconst b = 2;\nconst c = 3;";
    // Feed the fence split across chunk boundaries — including the opening ``` and
    // the closing ``` arriving in separate feeds.
    r.feed("Intro line here.\n\n``");
    r.feed("`ts\n");
    r.feed(code.slice(0, 15));
    r.feed(code.slice(15));
    r.feed("\n``");
    r.feed("`\n\nAfter the fence.");
    await r.finalize();

    // The fence is reconstructed verbatim as exactly one message, never split.
    const fenceMsg = sent.find((m) => m.startsWith("```ts"));
    expect(fenceMsg).toBe("```ts\n" + code + "\n```");
    // The surrounding prose is present too (as its own message(s)).
    expect(sent.some((m) => m.includes("Intro line here."))).toBe(true);
    expect(sent.some((m) => m.includes("After the fence."))).toBe(true);
  });

  it("finalize drains a short remainder that never hit a boundary", async () => {
    const { sent, send } = collector();
    const r = new StreamingMessageRenderer(send);
    r.feed("just a short line, no boundary");
    await r.whenIdle();
    // Below SOFT_MIN with no paragraph break → nothing flushed yet.
    expect(sent).toEqual([]);
    await r.finalize();
    expect(sent).toEqual(["just a short line, no boundary"]);
    expect(r.sentCount).toBe(1);
  });

  it("emits an unclosed fence at finalize with a notice (nothing dropped)", async () => {
    const { sent, send } = collector();
    const r = new StreamingMessageRenderer(send);
    r.feed("```js\nconsole.log(1)\n"); // fence never closed
    await r.finalize();
    const msg = sent.find((m) => m.startsWith("```js"));
    expect(msg).toContain("console.log(1)");
    expect(msg).toContain("not closed by the agent");
  });

  it("SerialQueue keeps sends in call order even when the sink resolves out of order", async () => {
    const sent: string[] = [];
    // A sink whose EARLIER calls resolve LATER — if sends weren't serialized,
    // completion order would scramble. The SerialQueue must preserve call order.
    let n = 0;
    const send = async (text: string) => {
      const delay = 30 - n * 10; // 30ms, 20ms, 10ms, …
      n += 1;
      await new Promise((res) => setTimeout(res, Math.max(0, delay)));
      sent.push(text);
    };
    const r = new StreamingMessageRenderer(send);
    // Three unbroken over-cap paragraphs → three ordered force-drained messages.
    const a = "a".repeat(1900);
    const b = "b".repeat(1900);
    const c = "c".repeat(1900);
    r.feed(a);
    r.feed(b);
    r.feed(c);
    await r.finalize();

    // Order preserved: all a's, then all b's, then all c's — no interleave.
    expect(sent.join("")).toBe(a + b + c);
    expect(sent[0]!.startsWith("a")).toBe(true);
    expect(sent[sent.length - 1]!.endsWith("c")).toBe(true);
  });

  it("finalize is idempotent", async () => {
    const { sent, send } = collector();
    const r = new StreamingMessageRenderer(send);
    r.feed("hello world");
    await r.finalize();
    const after = sent.length;
    await r.finalize(); // second call is a no-op drain
    r.feed("ignored after finalize");
    await r.finalize();
    expect(sent.length).toBe(after);
    expect(sent).toEqual(["hello world"]);
  });

  it("force-closes a fence that blows past the size ceiling", async () => {
    const { sent, send } = collector();
    const r = new StreamingMessageRenderer(send, { fenceBufferCeiling: 200 });
    r.feed("```txt\n" + "z".repeat(300)); // > ceiling, still open
    await r.finalize();
    const msg = sent.find((m) => m.startsWith("```txt"));
    expect(msg).toContain("z".repeat(300));
    expect(msg).toContain("size ceiling");
  });
});
