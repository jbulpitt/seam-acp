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

describe("#631 controller restarts never end a running slot", () => {
  it("detach releases the binding without telling the bridge to kill", async () => {
    const { ws, child } = harness();
    (child as unknown as { detach(): void }).detach();
    await flush();
    expect(ws.sent.filter((frame) => frame.type === "kill")).toEqual([]);
    child.kill();
    expect(ws.sent.filter((frame) => frame.type === "kill")).toEqual([]);
  });

  it("acknowledges live output it has read, so the bridge can release it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { ws, child, chunks } = harness();
      ws.deliver({ slot: child.slot, type: "data", data: "a\n", seq: 1 });
      ws.deliver({ slot: child.slot, type: "data", data: "b\n", seq: 2 });
      expect(chunks.join("")).toBe("a\nb\n");
      expect(ws.cmds("ackOutput")).toEqual([]);
      vi.advanceTimersByTime(2_000);
      expect(ws.cmds("ackOutput").map((cmd) => cmd.payload)).toEqual([{ slot: child.slot, throughSeq: 2 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allocates slot ids that a later controller cannot reuse", async () => {
    const before = Date.now();
    const { child } = harness();
    expect(child.slot).toBeGreaterThanOrEqual(before);
  });
});

describe("#444 the cursor is what survives a disconnect", () => {
  it("#467 rebinds an existing slot and replays its exact recovery result without input", async () => {
    const ws = new FakeWs();
    const mux = makeMux({ id: "b1" });
    mux.attach(ws as never);
    const child = mux.adopt(12);
    const results: unknown[] = [];
    child.on("remoteRecoveryResult", (result) => results.push(result));
    child.stdin.write("must never reach the pre-restart child\n");
    await flush();

    const replay = ws.cmds("replayOutput").at(-1)!;
    expect(replay.payload).toEqual({ slot: 12, afterSeq: 0 });
    expect(ws.sent.filter((frame) => frame.type === "data" || frame.type === "spawn")).toEqual([]);
    ws.reply(replay, {
      slot: 12,
      frames: [{ seq: 3, type: "recovery_result", recoveryResult: {
        version: 1,
        submissionId: "submission-12",
        acpSessionId: "session-12",
        status: "completed",
        text: "adopted result",
        finishedUtc: "2026-09-22T12:00:00.000Z",
      } }],
    });
    await flush();

    expect(results).toEqual([expect.objectContaining({
      submissionId: "submission-12",
      text: "adopted result",
    })]);
    // This is result adoption, never resubmission: removing `adopt()` strands
    // the frame; replacing it with `spawn()` emits provider-bound input.
    expect(ws.sent.filter((frame) => frame.type === "data" || frame.type === "spawn")).toEqual([]);
  });

  it("#431 continues an in-flight slot after a real socket replacement without replaying its prompt", async () => {
    const disconnects: string[] = [];
    const { ws, mux, child, chunks } = harness({
      onDisconnect: () => disconnects.push("disconnected"),
    });
    const exits: number[] = [];
    child.on("exit", () => exits.push(1));

    // Establish the bridge instance and send the prompt exactly once.
    ws.deliver({ type: "hello", instanceId: "inst-1" });
    child.stdin.write("session/prompt\n");
    await flush();
    expect(ws.sent.filter((frame) => frame.type === "data")).toEqual([
      { slot: child.slot, type: "data", data: "session/prompt\n" },
    ]);

    // A link loss says nothing about the child. The mux keeps the slot and the
    // pending prompt instead of manufacturing agent_exit or retiring it.
    ws.emit("close");
    await flush();
    expect(disconnects).toEqual(["disconnected"]);
    expect(exits).toEqual([]);

    const replacement = new FakeWs();
    mux.attach(replacement as never);
    replacement.deliver({ type: "hello", instanceId: "inst-1" });
    await flush();
    const probe = replacement.cmds("listSlots").at(-1)!;
    replacement.reply(probe, { slots: [child.slot] });
    await flush();

    // Reconnection repairs the output stream; it must never resend input for
    // a prompt that already started (#536 owns any future replay policy).
    expect(replacement.sent.filter((frame) => frame.type === "data")).toEqual([]);
    const replay = replacement.cmds("replayOutput").at(-1)!;
    replacement.reply(replay, {
      slot: child.slot,
      frames: [{ seq: 1, type: "data", data: "missed response\n" }],
    });
    await flush();

    expect(chunks.join("")).toBe("missed response\n");
    expect(exits).toEqual([]);
  });

  it("carries live remote SIGKILL and OOM evidence to the fake child", async () => {
    const { ws, child } = harness();
    const exits: Array<[number | null, string | null]> = [];
    child.on("exit", (code: number | null, signal: string | null) => exits.push([code, signal]));
    ws.deliver({
      slot: child.slot,
      type: "exit",
      code: 1,
      signal: "SIGKILL",
      hostOom: { kind: "host_oom", killedPid: 221249, observedAt: 1_790_033_574_259, scope: "global" },
    });
    await flush();
    expect(exits).toEqual([[1, "SIGKILL"]]);
    expect(child.remoteExit?.hostOom?.killedPid).toBe(221249);
  });

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

  it("preserves a replayed remote signal and host OOM fact", async () => {
    const { ws, child } = harness();
    const exits: Array<[number | null, string | null]> = [];
    child.on("exit", (code: number | null, signal: string | null) => exits.push([code, signal]));
    await reconnect(ws, [child.slot]);
    ws.reply(ws.cmds("replayOutput").at(-1)!, {
      slot: child.slot,
      frames: [{
        seq: 2,
        type: "exit",
        code: 1,
        signal: "SIGKILL",
        hostOom: { kind: "host_oom", killedPid: 221249, observedAt: 1_790_033_574_259, scope: "global" },
      }],
    });
    await flush();
    expect(exits).toEqual([[1, "SIGKILL"]]);
    expect(child.remoteExit).toEqual({
      bridgeId: "b1",
      hostOom: { kind: "host_oom", killedPid: 221249, observedAt: 1_790_033_574_259, scope: "global" },
    });
  });
});

describe("#444 an old bridge must behave exactly as today", () => {
  it("#574 evicts on a new instance when the bridge does not advertise durable slots", async () => {
    const { ws, child } = harness();
    const exits: number[] = [];
    child.on("exit", () => exits.push(1));
    ws.deliver({ type: "hello", instanceId: "old-instance" });
    await flush();
    const probesBeforeRestart = ws.cmds("listSlots").length;

    ws.deliver({ type: "hello", instanceId: "new-instance" });
    await flush();

    expect(exits).toEqual([1]);
    expect(ws.sent.filter((frame) => frame.type === "kill")).toEqual([]);
    expect(ws.cmds("listSlots")).toHaveLength(probesBeforeRestart);
  });

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

describe("#574 a supervisor-backed bridge restart preserves live slots", () => {
  it("reconciles a new capable instance, replays its gap, and never sends kill", async () => {
    const { ws, child, chunks } = harness();
    const exits: number[] = [];
    child.on("exit", () => exits.push(1));
    ws.deliver({
      type: "hello",
      instanceId: "old-instance",
      capabilities: { durableSlots: true },
    });
    ws.deliver({ slot: child.slot, type: "data", data: "before\n", seq: 1 });
    await flush();

    ws.deliver({
      type: "hello",
      instanceId: "new-instance",
      capabilities: { durableSlots: true },
    });
    await flush();
    const probe = ws.cmds("listSlots").at(-1)!;
    expect(probe).toBeDefined();
    ws.reply(probe, {
      slots: [child.slot],
      health: [{
        slot: child.slot,
        alive: true,
        pid: 4242,
        lastStdoutMsAgo: 5,
        lastStdinMsAgo: 10,
      }],
    });
    await flush();

    const replay = ws.cmds("replayOutput").at(-1)!;
    expect(replay.payload).toEqual({ slot: child.slot, afterSeq: 1 });
    ws.reply(replay, {
      slot: child.slot,
      frames: [
        { seq: 2, type: "data", data: "gap-1\n" },
        { seq: 3, type: "data", data: "gap-2\n" },
      ],
    });
    await flush();

    expect(chunks.join("")).toBe("before\ngap-1\ngap-2\n");
    expect(exits).toEqual([]);
    expect(ws.sent.filter((frame) => frame.type === "kill")).toEqual([]);
  });

  it("still evicts a supervised slot whose owning process is dead", async () => {
    const { ws, child } = harness();
    const exits: number[] = [];
    child.on("exit", () => exits.push(1));
    ws.deliver({ type: "hello", instanceId: "old", capabilities: { durableSlots: true } });
    await flush();
    ws.deliver({ type: "hello", instanceId: "new", capabilities: { durableSlots: true } });
    await flush();
    const probe = ws.cmds("listSlots").at(-1)!;
    ws.reply(probe, {
      slots: [child.slot],
      health: [{
        slot: child.slot,
        alive: false,
        pid: 4242,
        lastStdoutMsAgo: 5,
        lastStdinMsAgo: 10,
      }],
    });
    await flush();

    expect(exits).toEqual([1]);
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
