import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { savedSessionHost } from "./helpers/saved-session-recovery.js";
import { prepareSessionExecutables } from "./helpers/saved-session-executables.js";

const executables = await prepareSessionExecutables();
afterAll(() => executables.close());
afterEach(() => vi.restoreAllMocks());
const fixture = fileURLToPath(new URL("./fixtures/isolated-permission-agent.mjs", import.meta.url));
const allow = { outcome: { outcome: "selected" as const, optionId: "allow" } };
const isPermission = (data: string) => {
  const frame = JSON.parse(data);
  return frame.type === "input" && Buffer.from(frame.dataBase64, "base64").toString().includes('"isolated-permission"');
};

async function pending() {
  const unavailable: Array<{ slot: number; error: Error }> = [];
  const h = await savedSessionHost({ ...executables, agentFixture: fixture,
    onInputUnavailable: (slot, error) => unavailable.push({ slot, error }) });
  const router = h.makeRouter();
  let answer!: (value: typeof allow) => void;
  let granted = false;
  const ask = vi.fn(() => granted ? Promise.resolve(allow)
    : new Promise<typeof allow>(resolve => { answer = resolve; }));
  router.setAskUser(ask);
  const orch = h.makeOrchestrator(router, {
    sendPanel: async (channel: unknown) => ({ channel, id: "owned-panel" }),
    editMessage: async () => {},
    findMessageByNonce: async () => ({ status: "absent" }),
  });
  const turn: Promise<void> = (orch as any).handleIncomingMessage({ messageId: "owned-input",
    channel: { platform: "discord", id: h.record.channelRef }, authorId: "fixture-user",
    authorIsBot: false, text: "read owned snapshot once" });
  // Always join the original promise, including when an old-source exit fails it.
  let settled: any;
  const result = turn.catch(error => ({ error: String(error) })).then(value => { settled = value; return value; });
  await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce(), { timeout: 10_000 });
  const runtime = router.getRuntime(h.record.id)!;
  const slot = runtime.getSlot()!;
  const before = (await h.client.listSlots()).health.find(row => row.slot === slot)!;
  expect(h.store.turnAttempts.get("inbound-owned-input")?.remoteRecovery).toMatchObject({
    slot, acpSessionId: h.record.acpSessionId,
  });
  await expect(h.slots.armRecovery(slot, { submissionId: "conflicting-submission",
    acpSessionId: h.record.acpSessionId, continuation: "continue" }))
    .rejects.toThrow("rung-1 recovery already owns this slot submission");
  const daemon = h.server as any;
  const entry = daemon.slots.get(slot);
  return { h, router, orch, result, runtime, slot, before, daemon, entry, unavailable, get settled() { return settled; },
    answer: () => { granted = true; answer(allow); },
    async close() { await runtime.detach(); await result; await h.close(); } };
}

async function completed(p: Awaited<ReturnType<typeof pending>>) {
  const result = await p.result;
  expect(result).toBeUndefined();
  expect(p.h.store.getInbound("owned-input")?.state).toBe("completed");
  expect(p.h.store.turnAttempts.get("inbound-owned-input")).toMatchObject({
    state: "completed", generation: 1, promptStarted: true,
  });
  const requests = await p.h.requests();
  expect(requests.filter(row => row.method === "session/prompt")).toHaveLength(1);
  expect(requests.filter(row => row.id === "isolated-permission" && row.result)).toHaveLength(1);
  expect(p.h.notices.filter(row => row.text.includes("isolated finished once"))).toHaveLength(1);
  const after = (await p.h.client.listSlots()).health.find(row => row.slot === p.slot)!;
  expect(after).toMatchObject({ pid: p.before.pid, alive: true, attached: true });
  expect(p.h.commands.filter(row => row.type === "kill")).toEqual([]);
  expect(p.router.getRuntime(p.h.record.id)).toBe(p.runtime);
}

describe("retained permission input ownership", () => {
  it.each(["detached", "identity unavailable"])("keeps the original permission turn when %s", async fault => {
    const p = await pending();
    const connect = p.daemon.connectHolder.bind(p.h.server);
    const reconnect = vi.spyOn(p.daemon, "connectHolder").mockResolvedValue(false);
    try {
      if (fault === "detached") {
        p.entry.link.destroy();
        await vi.waitFor(() => expect(p.entry.attached).toBe(false));
      } else vi.spyOn(p.daemon, "entryAlive").mockReturnValueOnce(false);
      p.answer();
      await vi.waitFor(() => expect(p.unavailable.length + p.h.inputFailures.length).toBe(1));
      expect(p.h.inputFailures).toEqual([]);
      expect(p.settled?.error).toBeFalsy();
      expect(p.unavailable).toHaveLength(1);
      expect(p.unavailable[0]!.error.message).toContain("write refused: slot has no attached live process");
      expect(p.entry.exited).not.toBe(true);
      expect(p.h.commands.filter(row => row.type === "kill")).toEqual([]);
      reconnect.mockRestore();
      expect(await connect(p.entry, 0)).toBe(true);
      // The application callback detaches its socket; ordinary mux reattachment
      // replays pending requests, not opaque input or the original prompt.
      await p.h.restartBridge();
      await completed(p);
    } finally { reconnect.mockRestore(); await p.close(); }
  }, 25_000);

  it("does not replay input after an accepted permission write loses its acknowledgement", async () => {
    const p = await pending();
    const request = p.daemon.holderRequest.bind(p.h.server);
    let injected = false;
    const writes = vi.spyOn(p.daemon, "holderRequest").mockImplementation(async (...args: any[]) => {
      const result = await request(...args);
      const message = args[2];
      if (!injected && message.type === "write" && isPermission(Buffer.from(message.dataBase64, "base64").toString())) {
        injected = true;
        throw new Error("slot holder did not answer");
      }
      return result;
    });
    try {
      p.answer();
      await vi.waitFor(() => expect(p.unavailable.length + p.h.inputFailures.length).toBe(1));
      expect(p.h.inputFailures).toEqual([]);
      expect(p.settled?.error).toBeFalsy();
      expect(p.unavailable).toHaveLength(1);
      expect(p.unavailable[0]!.error.cause).toMatchObject({ code: "write_failed",
        message: "write outcome unknown: slot holder did not answer" });
      writes.mockRestore();
      await p.h.restartBridge();
      await completed(p);
    } finally { writes.mockRestore(); await p.close(); }
  }, 25_000);
});
