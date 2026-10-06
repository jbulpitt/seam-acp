import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { makeMux, type AgentProfile } from "@seam/adapters";
import type { BridgeSlotHealth } from "../packages/adapters/src/mux.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { visualConfig } from "./plugin-card-visuals-fixture.js";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";
import { createRuntimeDispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { enqueueDispatchSpec, dispatchDirs } from "../packages/core/src/core/dispatch/types.js";
import { existsSync } from "node:fs";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

async function setup(source: "inbound" | "dispatch" | "schedule" = "inbound", style: "full" | "simple" = "full",
  options: { armed?: boolean; queue?: boolean; disconnected?: boolean; adoptionUnavailable?: boolean;
    attached?: boolean; terminalResult?: "completed" | "failed" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-adopt-reconnect-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const now = new Date(Date.now() - 60_000).toISOString();
  const record = { id: "discord:thread", platform: "discord", channelRef: "thread",
    parentRef: null, agentId: "codex", acpSessionId: "acp", repoPath: "/synthetic",
    configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  if (source === "schedule") {
    const row: ScheduledPrompt = { id: "schedule", platform: "discord", channelRef: "thread", parentRef: null,
      name: "Live adoption", promptText: "work", cron: "0 9 * * *", timezone: "UTC", model: null,
      cwd: null, targetChannel: null, outputType: "messages", sessionMode: "live", catchupSeconds: 0,
      enabled: false, legacyAttachmentCount: 0, createdBy: "user", createdUtc: now, updatedUtc: now,
      lastRunUtc: null, lastStatus: null, nextRunUtc: null, pinnedSessionId: null };
    store.upsertScheduled(row);
    store.scheduledOccurrences.reserve({ id: "inbound-1", scheduledFor: null }, row,
      { agentId: "codex", location: "remote", model: "test", effort: null, cwd: "/synthetic", fingerprint: "identity" });
  }
  store.turnAttempts.registerOwner("old-controller");
  const attempt = store.turnAttempts.claim({ id: "inbound-1", target: "thread",
    prompt: "work", session: "live", kind: source === "schedule" ? "scheduled" : "parked", createdUtc: now },
  "identity", "old-controller", source);
  store.turnAttempts.bind(attempt, "acp");
  store.turnAttempts.bindStatusCard(attempt, { channelId: "thread", messageId: "card" });
  const status = new TurnStatus({ model: "test", repoDisplay: "/synthetic", style, authorName: "Codex",
    ...(source === "dispatch" ? { titlePrefix: "📥 Parked" } : {}) });
  status.startedUtc = Date.parse(now);
  status.pushThinkingChunk("before restart\n");
  status.contextUsedHighWater = 10_000;
  status.contextWindowSize = 200_000;
  status.context = "10k / 200k (5%)";
  store.turnAttempts.saveStatusCardState(attempt, status.snapshot(), style === "simple" ? "gif-before-restart" : undefined);
  store.turnAttempts.startPrompt(attempt);
  store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "remote",
    slot: 6, submissionId: "submission", acpSessionId: "acp", delegatedUtc: now });
  store.turnAttempts.suspendBoot("old-controller");
  store.close();
  store = new SessionStore(path.join(dir, "test.db"));
  const snapshot = { version: 1, owner: "bridge", submissionId: "submission",
    acpSessionId: "acp", rung: 1, phase: options.terminalResult
      ? options.terminalResult === "completed" ? "succeeded" : "exhausted"
      : options.armed ? "armed" : "executing", retry: 0, budget: 3,
    remaining: 3, disposition: "none", updatedUtc: now, ...(options.armed ? { reconcileSupported: true } : {}) };
  let rows = [{ slot: 6, alive: !options.terminalResult, attached: options.attached ?? true,
    outputAckedThrough: 10, recovery: snapshot }];
  let promptMissing = false;
  let ownerLostDuringProbe = false;
  let inventoryUnknown = false;
  let inventoryError = false;
  let seq = 10;
  const frames: Array<Record<string, unknown>> = [];
  if (options.terminalResult) frames.push({ slot: 6, seq: ++seq, type: "recovery_result", recoveryResult: {
    version: 1, submissionId: "submission", acpSessionId: "acp", status: options.terminalResult,
    text: "provider final answer", ...(options.terminalResult === "failed"
      ? { error: "provider rejected the request", errorKind: "protocol_error" } : {}),
    stopReason: "end_turn", finishedUtc: new Date().toISOString(),
  } });
  const commands: Array<Record<string, any>> = [];
  class Socket extends EventEmitter {
    readyState = 1;
    send(raw: string) {
      const cmd = JSON.parse(raw);
      commands.push(cmd);
      if (cmd.type !== "cmd") return;
      if (cmd.action === "listSlots" && inventoryError) {
        queueMicrotask(() => this.deliver({ type: "cmd_reply", cmdId: cmd.cmdId, error: "fixture bridge reconnecting" }));
        return;
      }
      if (cmd.action === "reconcileRung1Recovery" && ownerLostDuringProbe) {
        rows = [];
        queueMicrotask(() => this.deliver({ type: "cmd_reply", cmdId: cmd.cmdId,
          payload: { state: "missing", cause: "bridge slot 6 has no live process" } }));
        return;
      }
      queueMicrotask(() => this.deliver({ type: "cmd_reply", cmdId: cmd.cmdId,
        payload: cmd.action === "listSlots"
          ? { slots: rows.map(row => row.slot), ...(inventoryUnknown ? {} : { health: rows }) }
          : cmd.action === "replayOutput"
            ? { frames: frames.filter(frame => Number(frame.seq) > cmd.payload.afterSeq) }
            : { state: "owned" } }));
      if (cmd.action === "reconcileRung1Recovery" && promptMissing) queueMicrotask(() => frame({
        type: "recovery_result", recoveryResult: {
          version: 1, submissionId: "submission", acpSessionId: "acp", status: "failed",
          text: "", errorKind: "protocol_error", stopReason: "prompt_not_received",
          error: "bridge slot 6 armed recovery but never received a complete session/prompt for this submission",
          finishedUtc: new Date().toISOString(),
        },
      }));
    }
    close() {}
    deliver(frame: Record<string, unknown>) {
      this.emit("message", Buffer.from(JSON.stringify(frame)));
    }
  }
  let socket = new Socket();
  let health: BridgeSlotHealth[] = [];
  const mux = makeMux({ id: "remote", onSlotHealth: rows => { health = [...rows]; } });
  mux.attach(socket as never);
  socket.deliver({ type: "hello", instanceId: "first", capabilities: { durableSlots: true } });
  let runtime!: AgentRuntime;
  let adoptionUnavailable = options.adoptionUnavailable ?? false;
  const router = {
    isBusy: () => runtime?.busy ?? false,
    describeConfig: () => ({ model: { value: "test" }, agent: { value: "codex" },
      location: { value: "remote" }, cwd: { value: "/synthetic" } }),
    adoptRecoveryRuntime: (_record: unknown, child: any, session: string) => {
      if (adoptionUnavailable) throw new Error("fixture bridge catalog not ready");
      runtime = new AgentRuntime({ profile: { id: "codex" } as AgentProfile,
        logger: pino({ level: "silent" }) as any, spawnFn: () => { throw new Error("must not spawn"); } });
      runtime.attachRecovery(child, session);
      return runtime;
    },
    releaseRecoveryRuntime: (_id: string, rt: AgentRuntime) => rt.releaseRecovery(),
  };
  const visible: string[] = [];
  const nonces = new Set<string>();
  const adapter = {
    sendMessage: vi.fn(async (channel: any, text: string, delivery?: { nonce?: string }) => {
      if (!delivery?.nonce || !nonces.has(delivery.nonce)) visible.push(text);
      if (delivery?.nonce) nonces.add(delivery.nonce);
      return { channel, id: `message-${visible.length}` };
    }),
    editPanel: vi.fn(async (_ref: any, _panel: any) => {}),
    deleteMessage: vi.fn(async () => {}),
    findMessageByNonce: vi.fn(async (_channel: any, nonce: string) => nonces.has(nonce)
      ? { status: "found", message: { channel: _channel, id: "found" } }
      : { status: "absent" }),
  };
  const orch = new Orchestrator({ logger: pino({ level: "silent" }) as any,
    modelCatalog: fixtureModelCatalog([]), store, router: router as any,
    adapter: adapter as any, renderer: discordRenderer as any,
    config: { ...visualConfig, DATA_DIR: dir, REPOS_ROOT: "/synthetic", REPO_EMOJIS: new Map(),
      channelPresets: new Map(), threadPresets: new Map() } as any });
  let connected = !options.disconnected;
  const readyListeners = new Set<(location: string) => void>();
  orch.setBridgeHub({ muxFor: () => connected ? mux : undefined, slotHealthFor: () => health,
    onBridgeReady: (listener: (location: string) => void) => {
      readyListeners.add(listener); return () => { readyListeners.delete(listener); };
    } } as any);
  const ready = orch.loadPlugins();
  await ready;
  const run = ready.then(() => options.queue
    ? (orch as any).adoptRemoteRecovery(store.turnAttempts.get(attempt.id))
    : (orch as any).adoptRemoteRecoveryOwned(store.turnAttempts.get(attempt.id))) as Promise<boolean>;
  const frame = (payload: Record<string, unknown>, live = true) => {
    const entry = { slot: 6, seq: ++seq, ...payload };
    frames.push(entry);
    if (live) socket.deliver(entry);
  };
  const update = (update: Record<string, unknown>, live = true) => frame({ type: "data",
    data: JSON.stringify({ jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "acp", update } }) + "\n" }, live);
  const text = (content: string, live = true) => update({ sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: content } }, live);
  const complete = (output: string) => frame({ type: "recovery_result", recoveryResult: {
    version: 1, submissionId: "submission", acpSessionId: "acp", status: "completed",
    text: output, stopReason: "end_turn", finishedUtc: new Date().toISOString(),
  } });
  const reconnect = async () => {
    socket.readyState = 3;
    socket.emit("close");
    socket = new Socket();
    mux.attach(socket as never);
    socket.deliver({ type: "hello", instanceId: "second", capabilities: { durableSlots: true } });
    await drain();
  };
  return { orch, store, run, ready, adapter, visible, commands, text, update, complete, reconnect,
    dir, snapshot, loseSlot: () => { rows = []; },
    losePrompt: () => { promptMissing = true; },
    unknownInventory: () => { inventoryUnknown = true; },
    failInventory: () => { inventoryError = true; },
    restoreInventory: () => { inventoryUnknown = false; inventoryError = false; },
    connectBridge: () => { connected = true; for (const listener of [...readyListeners]) listener("remote"); },
    allowAdoption: () => { adoptionUnavailable = false; },
    attachOwner: () => { rows[0]!.attached = true; },
    loseOwnerDuringProbe: () => { ownerLostDuringProbe = true; },
    replaceSubmission: () => { rows = [{ ...rows[0]!, recovery: { ...snapshot, submissionId: "other-submission" } }]; },
    runtime: () => runtime };
}

describe("scheduled live adoption delivery", () => {
  it("delivers the adopted scheduled final once before projecting Done", async () => {
    const h = await setup("schedule");
    await drain();
    const send = h.adapter.sendMessage.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.adapter.sendMessage.mockImplementation(async (...args) => { await gate; return send(...args); });
    h.complete("SEAM875_FINAL");
    await drain();
    try {
      expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: false,
        deliveryPayload: { kind: "messages", texts: ["SEAM875_FINAL"] } });
      expect(h.visible).toEqual([]);
      expect(h.store.scheduledOccurrences.get("inbound-1")?.settled).toBe(false);
      expect(h.adapter.editPanel.mock.calls.at(-1)?.[1].title).not.toBe("Done");
    } finally { release(); await h.run; }
    expect(h.visible).toEqual(["SEAM875_FINAL"]);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ deliveryDone: true, deliveryAbandonedReason: null });
    expect(h.store.scheduledOccurrences.get("inbound-1")?.settled).toBe(true);
    expect(h.adapter.editPanel.mock.calls.at(-1)?.[1].title).toBe("Done");
    await h.orch.runScheduledPrompt("schedule", { id: "inbound-1", scheduledFor: null });
    expect(h.visible).toEqual(["SEAM875_FINAL"]);
    expect(h.commands.filter(command => command.type === "spawn")).toEqual([]);
  });

  it("uses the adopted stream nonces without replaying pre-adoption scheduled text", async () => {
    const h = await setup("schedule");
    await drain();
    h.text("adopted narration\n\n");
    h.update({ sessionUpdate: "tool_call", toolCallId: "flush", title: "read", kind: "read" });
    await drain();
    expect(h.visible).toEqual(["adopted narration"]);
    h.complete("before adoption\n\nadopted narration\n\nSEAM875_FINAL");
    await h.run;
    expect(h.visible).toEqual(["adopted narration", "SEAM875_FINAL"]);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ deliveryDone: true,
      deliveryPayload: { kind: "messages", texts: h.visible } });
  });

  it("retains the adopted scheduled payload after a failed send and recovers delivery only", async () => {
    const h = await setup("schedule");
    await drain();
    const send = h.adapter.sendMessage.getMockImplementation()!;
    h.adapter.sendMessage.mockRejectedValue(new Error("Discord transport unavailable"));
    h.complete("SEAM875_FINAL");
    await h.run;
    expect(h.visible).toEqual([]);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: false,
      deliveryNonce: expect.any(String), deliveryPayload: { kind: "messages", texts: ["SEAM875_FINAL"] },
      deliveryAbandonedReason: null });
    expect(h.store.scheduledOccurrences.get("inbound-1")?.settled).toBe(false);
    h.adapter.sendMessage.mockImplementation(send);
    await h.orch.runScheduledPrompt("schedule", { id: "inbound-1", scheduledFor: null });
    expect(h.visible).toEqual(["SEAM875_FINAL"]);
    expect(h.store.turnAttempts.get("inbound-1")?.deliveryDone).toBe(true);
    expect(h.store.scheduledOccurrences.get("inbound-1")?.settled).toBe(true);
    expect(h.commands.filter(command => command.type === "spawn")).toEqual([]);
  });
});

describe("#777 armed recovery queue reconciliation", () => {
  it("waits visibly for a surviving unattached owner and adopts it without a new process", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await setup("dispatch", "full", { queue: true, attached: false });
    const resume = vi.spyOn(h.orch, "resumeTurnManually");
    await h.run;
    await drain();
    await h.orch.reconcileRemoteRecoveries();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(h.visible.some(text => text.includes("Still reconnecting") && text.includes("keep trying"))).toBe(true);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "suspended", generation: 1,
      remoteRecovery: { slot: 6, acpSessionId: "acp" }, outcome: null });
    expect(h.runtime()).toBeUndefined();
    h.attachOwner();
    await h.orch.reconcileRemoteRecoveries();
    await drain();
    expect(h.runtime()).toBeDefined();
    h.complete("same owner finished");
    await drain();
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", generation: 1,
      outcome: { status: "completed", output: "same owner finished" } });
    expect(resume).not.toHaveBeenCalled();
    expect(h.commands.filter(command => command.type === "spawn")).toEqual([]);
  });

  it.each(["completed", "failed"] as const)("replays a genuine %s result from an exited child without continuing", async status => {
    const h = await setup("dispatch", "full", { queue: true, terminalResult: status });
    const resume = vi.spyOn(h.orch, "resumeTurnManually");
    await h.run;
    await drain();
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", generation: 1,
      outcome: { status, output: "provider final answer", ...(status === "failed"
        ? { error: "provider rejected the request" } : {}) } });
    expect(resume).not.toHaveBeenCalled();
    expect(h.commands.filter(command => command.type === "spawn")).toEqual([]);
  });

  it("keeps the existing 15-minute reconnect notice without failing unknown live work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await setup("dispatch", "full", { armed: true, queue: true, disconnected: true });
    await h.run;
    await drain();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(h.visible.some(text => text.includes("Still reconnecting") && text.includes("keep trying"))).toBe(true);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "suspended", outcome: null });
    expect(h.commands.filter(command => command.type === "kill")).toEqual([]);
    h.connectBridge();
    await drain();
    h.complete("reconnected after the notice");
    await drain();
    expect(h.store.turnAttempts.get("inbound-1")?.state).toBe("completed");
  });

  it.each(["bridge disconnected", "catalog not ready"])("keeps the queue owned while %s clears", async fault => {
    const h = await setup("dispatch", "full", { armed: true, queue: true,
      disconnected: fault === "bridge disconnected", adoptionUnavailable: fault === "catalog not ready" });
    await h.run;
    await drain();
    let ran = false;
    const next = (h.orch as any).queueOnChannel("thread", async () => { ran = true; });
    await drain();
    expect(ran).toBe(false);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "suspended", stalledReason: null });
    expect(h.commands.filter(command => command.type === "kill" || command.type === "spawn")).toEqual([]);
    h.allowAdoption();
    h.connectBridge();
    await h.orch.reconcileRemoteRecoveries();
    await drain();
    h.losePrompt();
    await h.orch.reconcileRemoteRecoveries();
    await next;
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed",
      outcome: { status: "failed", error: expect.stringContaining("never received") } });
    expect(ran).toBe(true);
    expect(h.commands.filter(command => command.type === "kill" || command.type === "spawn")).toEqual([]);
  });

  it("releases reconnect ownership on explicit cancellation", async () => {
    const h = await setup("dispatch", "full", { armed: true, queue: true, disconnected: true });
    await h.run;
    await drain();
    let ran = false;
    const next = (h.orch as any).queueOnChannel("thread", async () => { ran = true; });
    expect(h.store.turnAttempts.cancel("inbound-1", "explicit fixture cancellation")).toBe(true);
    await next;
    expect(ran).toBe(true);
    expect(h.store.turnAttempts.get("inbound-1")?.state).toBe("cancelled");
  });

  it.each(["legacy inventory", "bridge reconnecting"])("retains %s without killing or releasing queued work", async fault => {
    const h = await setup("dispatch", "full", { armed: true, queue: true });
    await h.run;
    await drain();
    if (fault === "legacy inventory") h.unknownInventory();
    else h.failInventory();
    let ran = false;
    const next = (h.orch as any).queueOnChannel("thread", async () => { ran = true; });
    await h.orch.reconcileRemoteRecoveries();
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "suspended", outcome: null });
    expect(ran).toBe(false);
    expect(h.commands.filter(command => command.type === "kill" || command.type === "spawn")).toEqual([]);
    h.restoreInventory();
    h.complete("reconnected and finished");
    await next;
    expect(ran).toBe(true);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed",
      outcome: { status: "completed", output: "reconnected and finished" } });
  });

  it.each(["submission replaced", "prompt never received"] as const)(
    "settles %s with its cause and runs queued dispatches without interrupting the slot", async fault => {
      const h = await setup("dispatch", "full", { armed: true, queue: true });
      await h.run;
      await drain();
      if (fault === "submission replaced") h.replaceSubmission();
      if (fault === "prompt never received") h.losePrompt();
      vi.spyOn(h.orch, "recoverInterruptedTurns").mockResolvedValue(undefined);
      const executed: string[] = [];
      vi.spyOn(h.orch, "dispatchInjectTurn").mockImplementation(spec =>
        (h.orch as any).queueOnChannel(spec.target, async () => {
          executed.push(spec.id);
          return { output: spec.id, stopReason: "end_turn" };
        }));
      const watcher = createRuntimeDispatchWatcher({ runtime: h.orch, attempts: h.store.turnAttempts,
        dataDir: h.dir, logger: pino({ level: "silent" }) as any, pollMs: 1_000_000 });
      try {
        await watcher.start();
        for (let index = 0; index < 3; index++) await enqueueDispatchSpec(h.dir, {
          id: `queued-${index}`, target: "thread", prompt: "next", session: "live",
          createdUtc: new Date(Date.now() + index).toISOString(),
        });
        const tick = watcher.tick();
        for (let check = 0; check < 50 && h.store.turnAttempts.get("inbound-1")?.state !== "completed"; check++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed",
          outcome: { status: "failed", error: expect.stringContaining(
            fault === "prompt never received" ? "never received" : "no longer owns") } });
        await tick;
        expect(executed).toEqual(["queued-0", "queued-1", "queued-2"]);
        for (const id of executed) expect(existsSync(path.join(dispatchDirs(h.dir).done, `${id}.json`))).toBe(true);
        expect(h.commands.filter(command => command.type === "kill" || command.type === "spawn")).toEqual([]);
        expect(h.commands.filter(command => command.type === "data" && command.data?.includes("session/cancel"))).toEqual([]);
      } finally {
        watcher.stop();
        h.complete("fixture cleanup");
        await watcher.drain();
      }
    });

  it.each(["inventory", "reconcile"])("releases the adoption queue when %s reports a lost owner and requests exactly one continuation", async source => {
    const h = await setup("dispatch", "full", { queue: true, armed: true });
    await h.run;
    await drain();
    const resume = vi.spyOn(h.orch, "resumeTurnManually").mockResolvedValue("Continuation requested");
    let ran = false;
    const next = (h.orch as any).queueOnChannel("thread", async () => { ran = true; });
    await drain();
    expect(ran).toBe(false);
    if (source === "inventory") h.loseSlot();
    else h.loseOwnerDuringProbe();
    await h.orch.reconcileRemoteRecoveries();
    await next;
    await drain();
    await h.orch.reconcileRemoteRecoveries();
    expect(resume).toHaveBeenCalledExactlyOnceWith("inbound-1");
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({
      state: "suspended", acpSessionId: "acp", outcome: null,
    });
    expect(h.store.turnAttempts.get("inbound-1")?.remoteRecovery).toBeUndefined();
    expect(h.commands.filter(command => command.type === "kill" || command.type === "spawn")).toEqual([]);
  });
});

describe("adopted turns across a bridge reconnect", () => {
  it.each(["full", "simple"] as const)("keeps %s telemetry ticking and finalizes the original card and GIF", async style => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const h = await setup("dispatch", style);
    await drain();
    const first = h.adapter.editPanel.mock.calls.at(-1)![1];
    expect(JSON.stringify(first)).toContain("before restart");
    expect(JSON.stringify(first)).toContain("60s");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(JSON.stringify(h.adapter.editPanel.mock.calls.at(-1)![1])).toContain("65s");
    h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "after restart thinking\n" } });
    h.update({ sessionUpdate: "usage_update", used: 50_000, size: 200_000 });
    await drain();
    await vi.advanceTimersByTimeAsync(5_000);
    const updated = JSON.stringify(h.adapter.editPanel.mock.calls.at(-1)![1]);
    expect(updated).toContain("after restart thinking");
    expect(updated).toContain(style === "simple" ? "25%" : "50k");
    expect(h.store.turnAttempts.get("inbound-1")!.statusCardState!.status.contextUsed).toBe(50_000);
    h.complete("finished");
    await h.run;
    const final = h.adapter.editPanel.mock.calls.at(-1)!;
    expect(final[0].id).toBe("card");
    expect(final[1].title).toContain("Done");
    expect(final[1].author).toBe(style === "simple" ? "Done" : "test");
    expect(final[1].authorIconURL).toMatch(/codex.webp$/);
    if (style === "simple") expect(h.adapter.deleteMessage).toHaveBeenCalledWith({ channel: { platform: "discord", id: "thread" }, id: "gif-before-restart" });
    const edits = h.adapter.editPanel.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.adapter.editPanel).toHaveBeenCalledTimes(edits);
  });
  it("observes the boot snapshot even when its recovery frame was already acknowledged", async () => {
    const h = await setup("dispatch");
    await drain();
    h.store.turnAttempts.admit({ id: "queued", target: "thread", prompt: "next",
      session: "live", createdUtc: new Date().toISOString() });
    expect(h.orch.inspectThreadWorkProgress("thread")).toMatchObject({
      remoteRecovery: [{ observed: true, phase: "executing", retry: 0, remaining: 3 }],
      queuedDispatchIds: ["queued"],
      retainedDispatchIds: ["inbound-1"],
      blockedByDispatchIds: [],
    });
    await h.reconnect();
    expect(h.orch.inspectThreadWorkProgress("thread").remoteRecovery[0]).toMatchObject({
      observed: true, phase: "executing",
    });
    h.complete("finished");
    await h.run;
  });

  it("records adopted narration reaching Discord without overwriting newer session config", async () => {
    const h = await setup();
    await drain();
    const record = h.store.get("discord:thread")!;
    h.store.upsert({ ...record, configJson: '{"newer":true}' });
    h.text("visible after adoption\n\n");
    h.update({ sessionUpdate: "tool_call", toolCallId: "flush", title: "next", kind: "execute" });
    await drain();
    expect(h.visible).toContain("visible after adoption");
    expect(h.store.get(record.id)).toMatchObject({ configJson: '{"newer":true}' });
    expect(Date.parse(h.store.get(record.id)!.updatedUtc)).toBeGreaterThan(Date.parse(record.updatedUtc));
    h.complete("visible after adoption\n\nfinished");
    await h.run;
  });

  it("records terminal-only delivery as activity, but not a failed send", async () => {
    const delivered = await setup();
    await drain();
    const before = delivered.store.get("discord:thread")!.updatedUtc;
    delivered.complete("terminal-only reply");
    await delivered.run;
    expect(delivered.visible).toEqual(["terminal-only reply"]);
    expect(Date.parse(delivered.store.get("discord:thread")!.updatedUtc)).toBeGreaterThan(Date.parse(before));

    const failed = await setup();
    await drain();
    const unchanged = failed.store.get("discord:thread")!.updatedUtc;
    failed.adapter.sendMessage.mockRejectedValue(new Error("Discord unavailable"));
    failed.complete("not delivered");
    await failed.run;
    expect(failed.store.get("discord:thread")!.updatedUtc).toBe(unchanged);
    expect(failed.store.turnAttempts.get("inbound-1")!.deliveryDone).toBe(false);
  });

  it("does not replay directive-only output after already rendering its choice", async () => {
    const h = await setup();
    await drain();
    const publish = vi.spyOn(h.orch, "createChoice").mockResolvedValue({ ok: true, choiceId: "choice", messageId: "card" });
    const fence = '```seam-choice\n{"title":"Next","options":[{"label":"Continue","kind":"prompt","payload":"continue"}]}\n```';
    h.text(fence);
    h.complete(fence);
    await h.run;
    expect(publish).toHaveBeenCalledOnce();
    expect(h.visible).toEqual([]);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: true });
  });

  it("still projects Done after an intermediate adopted card edit is rejected", async () => {
    const h = await setup();
    await drain();
    h.adapter.editPanel.mockRejectedValueOnce(new Error("DiscordAPIError 50035"));
    h.update({ sessionUpdate: "tool_call", toolCallId: "long", title: "heredoc ".repeat(300),
      kind: "execute", status: "in_progress" });
    await drain();
    h.text("finished");
    h.complete("finished");
    await h.run;
    expect(h.adapter.editPanel).toHaveBeenLastCalledWith(
      { channel: { platform: "discord", id: "thread" }, id: "card" },
      expect.objectContaining({ title: "Done", fields: expect.arrayContaining([{ name: "Action", value: "end_turn", inline: true }]) }));
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: true });
  });

  it("delivers queued final text and leaves Done last when a card edit is slow", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await setup();
    await drain();
    h.text("adopted narration\n\n");
    h.update({ sessionUpdate: "tool_call", toolCallId: "before", title: "before reconnect",
      kind: "execute", status: "in_progress" });
    await drain();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.adapter.editPanel.mockImplementationOnce(async () => gate);
    h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    await drain();
    h.text("after reconnect\n\n", false);
    await h.reconnect();
    h.update({ sessionUpdate: "tool_call", toolCallId: "after", title: "after reconnect",
      kind: "execute", status: "in_progress" });
    const final = `FINAL ${"complete output ".repeat(200)} END`;
    h.text(final);
    h.complete("previously visible\n\nadopted narration\n\nafter reconnect\n\n" + final);
    await drain();
    await vi.advanceTimersByTimeAsync(5_001);
    await drain();
    release();
    await h.run;
    await drain();
    expect(h.commands.filter(cmd => cmd.action === "replayOutput").at(-1)?.payload.afterSeq).toBeGreaterThan(10);
    expect(h.visible.join(" ")).toContain("after reconnect");
    expect(h.visible.join(" ")).toContain("FINAL");
    expect(h.visible.join(" ")).toContain("END");
    expect(h.visible.filter(text => text.includes("FINAL"))).toHaveLength(1);
    expect(h.visible.every(text => text.length <= 1800)).toBe(true);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: true });
    expect(h.adapter.editPanel).toHaveBeenLastCalledWith(
      { channel: { platform: "discord", id: "thread" }, id: "card" },
      expect.objectContaining({ title: "Done", fields: expect.arrayContaining([{ name: "Action", value: "end_turn", inline: true }]) }));
  });

  it("reconciles an unseen terminal suffix against the bridge result before recording delivery", async () => {
    const h = await setup();
    await drain();
    h.text("adopted narration\n\n");
    h.update({ sessionUpdate: "tool_call", toolCallId: "tool", title: "read",
      kind: "read", status: "in_progress" });
    await drain();
    await h.reconnect();
    const final = `unseen FINAL ${"answer ".repeat(400)} END`;
    h.complete("before adoption\n\nadopted narration\n\n" + final);
    await h.run;
    expect(h.visible.filter(text => text.includes("adopted narration"))).toHaveLength(1);
    expect(h.visible.join(" ")).not.toContain("before adoption");
    expect(h.visible.join(" ")).toContain("unseen FINAL");
    expect(h.visible.join(" ")).toContain("END");
    expect(h.store.turnAttempts.get("inbound-1")?.deliveryPayload).toMatchObject({
      kind: "messages", texts: h.visible });
  });

  it("retains failed terminal delivery for replay while settling the card", async () => {
    const h = await setup();
    await drain();
    await h.reconnect();
    h.adapter.sendMessage.mockRejectedValue(new Error("Discord transport unavailable"));
    h.complete("unseen final answer");
    await h.run;
    expect(h.visible).toEqual([]);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({
      state: "completed", deliveryDone: false,
      deliveryPayload: { kind: "messages", texts: ["unseen final answer"] },
    });
    expect(h.adapter.editPanel).toHaveBeenLastCalledWith(
      { channel: { platform: "discord", id: "thread" }, id: "card" },
      expect.objectContaining({ title: "Done", fields: expect.arrayContaining([{ name: "Action", value: "end_turn", inline: true }]) }));
  });
});
