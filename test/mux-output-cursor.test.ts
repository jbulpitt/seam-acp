/**
 * #444 — the consumer side of the output log: a durable cursor, replay on
 * reconnect, and the parse-failure counter that replaces a silent drop.
 *
 * The mixed-version discipline carried forward from #442 is the property that
 * can reach blast radius 4, because four of eight hosts cannot be updated
 * through the rollout tooling. An old bridge sends no `seq` and rejects
 * `replayOutput` as an unknown action; that has to behave exactly as today
 * rather than wedging or evicting live slots.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { makeMux } from "@seam/adapters";

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  terminated = false;
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
  close(): void {}
  ping(): void {}
  terminate(): void {
    this.terminated = true;
  }
  deliver(msg: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
  deliverRaw(text: string): void {
    this.emit("message", Buffer.from(text));
  }
  cmds(action: string): Array<Record<string, unknown>> {
    return this.sent.filter((f) => f.type === "cmd" && (f as { action?: string }).action === action);
  }
  reply(cmd: Record<string, unknown>, payload: unknown): void {
    this.deliver({ type: "cmd_reply", cmdId: cmd.cmdId, payload });
  }
  fail(cmd: Record<string, unknown>, error: string): void {
    this.deliver({ type: "cmd_reply", cmdId: cmd.cmdId, error });
  }
}

const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

afterEach(() => vi.restoreAllMocks());

function harness(opts: Record<string, unknown> = {}) {
  const ws = new FakeWs();
  const gaps: Array<{ slot: number; gap: unknown }> = [];
  const parseFailures: number[] = [];
  const mux = makeMux({
    id: "b1",
    onOutputGap: (slot: number, gap: unknown) => gaps.push({ slot, gap }),
    onParseFailure: (n: number) => parseFailures.push(n),
    ...opts,
  } as never);
  mux.attach(ws as never);
  const child = mux.spawn();
  const chunks: string[] = [];
  child.stdout.on("data", (c: Buffer | string) => chunks.push(c.toString()));
  return { ws, mux, child, chunks, gaps, parseFailures };
}

/** Same instanceId, so the reconnect path (probe + replay) runs. */
async function reconnect(ws: FakeWs, liveSlots: number[]) {
  ws.deliver({ type: "hello", instanceId: "inst-1" });
  await flush();
  ws.deliver({ type: "hello", instanceId: "inst-1" });
  await flush();
  const probe = ws.cmds("listSlots").at(-1);
  if (probe) ws.reply(probe, { slots: liveSlots });
  await flush();
}

describe("#444 the cursor is what survives a disconnect", () => {
  it("asks for everything after the last seq it actually saw", async () => {
    const { ws, child } = harness();
    ws.deliver({ slot: child.slot, type: "data", data: "a\n", seq: 7 });
    await flush();
    await reconnect(ws, [child.slot]);
    const replay = ws.cmds("replayOutput").at(-1);
    expect((replay!.payload as { slot: number; afterSeq: number })).toMatchObject({
      slot: child.slot,
      afterSeq: 7,
    });
  });

  it("delivers replayed frames to the same stream the live path feeds", async () => {
    const { ws, child, chunks } = harness();
    ws.deliver({ slot: child.slot, type: "data", data: "live\n", seq: 1 });
    await flush();
    await reconnect(ws, [child.slot]);
    const replay = ws.cmds("replayOutput").at(-1)!;
    ws.reply(replay, {
      slot: child.slot,
      frames: [
        { seq: 2, type: "data", data: "missed-1\n" },
        { seq: 3, type: "data", data: "missed-2\n" },
      ],
    });
    await flush();
    // Exactly the frames the old path would have destroyed.
    expect(chunks.join("")).toBe("live\nmissed-1\nmissed-2\n");
  });

  it("acks what it consumed, so the bridge can trim early", async () => {
    const { ws, child } = harness();
    await reconnect(ws, [child.slot]);
    ws.reply(ws.cmds("replayOutput").at(-1)!, {
      slot: child.slot,
      frames: [{ seq: 4, type: "data", data: "x\n" }],
    });
    await flush();
    expect((ws.cmds("ackOutput").at(-1)!.payload as { throughSeq: number }).throughSeq).toBe(4);
  });

  it("surfaces a gap rather than splicing across it", async () => {
    const { ws, child, gaps, chunks } = harness();
    await reconnect(ws, [child.slot]);
    ws.reply(ws.cmds("replayOutput").at(-1)!, {
      slot: child.slot,
      gap: { afterSeq: 0, firstAvailableSeq: 9, droppedFrames: 8 },
      frames: [{ seq: 9, type: "data", data: "after-gap\n" }],
    });
    await flush();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ slot: child.slot, gap: { droppedFrames: 8 } });
    // The surviving frames are still delivered — a gap is not a reason to
    // withhold what remains, only to say what is missing.
    expect(chunks.join("")).toBe("after-gap\n");
  });

  it("applies a replayed exit, so a death during the blip is not lost", async () => {
    const { ws, child } = harness();
    const exits: number[] = [];
    child.on("exit", (code: number) => exits.push(code));
    await reconnect(ws, [child.slot]);
    ws.reply(ws.cmds("replayOutput").at(-1)!, {
      slot: child.slot,
      frames: [{ seq: 2, type: "exit", code: 3 }],
    });
    await flush();
    expect(exits).toEqual([3]);
  });
});

describe("#444 an old bridge must behave exactly as today", () => {
  it("never advances a cursor for frames that carry no seq", async () => {
    const { ws, child } = harness();
    ws.deliver({ slot: child.slot, type: "data", data: "a\n" });
    await flush();
    await reconnect(ws, [child.slot]);
    // Cursor 0 means "I have no replay position" — the request is harmless and
    // the rejection below leaves today's behaviour intact.
    expect((ws.cmds("replayOutput").at(-1)!.payload as { afterSeq: number }).afterSeq).toBe(0);
  });

  it("treats a rejected replayOutput as no replay, not as a failure", async () => {
    const { ws, child, chunks } = harness();
    const exits: number[] = [];
    child.on("exit", () => exits.push(1));
    await reconnect(ws, [child.slot]);
    ws.fail(ws.cmds("replayOutput").at(-1)!, "unknown action: replayOutput");
    await flush();
    // The slot survives and the stream is untouched. An old bridge simply has
    // nothing to replay.
    expect(exits).toEqual([]);
    expect(chunks.join("")).toBe("");
  });

  it("does not ask a slot the bridge no longer has to replay", async () => {
    const { ws, child } = harness();
    await reconnect(ws, []); // bridge reports the slot gone
    expect(ws.cmds("replayOutput")).toHaveLength(0);
  });
});

describe("#444 an unparseable frame is counted, not swallowed", () => {
  it("tolerates isolated corruption and resets on a good frame", async () => {
    const { ws, child, parseFailures, chunks } = harness();
    ws.deliverRaw("{not json");
    ws.deliver({ slot: child.slot, type: "data", data: "ok\n", seq: 1 });
    ws.deliverRaw("{also not json");
    await flush();
    expect(parseFailures).toEqual([1, 1]);
    expect(ws.terminated).toBe(false);
    expect(chunks.join("")).toBe("ok\n");
  });

  it("declares the stream corrupt after repeated failures and restarts it", async () => {
    // `catch { return; }` degraded a corrupt stream into missing messages
    // nobody could see. Limping on is worse than restarting.
    const { ws, child, parseFailures } = harness();
    const exits: number[] = [];
    child.on("exit", () => exits.push(1));
    ws.deliverRaw("{bad 1");
    ws.deliverRaw("{bad 2");
    ws.deliverRaw("{bad 3");
    await flush();
    expect(parseFailures).toEqual([1, 2, 3]);
    expect(exits).toEqual([1]);
    expect(ws.terminated).toBe(true);
  });
});
