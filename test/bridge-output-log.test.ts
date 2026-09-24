/**
 * #444 — output survived a blip in one direction only.
 *
 * `muxSend` returned early when the socket was not OPEN: no buffer, no replay.
 * Meanwhile stdin *toward* the agent was queued and replayed through
 * `stdinQueue`/`flushQueues`. So the agent kept working through a reconnect
 * and every frame it emitted was discarded. This is the log that removes that
 * asymmetry, plus the line framing that stops a reconnect splicing a partial
 * JSON line into a line-delimited JSON-RPC stream.
 *
 * The two properties worth stating up front, because both are safety rather
 * than features:
 *
 *   - **Trimming never depends on an acknowledgment.** Four of eight hosts
 *     cannot be updated through the rollout tooling, so a new bridge will talk
 *     to an old seam-acp that never acks. If acks were the only thing that
 *     reclaimed memory, that pairing would grow without bound on exactly the
 *     hosts we cannot fix.
 *   - **A gap is stated, never implied.** Returning what is left without
 *     saying something was dropped lets a consumer splice two unrelated points
 *     of a JSON-RPC stream together — blast radius 5. A visible gap is 2.
 */
import { describe, expect, it } from "vitest";
import { createOutputLog, createLineFramer } from "../packages/bridge/src/output-log.js";
import { muxSend, forwardAgentStdout } from "../packages/bridge/src/frame-out.js";

const frame = (n: number) => ({ data: `line-${n}\n` });

describe("#444 the log keeps output a disconnect used to destroy", () => {
  it("records frames and replays everything after a cursor", () => {
    const log = createOutputLog();
    for (let i = 1; i <= 3; i += 1) log.append(1, "data", frame(i));
    expect(log.since(1, 0).frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    // "Read from where you were" — the whole disconnection story.
    expect(log.since(1, 2).frames.map((f) => f.payload.data)).toEqual(["line-3\n"]);
    expect(log.since(1, 3).frames).toEqual([]);
  });

  it("sequences per slot, so one slot's traffic never moves another's cursor", () => {
    const log = createOutputLog();
    log.append(1, "data", frame(1));
    log.append(2, "data", frame(1));
    log.append(1, "data", frame(2));
    expect(log.since(1, 0).frames.map((f) => f.seq)).toEqual([1, 2]);
    expect(log.since(2, 0).frames.map((f) => f.seq)).toEqual([1]);
  });

  it("returns nothing for a slot it has never seen, rather than inventing a gap", () => {
    expect(createOutputLog().since(99, 0)).toEqual({ frames: [] });
  });
});

describe("#444 trimming is bounded without any acknowledgment", () => {
  it("keeps unread frames past the read window, then bounds them by the unread age (#631)", () => {
    const log = createOutputLog({ maxAgeMs: 1_000, maxUnackedAgeMs: 10_000 });
    log.append(1, "data", frame(1), 0);
    log.append(1, "data", frame(2), 500);
    log.append(1, "data", frame(3), 2_000);
    const early = log.since(1, 0, 2_000);
    expect(early.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(early.gap).toBeUndefined();
    const late = log.since(1, 0, 10_800);
    expect(late.frames.map((f) => f.seq)).toEqual([3]);
    expect(late.gap).toBeDefined();
  });

  it("drops by bytes even if the consumer never acks", () => {
    const log = createOutputLog({ maxBytes: 80 });
    for (let i = 1; i <= 20; i += 1) log.append(1, "data", frame(i));
    expect(log.stats().bytes).toBeLessThanOrEqual(80);
    expect(log.since(1, 0).gap).toBeDefined();
  });

  it("caps a single slot so one noisy agent cannot evict the others", () => {
    const log = createOutputLog({ maxFramesPerSlot: 3 });
    for (let i = 1; i <= 10; i += 1) log.append(1, "data", frame(i));
    log.append(2, "data", frame(1));
    expect(log.since(1, 0).frames).toHaveLength(3);
    // The quiet slot still has its frame — it was not collateral.
    expect(log.since(2, 0).frames).toHaveLength(1);
    expect(log.since(2, 0).gap).toBeUndefined();
  });

  it("lets an ack accelerate trimming without being required for it", () => {
    const log = createOutputLog();
    for (let i = 1; i <= 5; i += 1) log.append(1, "data", frame(i));
    log.ack(1, 3);
    expect(log.since(1, 3).frames.map((f) => f.seq)).toEqual([4, 5]);
  });

  it("does NOT report a gap for frames the consumer already acked", () => {
    // Acked output was delivered. Calling that a gap would cry wolf on every
    // reconnect of a perfectly healthy session.
    const log = createOutputLog();
    for (let i = 1; i <= 5; i += 1) log.append(1, "data", frame(i));
    log.ack(1, 3);
    expect(log.since(1, 3).gap).toBeUndefined();
  });

  it("frees a slot's budget when the consumer is finished with it", () => {
    const log = createOutputLog();
    for (let i = 1; i <= 5; i += 1) log.append(1, "data", frame(i));
    expect(log.stats().bytes).toBeGreaterThan(0);
    log.dropSlot(1);
    expect(log.stats()).toMatchObject({ slots: 0, frames: 0, bytes: 0 });
  });
});

describe("#444 a gap is stated, never implied", () => {
  it("names what was lost instead of quietly returning a later range", () => {
    const log = createOutputLog({ maxFramesPerSlot: 2 });
    for (let i = 1; i <= 5; i += 1) log.append(1, "data", frame(i));
    const replay = log.since(1, 0);
    expect(replay.gap).toMatchObject({ afterSeq: 0, firstAvailableSeq: 4 });
    expect(replay.gap!.droppedFrames).toBeGreaterThan(0);
    // The surviving frames are still returned — a gap is not an excuse to
    // withhold what remains.
    expect(replay.frames.map((f) => f.seq)).toEqual([4, 5]);
  });

  it("reports no gap when the cursor is already past everything dropped", () => {
    const log = createOutputLog({ maxFramesPerSlot: 2 });
    for (let i = 1; i <= 5; i += 1) log.append(1, "data", frame(i));
    // This consumer had already read through seq 3, so nothing it needed went.
    expect(log.since(1, 3).gap).toBeUndefined();
    expect(log.since(1, 3).frames.map((f) => f.seq)).toEqual([4, 5]);
  });
});

describe("#444 line framing", () => {
  it("emits only complete lines and holds a partial tail", () => {
    // The splice hazard: forwarding raw chunks meant a reconnect could put
    // half a JSON-RPC message on the wire.
    const framer = createLineFramer();
    expect(framer.push('{"a":1}\n{"b":')).toEqual(['{"a":1}\n']);
    expect(framer.pending()).toBe(5);
    expect(framer.push('2}\n')).toEqual(['{"b":2}\n']);
    expect(framer.pending()).toBe(0);
  });

  it("splits a chunk carrying several lines at once", () => {
    expect(createLineFramer().push("a\nb\nc\n")).toEqual(["a\n", "b\n", "c\n"]);
  });

  it("emits nothing at all for a chunk with no newline", () => {
    const framer = createLineFramer();
    expect(framer.push("no newline yet")).toEqual([]);
  });

  it("surrenders the held tail on flush, so a crash is not a silent truncation", () => {
    const framer = createLineFramer();
    framer.push('{"partial":');
    expect(framer.flush()).toBe('{"partial":');
    expect(framer.flush()).toBeNull();
  });

  it("surrenders an over-long line rather than holding it forever", () => {
    // A stream with no newline would otherwise grow the residual without
    // bound. Truncating silently is the discontinuity this file exists to
    // prevent, so the oversized tail goes out and the consumer's parse-failure
    // counter is what notices.
    const framer = createLineFramer(16);
    expect(framer.push("x".repeat(20))).toEqual(["x".repeat(20)]);
    expect(framer.pending()).toBe(0);
  });
});

describe("#444 an acked-then-trimmed range is still a gap to a reset cursor", () => {
  it("does not hand a rewound consumer later frames as if nothing preceded them", () => {
    // Found by mutation. The first version treated acked frames as "can never
    // be missed", which holds only for the consumer that acked. A cursor that
    // resets to 0 has genuinely not seen 1-3, and they are gone.
    const log = createOutputLog({ maxAgeMs: 1_000 });
    for (let i = 1; i <= 5; i += 1) log.append(1, "data", frame(i), 0);
    log.ack(1, 3, 0);
    const rewound = log.since(1, 0, 5_000);
    expect(rewound.gap).toMatchObject({ afterSeq: 0, firstAvailableSeq: 4 });
    expect(rewound.frames.map((f) => f.seq)).toEqual([4, 5]);
  });

  it("still reports no gap to the consumer that did the acking", () => {
    const log = createOutputLog();
    for (let i = 1; i <= 5; i += 1) log.append(1, "data", frame(i));
    log.ack(1, 3);
    expect(log.since(1, 3).gap).toBeUndefined();
  });
});

describe("#444 the wiring, which had no test until mutation said so", () => {
  // Three mutations survived a full suite while this was inline in `index.ts`:
  // not logging when the socket was closed, dropping `seq` from the wire, and
  // forwarding raw chunks. Each is exactly the bug this story fixes.
  const openWs = () => {
    const sent: string[] = [];
    return { sent, ws: { readyState: 1, send: (raw: string) => sent.push(raw) } };
  };
  const CTOR = { OPEN: 1 } as never;

  it("records output even when the socket is CLOSED — the whole point", () => {
    const log = createOutputLog();
    const closed = { readyState: 3, send: () => { throw new Error("must not send"); } };
    muxSend(closed as never, CTOR, 1, "data", { data: "while-down\n" }, log);
    expect(log.since(1, 0).frames.map((f) => f.payload.data)).toEqual(["while-down\n"]);
  });

  it("records nothing when no log is supplied, so other callers are unchanged", () => {
    const { ws, sent } = openWs();
    muxSend(ws as never, CTOR, 1, "kill", {});
    expect(JSON.parse(sent[0]!)).toEqual({ slot: 1, type: "kill" });
    expect(JSON.parse(sent[0]!)).not.toHaveProperty("seq");
  });

  it("puts the sequence on the wire so the consumer can cursor on it", () => {
    const { ws, sent } = openWs();
    const log = createOutputLog();
    muxSend(ws as never, CTOR, 2, "data", { data: "a\n" }, log);
    muxSend(ws as never, CTOR, 2, "data", { data: "b\n" }, log);
    expect(sent.map((raw) => JSON.parse(raw).seq)).toEqual([1, 2]);
  });

  it("forwards whole lines, never a partial one", () => {
    const framer = createLineFramer();
    const out: string[] = [];
    forwardAgentStdout(Buffer.from('{"a":1}\n{"b":'), framer, (l) => out.push(l));
    expect(out).toEqual(['{"a":1}\n']);
    forwardAgentStdout(Buffer.from('2}\n'), framer, (l) => out.push(l));
    expect(out).toEqual(['{"a":1}\n', '{"b":2}\n']);
  });
});
