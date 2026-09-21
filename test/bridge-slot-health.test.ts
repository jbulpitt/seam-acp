/**
 * #442 — the bridge holds the process, so the bridge answers for it.
 *
 * `listSlots` returned slot ids and nothing else, and the reconnect probe in
 * `mux.ts` was its only caller. That catches an agent that DIED while the
 * socket was down. It catches nothing about one that is alive with a lost
 * in-flight reply: the slot still exists, the probe says yes, the runtime is
 * kept, and `promptInFlight` stays stuck forever.
 *
 * ## Why there is no `midTurn` here
 *
 * The story offered it and the manifesto's rule decides against it: one owner
 * per fact, and the owner is whoever observes it directly. The bridge is a
 * byte mux — it forwards frames and never parses ACP, so it cannot observe a
 * `session/prompt` begin or end. To report `midTurn` it would have to INFER
 * from "stdin arrived and stdout has not", which re-derives a fact seam-acp
 * already holds authoritatively, one layer further from the evidence. That is
 * the bug this epic exists to remove, not a way to fix it.
 *
 * So the bridge reports only what it sees — `alive`, `pid`, and the two
 * silences — and `lastStdinMsAgo` is what makes the seam-acp-side judgement
 * possible: silence *since input* is suspicious, silence with no input is
 * just an idle agent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { makeMux, type BridgeSlotHealth } from "@seam/adapters";

/** A stand-in for the mux's WS: records frames and lets a test inject replies. */
class FakeWs extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
  close(): void {}
  ping(): void {}
  terminate(): void {}
  deliver(msg: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
  lastCmd(action: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((f) => f.type === "cmd" && (f as { action?: string }).action === action);
  }
}

const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

afterEach(() => vi.restoreAllMocks());

/** Attach a mux to a fake socket and open `count` slots on it. */
function muxWithSlots(count: number, onSlotHealth?: (h: readonly BridgeSlotHealth[]) => void) {
  const ws = new FakeWs();
  const mux = makeMux({ id: "b1", ...(onSlotHealth ? { onSlotHealth } : {}) } as never);
  mux.attach(ws as never);
  const children = Array.from({ length: count }, () => mux.spawn());
  return { ws, mux, children };
}

/** The same-instance reconnect: same instanceId, so the probe fires. */
async function reconnectProbe(ws: FakeWs, mux: ReturnType<typeof makeMux>, reply: Record<string, unknown>) {
  ws.deliver({ type: "hello", instanceId: "inst-1" });
  await flush();
  ws.deliver({ type: "hello", instanceId: "inst-1" });
  await flush();
  const cmd = ws.lastCmd("listSlots");
  if (cmd) ws.deliver({ type: "cmd_reply", cmdId: cmd.cmdId, payload: reply });
  await flush();
  void mux;
}

describe("#442 the reconnect probe uses health, not just existence", () => {
  it("still evicts a slot the bridge no longer lists", async () => {
    // Today's behaviour, unchanged: this is the case the probe already covered
    // and a mixed-version fleet must keep getting it.
    const { ws, mux, children } = muxWithSlots(2);
    const exits: number[] = [];
    children.forEach((c, i) => c.on("exit", () => exits.push(i)));
    await reconnectProbe(ws, mux, { slots: [children[0]!.slot] });
    expect(exits).toEqual([1]);
  });

  it("evicts a slot the bridge lists but reports DEAD", async () => {
    // The list says "I have an entry"; `alive:false` says "the process is
    // gone". The second is the stronger statement and wins.
    const { ws, mux, children } = muxWithSlots(2);
    const exits: number[] = [];
    children.forEach((c, i) => c.on("exit", () => exits.push(i)));
    await reconnectProbe(ws, mux, {
      slots: children.map((c) => c.slot),
      health: [
        { slot: children[0]!.slot, alive: true, pid: 10, lastStdoutMsAgo: 2_000, lastStdinMsAgo: 3_000 },
        { slot: children[1]!.slot, alive: false, pid: null, lastStdoutMsAgo: null, lastStdinMsAgo: null },
      ],
    });
    expect(exits).toEqual([1]);
  });

  it("treats a bridge that sends no health as having NO OPINION, not as unhealthy", async () => {
    // An old bridge answering a new seam-acp must behave exactly as today.
    // Reading a missing field as "unhealthy" would evict every live slot in
    // the fleet on the first reconnect after deploy.
    const { ws, mux, children } = muxWithSlots(2);
    const exits: number[] = [];
    children.forEach((c, i) => c.on("exit", () => exits.push(i)));
    await reconnectProbe(ws, mux, { slots: children.map((c) => c.slot) });
    expect(exits).toEqual([]);
  });

  it("does NOT evict a live-but-silent slot, because silence is not its call", async () => {
    // The bridge cannot know whether 400s of silence means a stuck turn or an
    // idle agent. It reports the number; seam-acp decides. Killing here would
    // put the verdict in the wrong place — the bug, one layer down.
    const seen: BridgeSlotHealth[][] = [];
    const { ws, mux, children } = muxWithSlots(1, (h) => seen.push([...h]));
    const exits: number[] = [];
    children[0]!.on("exit", () => exits.push(0));
    await reconnectProbe(ws, mux, {
      slots: [children[0]!.slot],
      health: [{ slot: children[0]!.slot, alive: true, pid: 10, lastStdoutMsAgo: 400_000, lastStdinMsAgo: 401_000 }],
    });
    expect(exits).toEqual([]);
    // But it IS surfaced, so the owner can act on it.
    expect(seen.at(-1)?.[0]?.lastStdoutMsAgo).toBe(400_000);
  });
});
