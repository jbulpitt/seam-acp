import { afterEach, describe, expect, it, vi } from "vitest";
import { simulateRetiredOwnerProcess } from "./restart-process-fixture.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { acceptReauthWait, REAUTH_WAITING_TEXT, REAUTH_COMPLETED_TEXT } from "../packages/core/src/core/reauth-negotiation.js";
import { listLiveMarkers } from "../packages/core/src/core/dispatch/turn-resume.js";
import type { DeliveryNonceLookup } from "../packages/core/src/platforms/chat-adapter.js";
import { EventEmitter } from "node:events";
import {
  StreamingMessageRenderer,
  streamingMessageChunks,
} from "../packages/core/src/core/streaming-message-renderer.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.restoreAllMocks(); });
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-250-inbound-"));
  cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const now = new Date().toISOString();
  const record = { id: "discord:worker", platform: "discord", channelRef: "worker",
    parentRef: null, agentId: "codex", acpSessionId: "recorded-acp", repoPath: "/synthetic",
    configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  store.admitInbound({ messageId: "1", platform: "discord", channelRef: "worker",
    parentRef: null, sessionRecordId: record.id, authorId: "user", authorName: "User",
    text: "ORIGINAL DISPOSABLE WORK", attachments: [], createdUtc: now });
  store.claimInbound("1", 0, now);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  let onEvent: (event: any) => Promise<void> = async () => {};
  const runtime = {
    onEvent(f: typeof onEvent) { onEvent = f; }, getSessionInfo: () => ({ sessionId: "recorded-acp" }),
    getProcessId: () => undefined, getProviderIdentity: () => "synthetic-codex",
    getFastModeOutcome: () => undefined, getPromptCapabilities: () => ({}),
    prompt: vi.fn(async (_text: string): Promise<{ stopReason: string; cancelled?: boolean }> => {
      entered(); await gate; throw new Error("ACP connection closed");
    }), idle: async () => {}, cancel: async () => {},
  };
  let onRecoveryEvent: (event: any) => Promise<void> = async () => {};
  const recoveryRuntime = {
    onEvent(f: typeof onRecoveryEvent) { onRecoveryEvent = f; },
    idle: async () => {},
    watchInFlightHang: vi.fn(async () => {}),
  };
  const router = { listProfiles: () => [],
    describeConfig: () => ({ agent: { value: "codex" }, model: { value: "test" },
      effort: { value: null }, cwd: { value: "/synthetic" }, location: { value: "local" }, fastMode: { value: false } }),
    ensureSessionRecord: () => ({ ...record }), getProfile: () => undefined,
    getOrStartRuntime: vi.fn(async (_record: unknown, _recovery?: unknown) => runtime),
    adoptRecoveryRuntime: vi.fn(() => recoveryRuntime),
    releaseRecoveryRuntime: vi.fn(),
  };
  const adapter = { sendPanel: vi.fn(async (channel: any) => ({ channel, id: "panel" })),
    sendMessage: vi.fn(async (channel: any, _text: string, _delivery?: { nonce?: string }) => ({ channel, id: "message" })),
    sendFile: vi.fn(async () => {}),
    findMessageByNonce: vi.fn(async (): Promise<DeliveryNonceLookup> => ({ status: "absent" })),
    editPanel: vi.fn(async () => {}), editMessage: vi.fn(async () => {}) };
  const config = { DATA_DIR: dir, REPOS_ROOT: "/synthetic", TURN_TIMEOUT_SECONDS: 60,
    DEFAULT_MODEL: "test", REPO_EMOJIS: new Map(), SEAM_TURN_RESUME_ENABLED: true,
    channelPresets: new Map(), threadPresets: new Map() };
  const make = (bridgeHub?: unknown) => {
    const orch = new Orchestrator({ logger: pino({ level: "silent" }) as any,
      modelCatalog: fixtureModelCatalog([]), store, router: router as any,
      adapter: adapter as any, renderer: discordRenderer as any, config: config as any });
    if (bridgeHub) orch.setBridgeHub(bridgeHub as any);
    vi.spyOn(orch as any, "checkResumePreconditions").mockResolvedValue("ok");
    return orch;
  };
  const orch = make();
  const message = { messageId: "1", channel: { platform: "discord", id: "worker" },
    authorId: "user", authorIsBot: false, text: "ORIGINAL DISPOSABLE WORK" };
  const run = (host = orch) => (host as any).handleIncomingMessageInner(message) as Promise<void>;
  return { dir, store, started, release, runtime, router, adapter, orch, make, run,
    evidence: (evidence: unknown) => onEvent({ kind: "submission-evidence", evidence }),
    fallback: (code: string) => onEvent({ kind: "agy-stdout-fallback", code }),
    emit: (text: string) => onEvent({ kind: "agent-text", text }),
    emitRecovery: (event: any) => onRecoveryEvent(event),
  };
}

describe("#250 human turn production pipeline, synthetic transport only", () => {
  it.each(["inventory", "exit", "error", "connection result"].flatMap(loss =>
    ["before loss", "during retirement"].map(arrival => ({ loss, arrival }))))(
    "lost owner FIFO ($loss) continues before a successor queued $arrival", async ({ loss, arrival }) => {
    const h = setup();
    simulateRetiredOwnerProcess();
    const first = h.run();
    await h.started;
    const attempt = h.store.turnAttempts.get("inbound-1")!;
    h.store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "local", slot: 6,
      submissionId: "submission-6", acpSessionId: "recorded-acp", delegatedUtc: attempt.createdUtc });
    h.orch.suspendForRestart();
    h.release();
    await expect(first).rejects.toMatchObject({ name: "DispatchSuspendedError", suspension: "shutdown" });
    const adopted = Object.assign(new EventEmitter(), { kill: vi.fn(), detach: vi.fn() });
    let ownerAlive = true;
    const mux = {
      sendCmd: vi.fn(async () => ({ health: ownerAlive ? [{ slot: 6, alive: true, attached: true,
        recovery: { version: 1, owner: "bridge", submissionId: "submission-6", acpSessionId: "recorded-acp",
          rung: 1, phase: "executing", retry: 0, budget: 3, remaining: 3, disposition: "none",
          updatedUtc: new Date().toISOString() } }] : [] })),
      adopt: vi.fn(() => adopted),
    };
    const restarted = h.make({ muxFor: () => mux, slotHealthFor: () => [] });
    await restarted.recoverInterruptedTurns();
    await vi.waitFor(() => expect(mux.adopt).toHaveBeenCalledOnce());
    let retire!: () => void;
    const retiring = new Promise<boolean>(resolve => { retire = () => resolve(true); });
    vi.spyOn(restarted as any, "stopLingeringSlot").mockReturnValue(retiring);
    let finishContinuation!: () => void;
    const continued = new Promise<void>(resolve => { finishContinuation = resolve; });
    const prompts: string[] = [];
    h.runtime.prompt.mockImplementation(async text => {
      prompts.push(text);
      if (text.startsWith("continue\n")) await continued;
      return { stopReason: "end_turn" };
    });
    const successorRow = { messageId: "2", platform: "discord", channelRef: "worker", parentRef: null,
      sessionRecordId: "discord:worker", authorId: "user", authorName: "User", text: "FIFO_SUCCESSOR",
      attachments: [], preemptive: false, createdUtc: new Date().toISOString() };
    h.store.admitInbound(successorRow);
    let successor: Promise<void> | undefined;
    const queueSuccessor = () => { successor = (restarted as any).startRecoveredInbound(h.store.getInbound("2")); };
    try {
      if (arrival === "before loss") queueSuccessor();
      ownerAlive = false;
      if (loss === "inventory") await restarted.reconcileRemoteRecoveries();
      else if (loss === "exit") adopted.emit("exit", 1, null);
      else if (loss === "error") adopted.emit("error", new Error("bridge replay disconnected"));
      else adopted.emit("remoteRecoveryResult", { version: 1, submissionId: "submission-6",
        acpSessionId: "recorded-acp", status: "failed", text: "", errorKind: "connection_closed",
        error: "agent child exited", finishedUtc: new Date().toISOString() });
      if (arrival === "during retirement") queueSuccessor();
      for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
      expect(prompts).toEqual([]);
      retire();
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      expect(prompts[0]).toMatch(/^continue\n/);
      expect(prompts[0]).not.toContain("ORIGINAL DISPOSABLE WORK");
      expect(h.router.getOrStartRuntime.mock.calls.at(-1)?.[1]).toEqual({ resumeSessionId: "recorded-acp" });
      expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "active", generation: 2,
        acpSessionId: "recorded-acp" });
      finishContinuation();
      await successor;
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("FIFO_SUCCESSOR");
      expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", generation: 2 });
      expect(h.store.turnAttempts.get("inbound-2")).toMatchObject({ state: "completed", generation: 1 });
    } finally {
      retire();
      finishContinuation();
      await successor;
      for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
      await (restarted as any).channelQueues.get("worker");
      restarted.suspendForRestart();
    }
  });

  it("keeps a pre-shutdown streamed final visible once when the surviving owner settles after adoption", async () => {
    const h = setup();
    const final = "SEAM880_FINAL_" + "x".repeat(900);
    const visible: string[] = [];
    h.adapter.sendMessage.mockImplementation(async (channel, text) => {
      visible.push(text); return { channel, id: `sent-${visible.length}` };
    });
    const first = h.run();
    await h.started;
    const attempt = h.store.turnAttempts.get("inbound-1")!;
    h.store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "remote-one", slot: 6,
      submissionId: "submission-6", acpSessionId: "recorded-acp", delegatedUtc: new Date().toISOString() });
    await h.emit(final + "\n\n");
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(visible).toEqual([final]);
    expect(h.store.turnAttempts.get(attempt.id)?.state).toBe("active");
    h.orch.suspendForRestart(); h.release();
    await expect(first).rejects.toMatchObject({ name: "DispatchSuspendedError", suspension: "shutdown" });
    const adopted = Object.assign(new EventEmitter(), { kill: vi.fn(), detach: vi.fn() });
    const mux = {
      sendCmd: vi.fn(async () => ({ health: [{ slot: 6, alive: true, attached: true, outputAckedThrough: 41,
        recovery: { version: 1, owner: "bridge", submissionId: "submission-6", acpSessionId: "recorded-acp",
          rung: 1, phase: "executing", retry: 0, budget: 3, remaining: 3, disposition: "none",
          updatedUtc: new Date().toISOString() } }] })),
      adopt: vi.fn(() => adopted),
    };
    const restarted = h.make({ muxFor: () => mux, slotHealthFor: () => [] });
    await restarted.recoverInterruptedTurns();
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    let successors = 0;
    const successor = (restarted as any).queueOnChannel("worker", async () => { successors += 1; });
    expect(successors).toBe(0);
    adopted.emit("remoteRecoveryResult", { version: 1, submissionId: "submission-6", acpSessionId: "recorded-acp",
      status: "completed", text: final + "\n\n", stopReason: "end_turn", finishedUtc: new Date().toISOString() });
    await successor;
    expect(visible).toEqual([final]);
    expect(successors).toBe(1);
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(mux.adopt).toHaveBeenCalledWith(6, { allowAppTraffic: true, afterSeq: 41 });
    expect(h.store.turnAttempts.get(attempt.id)).toMatchObject({ state: "completed", generation: 1,
      deliveryDone: true, outcome: { output: final + "\n\n" } });
  });

  it("a saved session reported missing recovers the ordinary human turn with a named notice", async () => {
    const h = setup();
    Object.assign(h.router, { invalidate: vi.fn(async () => {}) });
    const gone = Object.assign(new Error("Internal error"), {
      data: { errorKind: "session_gone", agentId: "codex", details: "no rollout found for recorded-acp" },
    });
    h.router.getOrStartRuntime.mockRejectedValueOnce(gone).mockImplementationOnce(async record => {
      Object.assign(record as object, { acpSessionId: "fresh-acp" });
      h.store.upsert(record as any);
      return { ...h.runtime, getSessionInfo: () => ({ sessionId: "fresh-acp" }) };
    });
    h.runtime.prompt.mockImplementationOnce(async () => {
      await h.emit("fresh answer"); return { stopReason: "end_turn" };
    });
    await h.run();
    expect(h.router.getOrStartRuntime).toHaveBeenCalledTimes(2);
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(h.runtime.prompt.mock.calls[0][0]).toContain("ORIGINAL DISPOSABLE WORK");
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed",
      acpSessionId: "fresh-acp", outcome: { status: "completed" }, deliveryDone: true });
    expect(h.adapter.sendMessage.mock.calls[0][1]).toContain("saved session `recorded-acp`");
    expect(h.adapter.sendMessage.mock.calls[0][1]).toContain("no rollout found for recorded-acp");
    expect(h.adapter.sendMessage.mock.calls.some(([, text]) => text === "fresh answer")).toBe(true);
  });

  it.each([
    { location: "remote-one", notice: undefined },
    { location: "local", notice: "Model fallback: original → sibling; capability unknown; price unknown." },
  ])("#467/#575 adopts $location bridge result after Seam restart without resubmitting", async ({ location, notice }) => {
    const h = setup();
    const attempts = h.store.turnAttempts;
    attempts.registerOwner("pre-restart-owner");
    const attempt = attempts.claim({
      id: "inbound-1",
      target: "worker",
      prompt: "ORIGINAL DISPOSABLE WORK",
      session: "live",
      kind: "parked",
      createdUtc: new Date().toISOString(),
    }, "synthetic-identity", "pre-restart-owner", "inbound");
    attempts.bind(attempt, "recorded-acp");
    attempts.bindStatusCard(attempt, {
      channelId: "worker",
      messageId: "persisted-panel",
    });
    attempts.startPrompt(attempt);
    expect(attempts.recordRemoteRecovery(attempt, {
      version: 1,
      location,
      slot: 6,
      submissionId: "submission-6",
      acpSessionId: "recorded-acp",
      delegatedUtc: "2026-09-22T12:00:00.000Z",
      ...(notice ? { modelFallbackNotice: notice } : {}),
    })).toBe(true);
    expect(attempts.suspendBoot("pre-restart-owner")).toBe(1);

    const adopted = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> };
    adopted.kill = vi.fn();
    adopted.detach = vi.fn();
    const mux = {
      sendCmd: vi.fn(async () => ({ health: [{
        slot: 6,
        alive: true,
        recovery: {
          version: 1,
          owner: "bridge",
          submissionId: "submission-6",
          acpSessionId: "recorded-acp",
          rung: 1,
          phase: "succeeded",
          retry: 1,
          budget: 3,
          remaining: 2,
          disposition: "none",
          terminalReason: "completed",
          updatedUtc: "2026-09-22T12:01:00.000Z",
        },
      }] })),
      adopt: vi.fn(() => {
        queueMicrotask(() => adopted.emit("remoteRecoveryResult", {
          version: 1,
          submissionId: "submission-6",
          acpSessionId: "recorded-acp",
          status: "completed",
          text: "result completed while Seam was restarting",
          stopReason: "end_turn",
          finishedUtc: "2026-09-22T12:01:00.000Z",
        }));
        return adopted;
      }),
    };
    const bridgeHub = { muxFor: (requested: string) => requested === location ? mux : undefined,
      slotHealthFor: () => [] };

    const restarted = h.make(bridgeHub);
    await restarted.recoverInterruptedTurns();
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(mux.adopt).toHaveBeenCalledWith(6, { allowAppTraffic: true });
    expect(h.router.adoptRecoveryRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: "discord:worker" }), adopted, "recorded-acp"
    );
    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(h.adapter.sendMessage).toHaveBeenCalledTimes(1);
    const output = `${notice ? `${notice}\n\n` : ""}result completed while Seam was restarting`;
    expect(h.adapter.sendMessage.mock.calls[0]?.[1]).toBe(output);
    expect(attempts.get("inbound-1")).toMatchObject({
      state: "completed",
      deliveryDone: true,
      outcome: { output },
    });
    expect(h.store.getInbound("1")?.state).toBe("completed");
    await vi.waitFor(() => expect(adopted.kill).toHaveBeenCalledTimes(1));
    expect(h.router.releaseRecoveryRuntime).toHaveBeenCalledWith(
      "discord:worker", expect.any(Object), false
    );
    expect(h.adapter.editPanel).toHaveBeenCalledWith(
      { channel: { platform: "discord", id: "worker" }, id: "persisted-panel" },
      expect.objectContaining({ title: "Done", fields: expect.arrayContaining([{ name: "Action", value: "end_turn", inline: true }]) })
    );
    // The restart path owns delivery, settlement, and the original card.
  });

  it("#702 resumes adopted text and tool status without replaying acknowledged output", async () => {
    const h = setup();
    const attempts = h.store.turnAttempts;
    attempts.registerOwner("pre-restart-owner");
    const attempt = attempts.claim({
      id: "inbound-1",
      target: "worker",
      prompt: "ORIGINAL DISPOSABLE WORK",
      session: "live",
      kind: "parked",
      createdUtc: new Date().toISOString(),
    }, "synthetic-identity", "pre-restart-owner", "inbound");
    attempts.bind(attempt, "recorded-acp");
    attempts.bindStatusCard(attempt, { channelId: "worker", messageId: "persisted-panel" });
    attempts.startPrompt(attempt);
    expect(attempts.recordRemoteRecovery(attempt, {
      version: 1,
      location: "remote-one",
      slot: 6,
      submissionId: "submission-6",
      acpSessionId: "recorded-acp",
      delegatedUtc: "2026-09-22T12:00:00.000Z",
    })).toBe(true);
    expect(attempts.suspendBoot("pre-restart-owner")).toBe(1);

    const alreadyVisible = "before restart\n\n";
    const resumedFirst = `${"A".repeat(2100)}\n\n`;
    const resumedLast = `${"B".repeat(2200)} done`;
    const resumedText = resumedFirst + resumedLast;
    const adopted = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> };
    adopted.kill = vi.fn();
    adopted.detach = vi.fn();
    const mux = {
      sendCmd: vi.fn(async () => ({ health: [{
        slot: 6,
        alive: true,
        outputAckedThrough: 41,
        recovery: {
          version: 1,
          owner: "bridge",
          submissionId: "submission-6",
          acpSessionId: "recorded-acp",
          rung: 1,
          phase: "executing",
          retry: 0,
          budget: 3,
          remaining: 3,
          disposition: "none",
          updatedUtc: "2026-09-22T12:01:00.000Z",
        },
      }] })),
      adopt: vi.fn(() => {
        queueMicrotask(async () => {
          await h.emitRecovery({ kind: "agent-text", text: resumedFirst });
          await h.emitRecovery({ kind: "tool-start", toolCallId: "tool-1", title: "Read file" });
          await h.emitRecovery({ kind: "tool-update", toolCallId: "tool-1", status: "completed" });
          await h.emitRecovery({ kind: "agent-text", text: resumedLast });
          adopted.emit("remoteRecoveryResult", {
            version: 1,
            submissionId: "submission-6",
            acpSessionId: "recorded-acp",
            status: "completed",
            text: alreadyVisible + resumedText,
            stopReason: "end_turn",
            finishedUtc: "2026-09-22T12:02:00.000Z",
          });
        });
        return adopted;
      }),
    };
    const visible: string[] = [];
    const nonces = new Map<string, { channel: any; id: string }>();
    h.adapter.sendMessage.mockImplementation(async (channel: any, text: string, delivery?: { nonce?: string }) => {
      const nonce = delivery?.nonce;
      if (nonce && nonces.has(nonce)) return nonces.get(nonce)!;
      const ref = { channel, id: `message-${visible.length}` };
      visible.push(text);
      if (nonce) nonces.set(nonce, ref);
      return ref;
    });
    const restarted = h.make({
      muxFor: (requested: string) => requested === "remote-one" ? mux : undefined,
      slotHealthFor: () => [],
    });

    await restarted.recoverInterruptedTurns();
    await vi.waitFor(() => expect(attempts.get("inbound-1")?.state).toBe("completed"));

    expect(mux.adopt).toHaveBeenCalledWith(6, {
      allowAppTraffic: true,
      afterSeq: 41,
    });
    const expectedVisible: string[] = [];
    const expectedRenderer = new StreamingMessageRenderer(async (text) => {
      expectedVisible.push(text);
    });
    expectedRenderer.feed(resumedFirst);
    await expectedRenderer.flush();
    expectedRenderer.feed(resumedLast);
    await expectedRenderer.finalize();
    expect(visible).toEqual(expectedVisible);
    expect(visible).not.toContain(alreadyVisible);
    expect(visible.every((text) => text.length <= 1800)).toBe(true);
    expect(attempts.get("inbound-1")).toMatchObject({
      state: "completed",
      deliveryDone: true,
      deliveryPayload: { kind: "messages", texts: visible },
      outcome: { output: alreadyVisible + resumedText },
    });
    expect(h.adapter.editPanel).toHaveBeenCalledWith(
      { channel: { platform: "discord", id: "worker" }, id: "persisted-panel" },
      expect.objectContaining({ description: expect.stringContaining("Read file") })
    );
    expect(h.adapter.editPanel).toHaveBeenLastCalledWith(
      { channel: { platform: "discord", id: "worker" }, id: "persisted-panel" },
      expect.objectContaining({ title: "Done", fields: expect.arrayContaining([{ name: "Action", value: "end_turn", inline: true }]) })
    );
  });

  // #536: deleting the inbound hook must lose the new snapshot, not silently pass on the initial intent alone.
  it("records inbound submission observations on the existing receipt", async () => {
    const h = setup();
    h.runtime.prompt.mockImplementation((async (...args: any[]) => {
      const evidence = args[2].submissionEvidence;
      expect(h.store.turnAttempts.get("inbound-1")!.submissions).toMatchObject([{ id: evidence.id, phase: "intent" }]);
      await h.evidence({ ...evidence, revision: 1, phase: "rpc_invoked", outcome: "completed" });
      return { stopReason: "end_turn" };
    }) as any);
    await h.run();
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed",
      submissions: [{ phase: "rpc_invoked", outcome: "completed", acceptance: { state: "unknown" } }] });
  });
  it("#545 records an inbound fallback without changing successful settlement", async () => {
    const h = setup();
    h.runtime.prompt.mockImplementation(async () => {
      await h.fallback("unimplemented");
      await h.emit("stdout answer");
      return { stopReason: "end_turn" };
    });
    await h.run();
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed",
      stdoutFallback: { count: 1, reasons: { unimplemented: 1 } } });
  });
  it("does not let a stale epoch or superseded invocation release input", () => {
    const h = setup();
    expect(h.store.releaseUnstartedInbound("1", 1, new Date().toISOString())).toBe(false);
    expect(h.store.getInbound("1")?.state).toBe("running");
    expect(h.store.releaseUnstartedInbound("1", 0, new Date().toISOString())).toBe(true);
    h.store.claimInbound("1", 2, new Date().toISOString());
    const old = h.store.getInbound("1")!;
    h.store.admitInbound({ ...old, messageId: "2", text: "replacement" });
    expect(h.store.releaseUnstartedInbound("1", 2, new Date().toISOString())).toBe(false);
    expect(h.store.getInbound("1")?.state).toBe("completed");
    expect(h.store.getInbound("2")?.state).toBe("pending");
  });

  it.each(["active", "suspended", "completed", "cancelled"] as const)("never releases input owned by an existing %s attempt", state => {
    const h = setup();
    const attempts = h.store.turnAttempts;
    attempts.registerOwner("synthetic-owner");
    const a = attempts.claim({ id: "inbound-1", target: "worker", prompt: "synthetic",
      session: "live", kind: "parked", createdUtc: new Date().toISOString() }, "synthetic-identity", "synthetic-owner", "inbound");
    if (state === "suspended") attempts.suspendBoot("synthetic-owner");
    if (state === "completed") attempts.complete(a, { id: a.id, target: "worker", status: "completed", finishedUtc: new Date().toISOString() });
    if (state === "cancelled") attempts.cancel(a.id);
    expect(h.store.releaseUnstartedInbound("1", 0, new Date().toISOString())).toBe(false);
    expect(h.store.getInbound("1")?.state).toBe("running");
    expect(attempts.get(a.id)?.state).toBe(state);
  });

  it("retains a recovered pre-attempt setup failure without a retry loop", async () => {
    const h = setup();
    h.store.admitInbound({ ...h.store.getInbound("1")!, messageId: "2", text: "never submitted" });
    vi.spyOn(h.router, "ensureSessionRecord").mockImplementationOnce(() => { throw new Error("synthetic recovery setup failure"); });
    await h.orch.recoverInterruptedTurns();
    await (h.orch as any).channelQueues.get("worker");
    expect(h.store.getInbound("2")).toMatchObject({ state: "pending", queueEpoch: null });
    expect(h.store.turnAttempts.get("inbound-2")).toBeNull();
    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["record", "config", "read-config"])("retains admitted input after pre-attempt %s failure and starts it once on recovery", async stage => {
    const h = setup();
    const record = h.router.ensureSessionRecord();
    if (stage === "record") vi.spyOn(h.router, "ensureSessionRecord")
      .mockReturnValueOnce(record).mockImplementationOnce(() => { throw new Error("synthetic pre-attempt failure"); });
    if (stage === "config") vi.spyOn(h.router, "describeConfig")
      .mockImplementationOnce(() => { throw new Error("synthetic pre-attempt failure"); });
    if (stage === "read-config") vi.spyOn(h.store, "readConfig")
      .mockImplementationOnce(() => { throw new Error("synthetic pre-attempt failure"); });
    const msg = { messageId: "2", channel: { platform: "discord", id: "worker" },
      authorId: "user", authorIsBot: false, text: "NEW NEVER-SUBMITTED DISPOSABLE WORK" };
    await (h.orch as any).handleIncomingMessage(msg);
    expect(h.store.getInbound("2")).toMatchObject({ state: "pending", queueEpoch: null, text: msg.text });
    expect(h.store.turnAttempts.get("inbound-2")).toBeNull();
    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    h.runtime.prompt.mockImplementationOnce(async () => ({ stopReason: "end_turn" }));
    const next = h.make();
    await next.recoverInterruptedTurns();
    await (next as any).channelQueues.get("worker");
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(h.runtime.prompt.mock.calls[0]?.[0]).toContain(msg.text);
    expect(h.store.turnAttempts.get("inbound-2")).toMatchObject({ state: "completed", promptStarted: true });
    expect(h.store.getInbound("2")?.state).toBe("completed");
  });

  it("retains the inbound execution and marker on cutoff, then submits only continue to the same ACP", async () => {
    const h = setup();
    // In-process boot simulation; real PID retirement has separate offline tests.
    simulateRetiredOwnerProcess();
    const first = h.run(); await h.started;
    h.orch.suspendForRestart(); h.release();
    await expect(first).rejects.toMatchObject({ name: "DispatchSuspendedError", suspension: "shutdown" });
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "suspended", promptStarted: true, acpSessionId: "recorded-acp" });
    expect((await listLiveMarkers(h.dir))[0]).toMatchObject({ inboundMessageId: "1", promptStarted: true });
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    h.runtime.prompt.mockImplementationOnce(async () => { await h.emit("final answer"); return { stopReason: "end_turn" }; });
    await h.run(h.make());
    expect(String(h.runtime.prompt.mock.calls[1]?.[0]).startsWith("continue\n")).toBe(true);
    expect(String(h.runtime.prompt.mock.calls[1]?.[0])).toContain("The process restarted while the turn was in flight.");
    expect(String(h.runtime.prompt.mock.calls[1]?.[0])).not.toContain("NEW NEVER-SUBMITTED");
    expect(h.router.getOrStartRuntime.mock.calls.at(-1)?.[1]).toEqual({ resumeSessionId: "recorded-acp" });
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", generation: 2, deliveryDone: true });
    // Protects the durable card binding: deleting it posts a replacement panel
    // after restart and leaves the original admission card permanently amber.
    expect(h.adapter.sendPanel).toHaveBeenCalledTimes(1);
    expect(await listLiveMarkers(h.dir)).toEqual([]);
  });

  it.each([false, true])("a missing retained auth owner continues only after acceptance (accepted at boot=%s)", async accepted => {
    const h = setup();
    simulateRetiredOwnerProcess();
    const first = h.run();
    await h.started;
    const attempt = h.store.turnAttempts.get("inbound-1")!;
    h.store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "local", slot: 19,
      submissionId: "auth-submission", acpSessionId: "recorded-acp", delegatedUtc: attempt.createdUtc });
    h.orch.suspendForRestart();
    h.release();
    await expect(first).rejects.toMatchObject({ name: "DispatchSuspendedError", suspension: "shutdown" });
    h.store.turnAttempts.markStalled(attempt.id, accepted ? REAUTH_COMPLETED_TEXT : REAUTH_WAITING_TEXT);
    h.runtime.prompt.mockClear();
    h.router.getOrStartRuntime.mockClear();
    h.runtime.prompt.mockImplementationOnce(async () => ({ stopReason: "end_turn" }));
    const mux = { sendCmd: vi.fn(async () => ({ health: [] })), sendFrame: vi.fn() };
    const next = h.make({ muxFor: () => mux, slotHealthFor: () => [], onBridgeReady: () => () => {} });
    const resume = vi.spyOn(next, "resumeTurnManually");
    await next.recoverInterruptedTurns();
    await next.reconcileRemoteRecoveries();
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    if (!accepted) {
      expect(h.store.turnAttempts.get(attempt.id)).toMatchObject({ state: "suspended", generation: 1,
        stalledReason: REAUTH_WAITING_TEXT, acpSessionId: "recorded-acp", outcome: null });
      expect(h.runtime.prompt).not.toHaveBeenCalled();
      expect(h.router.getOrStartRuntime).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(acceptReauthWait(h.store.turnAttempts, attempt.id)).not.toBeNull();
      await (next as any).continueAcceptedReauth(attempt.id);
    }
    await vi.waitFor(() => expect(h.store.turnAttempts.get(attempt.id)?.state).toBe("completed"));
    await next.reconcileRemoteRecoveries();
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(h.runtime.prompt.mock.calls[0]?.[0]).toMatch(/^continue\n/);
    expect(h.runtime.prompt.mock.calls[0]?.[0]).not.toContain("ORIGINAL DISPOSABLE WORK");
    expect(h.router.getOrStartRuntime.mock.calls[0]?.[1]).toEqual({ resumeSessionId: "recorded-acp" });
    expect(h.store.turnAttempts.get(attempt.id)).toMatchObject({ generation: 2, acpSessionId: "recorded-acp",
      outcome: { status: "completed" } });
    expect(mux.sendFrame).not.toHaveBeenCalled();
    next.suspendForRestart();
  });

  it("a queued accepted continuation released at cutoff leaves admission, generation and cause unchanged", async () => {
    const h = setup();
    const first = h.run();
    await h.started;
    const attempt = h.store.turnAttempts.get("inbound-1")!;
    h.store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "local", slot: 19,
      submissionId: "auth-submission", acpSessionId: "recorded-acp", delegatedUtc: attempt.createdUtc });
    h.orch.suspendForRestart();
    h.release();
    await expect(first).rejects.toMatchObject({ name: "DispatchSuspendedError", suspension: "shutdown" });
    h.store.turnAttempts.markStalled(attempt.id, REAUTH_COMPLETED_TEXT);
    const next = h.make();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const adoption = (next as any).queueOnChannel("worker", () => held);
    (next as any).remoteAdoptionWaiters.set(attempt.id, release);
    const pending = h.store.recoverInboundChannel("worker", new Date().toISOString())!;
    const before = h.store.turnAttempts.get(attempt.id)!;
    const admission = h.store.getInbound("1");
    const queued = (next as any).startRecoveredInbound(pending);
    next.suspendForRestart();
    await adoption;
    await queued;
    expect(h.store.turnAttempts.get(attempt.id)).toEqual(before);
    expect(h.store.getInbound("1")).toEqual(admission);
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    await expect(h.run(next)).rejects.toMatchObject({ suspension: "shutdown" });
    expect(h.store.turnAttempts.get(attempt.id)).toMatchObject({
      state: before.state, generation: before.generation, ownerBoot: before.ownerBoot,
      stalledReason: before.stalledReason, stalledUtc: before.stalledUtc,
      acpSessionId: before.acpSessionId, remoteRecovery: before.remoteRecovery,
      outcome: before.outcome,
    });
    expect(h.store.getInbound("1")).toEqual(admission);
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
  });

  it("projects a terminal durable outcome onto its persisted card with no live panel", async () => {
    const h = setup();
    const attempts = h.store.turnAttempts;
    attempts.registerOwner("pre-restart-owner");
    const attempt = attempts.claim({
      id: "inbound-1",
      target: "worker",
      prompt: "ORIGINAL DISPOSABLE WORK",
      session: "live",
      kind: "parked",
      createdUtc: new Date().toISOString(),
    }, "synthetic-identity", "pre-restart-owner", "inbound");
    (attempts as unknown as {
      bindStatusCard(a: typeof attempt, ref: { channelId: string; messageId: string }): void;
    }).bindStatusCard(attempt, { channelId: "worker", messageId: "persisted-panel" });
    expect(attempts.complete(attempt, {
      id: attempt.id,
      target: "worker",
      status: "completed",
      stopReason: "end_turn",
      finishedUtc: new Date().toISOString(),
    })).toBe(true);
    attempts.markDeliveryDone(attempt.id);
    h.adapter.sendPanel.mockClear();
    h.adapter.editPanel.mockClear();

    await h.make().recoverInterruptedTurns();

    // Protects the restart-only route from depending on an in-memory
    // TurnStatus: the new process did not create a panel, yet the exact
    // persisted Discord message received the ledger's immutable outcome.
    expect(h.adapter.sendPanel).not.toHaveBeenCalled();
    expect(h.adapter.editPanel).toHaveBeenCalledWith(
      { channel: { platform: "discord", id: "worker" }, id: "persisted-panel" },
      expect.objectContaining({ title: "Done", fields: expect.arrayContaining([{ name: "Action", value: "end_turn", inline: true }]) })
    );
    expect(h.store.getInbound("1")?.state).toBe("completed");
  });

  it("does not transparently replay an owned original prompt on transport failure", async () => {
    const h = setup(); const first = h.run(); await h.started; h.release(); await first;
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", outcome: { status: "failed" } });
  });

  it("records a visible terminal outcome when a #308 rule refuses after claim", async () => {
    const h = setup();
    const refusal =
      'Refused: agent "codex" cannot run in channel "worker" because its channel rule is unreadable.';
    h.router.getOrStartRuntime.mockRejectedValueOnce(new Error(refusal));

    await h.run();

    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({
      state: "completed",
      promptStarted: false,
      outcome: { status: "failed", error: refusal },
    });
    expect(h.adapter.sendMessage).toHaveBeenCalledWith(expect.anything(), "The turn failed before its response was delivered.");
    // Removing executeIncomingMessage's owned-error completion leaves this
    // claimed turn active with no visible refusal until a future restart.
  });

  it("captured output beats cutoff while delivery is held and never pays for a second turn", async () => {
    const h = setup();
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    h.runtime.prompt.mockImplementationOnce(async () => { await h.emit("finished answer"); return { stopReason: "end_turn" }; });
    h.adapter.sendMessage.mockImplementationOnce(async channel => { entered(); await gate; return { channel, id: "sent" }; });
    const first = h.run(); await started;
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: false });
    h.orch.suspendForRestart(); release(); await first;
    h.adapter.findMessageByNonce.mockResolvedValueOnce({
      status: "found",
      message: { channel: { platform: "discord", id: "worker" }, id: "sent" },
    });
    await h.run(h.make());
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(h.store.turnAttempts.get("inbound-1")?.deliveryDone).toBe(true);
    // Protects the send/SQLite-ack crash window; deleting nonce lookup causes a
    // second visible result despite Discord already accepting the first.
    expect(h.adapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("recovers captured output after a delivery failure without provider reentry", async () => {
    const h = setup();
    h.runtime.prompt.mockImplementationOnce(async () => { await h.emit("saved answer"); return { stopReason: "end_turn" }; });
    h.adapter.sendMessage.mockRejectedValue(new Error("synthetic Discord outage"));
    await h.run().catch(() => {});
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: false });
    h.adapter.sendMessage.mockImplementation(async channel => ({ channel, id: "recovered" }));
    await h.make().recoverInterruptedTurns();
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(h.adapter.sendMessage.mock.calls.at(-1)?.[1]).toBe("saved answer");
    expect(h.store.getInbound("1")?.state).toBe("completed");
    expect(h.store.turnAttempts.get("inbound-1")?.deliveryDone).toBe(true);
    const firstDelivery = h.adapter.sendMessage.mock.calls[0]?.[2];
    const replayDelivery = h.adapter.sendMessage.mock.calls.at(-1)?.[2];
    // Protects server-side dedup on the lookup/replay race; deleting this
    // equality reintroduces at-least-once duplicate delivery.
    expect(replayDelivery).toEqual(firstDelivery);
    expect(replayDelivery).toMatchObject({ enforceNonce: true });
  });

  it("#702 splits an existing oversized recorded payload during boot replay", async () => {
    const h = setup();
    const attempts = h.store.turnAttempts;
    attempts.registerOwner("old-owner");
    const attempt = attempts.claim({
      id: "inbound-1", target: "worker", prompt: "legacy", session: "live",
      kind: "parked", createdUtc: new Date().toISOString(),
    }, "synthetic-identity", "old-owner", "inbound");
    const body = `${"first paragraph. ".repeat(160)}\n\n${"second paragraph. ".repeat(160)}`;
    attempts.complete(attempt, {
      id: attempt.id,
      target: "worker",
      status: "completed",
      output: body,
      finishedUtc: new Date().toISOString(),
    });
    attempts.prepareDelivery(attempt.id, "worker", { kind: "message", text: body });
    h.adapter.findMessageByNonce.mockResolvedValue({ status: "absent" });
    const sent: Array<{ text: string; nonce?: string }> = [];
    h.adapter.sendMessage.mockImplementation(async (channel: any, text: string, delivery?: { nonce?: string }) => {
      sent.push({ text, nonce: delivery?.nonce });
      return { channel, id: `replayed-${sent.length}` };
    });

    await h.make().recoverInterruptedTurns();

    expect(sent.length).toBeGreaterThan(1);
    expect(sent.map(({ text }) => text)).toEqual(await streamingMessageChunks(body));
    expect(sent.every(({ text }) => text.length <= 1800)).toBe(true);
    expect(new Set(sent.map(({ nonce }) => nonce)).size).toBe(sent.length);
    expect(attempts.get(attempt.id)?.deliveryDone).toBe(true);
    expect(h.runtime.prompt).not.toHaveBeenCalled();
  });

  it("#702 replays only missing chunks from a partially accepted payload", async () => {
    const h = setup();
    const attempts = h.store.turnAttempts;
    attempts.registerOwner("old-owner");
    const attempt = attempts.claim({
      id: "inbound-1", target: "worker", prompt: "legacy", session: "live",
      kind: "parked", createdUtc: new Date().toISOString(),
    }, "synthetic-identity", "old-owner", "inbound");
    const body = `${"accepted prefix. ".repeat(150)}\n\n${"missing suffix. ".repeat(150)}`;
    attempts.complete(attempt, {
      id: attempt.id,
      target: "worker",
      status: "completed",
      output: body,
      finishedUtc: new Date().toISOString(),
    });
    attempts.prepareDelivery(attempt.id, "worker", { kind: "message", text: body });
    const chunks = await streamingMessageChunks(body);
    h.adapter.findMessageByNonce
      .mockResolvedValueOnce({
        status: "found",
        message: { channel: { platform: "discord", id: "worker" }, id: "accepted" },
      })
      .mockResolvedValue({ status: "absent" });
    const sent: string[] = [];
    h.adapter.sendMessage.mockImplementation(async (channel: any, text: string) => {
      sent.push(text);
      return { channel, id: `replayed-${sent.length}` };
    });

    await h.make().recoverInterruptedTurns();

    expect(h.adapter.findMessageByNonce).toHaveBeenCalledTimes(chunks.length);
    expect(sent).toEqual(chunks.slice(1));
    expect(attempts.get(attempt.id)?.deliveryDone).toBe(true);
    expect(h.runtime.prompt).not.toHaveBeenCalled();
  });

  it("confirms a Discord-accepted nonce after crashing before delivery acknowledgments", async () => {
    const h = setup();
    h.runtime.prompt.mockImplementationOnce(async () => {
      await h.emit("accepted exactly once");
      return { stopReason: "end_turn" };
    });
    vi.spyOn(h.store.turnAttempts, "acknowledgeStreamDelivery").mockImplementationOnce(() => {});
    const realMark = h.store.turnAttempts.markDeliveryDone.bind(h.store.turnAttempts);
    vi.spyOn(h.store.turnAttempts, "markDeliveryDone")
      .mockImplementationOnce(() => { throw new Error("synthetic crash after Discord accept"); })
      .mockImplementation(realMark);

    await expect(h.run()).rejects.toThrow("synthetic crash after Discord accept");
    const receipt = h.store.turnAttempts.get("inbound-1")!;
    expect(receipt).toMatchObject({
      state: "completed",
      deliveryDone: false,
      deliveryPayload: { kind: "messages", texts: ["accepted exactly once"], stream: { delivered: 0 } },
    });
    h.adapter.findMessageByNonce.mockResolvedValueOnce({
      status: "found",
      message: { channel: { platform: "discord", id: "worker" }, id: "accepted" },
    });

    await h.make().recoverInterruptedTurns();

    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(h.adapter.findMessageByNonce).toHaveBeenCalledWith(
      { platform: "discord", id: "worker" },
      receipt.deliveryNonce,
      expect.any(Number)
    );
    // Protects against replay after Discord accepted but SQLite did not; if
    // deleted, this exact crash produces the duplicate described in #305.
    expect(h.adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.store.turnAttempts.get("inbound-1")?.deliveryDone).toBe(true);
    expect(h.store.getInbound("1")?.state).toBe("completed");
  });

  it("explicitly abandons a legacy captured result that has no nonce receipt", async () => {
    const h = setup();
    const attempt = h.store.turnAttempts.get("inbound-1");
    expect(attempt).toBeNull();
    h.store.turnAttempts.registerOwner("legacy-boot");
    const legacy = h.store.turnAttempts.claim({
      id: "inbound-1", target: "worker", prompt: "legacy", session: "live",
      kind: "parked", createdUtc: new Date().toISOString(),
    }, "legacy-identity", "legacy-boot", "inbound");
    h.store.turnAttempts.complete(legacy, {
      id: legacy.id, target: "worker", status: "completed", output: "maybe sent",
      finishedUtc: new Date().toISOString(),
    });
    // Simulate a pre-#305 row: the migration defaults existing attempts to 0.
    (h.store as any).db.prepare("UPDATE turn_attempts SET delivery_protocol=0 WHERE id=?").run(legacy.id);

    await h.make().recoverInterruptedTurns();

    expect(h.store.turnAttempts.get(legacy.id)).toMatchObject({
      deliveryDone: false,
      deliveryAbandonedReason: expect.stringContaining("predates nonce-backed"),
    });
    expect(h.store.getInbound("1")?.state).toBe("completed");
    // Protects legacy users from an unprovable duplicate; deleting this check
    // turns old ambiguity into an unsolicited replay.
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("retains an indeterminate Discord history search as visible uncertainty", async () => {
    const h = setup();
    h.runtime.prompt.mockImplementationOnce(async () => {
      await h.emit("accepted but too old to scan");
      return { stopReason: "end_turn" };
    });
    vi.spyOn(h.store.turnAttempts, "acknowledgeStreamDelivery").mockImplementationOnce(() => {});
    const realMark = h.store.turnAttempts.markDeliveryDone.bind(h.store.turnAttempts);
    vi.spyOn(h.store.turnAttempts, "markDeliveryDone")
      .mockImplementationOnce(() => { throw new Error("synthetic post-send crash"); })
      .mockImplementation(realMark);
    await h.run().catch(() => {});
    h.adapter.findMessageByNonce.mockResolvedValueOnce({
      status: "indeterminate",
      reason: "Discord nonce search exceeded 5000 messages",
    });

    const recovered = h.make();
    await recovered.recoverInterruptedTurns();
    const attempt = h.store.turnAttempts.get("inbound-1")!;
    expect(h.store.turnAttempts.isDeliveryProven(attempt.id)).toBe(false);
    expect(h.store.turnAttempts.isDeliveryDispositionTerminal(attempt.id)).toBe(true);
    expect(attempt.deliveryAbandonedReason).toBeNull();
    expect(attempt.deliveryUncertainReason).toBe("Discord nonce search exceeded 5000 messages");
    const inventory = await (recovered as any).collectInterruptedRows();
    // Protects operator visibility for bounded-search exhaustion; deleting it
    // turns a retained uncertainty into an invisible recurring warning.
    expect(inventory).toContainEqual(expect.objectContaining({
      id: "inbound-1",
      status: "interrupted",
      reason: "Discord nonce search exceeded 5000 messages",
    }));
    await h.make().recoverInterruptedTurns();
    // Protects the bounded refusal from repeated 5,000-message scans; deleting
    // the durable uncertain state re-runs the same inconclusive query each boot.
    expect(h.adapter.findMessageByNonce).toHaveBeenCalledTimes(1);
    expect(h.adapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("new user input durably cancels the old execution before its late outcome", async () => {
    const h = setup(); const first = h.run(); await h.started;
    const old = h.store.getInbound("1")!;
    h.store.admitInbound({ ...old, messageId: "2", text: "replacement", createdUtc: new Date().toISOString() });
    h.release();
    await expect(first).rejects.toMatchObject({ name: "DispatchSuspendedError", suspension: "superseded" });
    expect(h.store.turnAttempts.get("inbound-1")?.state).toBe("cancelled");
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    expect(h.store.getInbound("1")?.state).toBe("completed");
  });

  it("retains a suspended turn when its current thread ACP differs, without a prompt or load", async () => {
    const h = setup();
    simulateRetiredOwnerProcess();
    const first = h.run(); await h.started; h.orch.suspendForRestart(); h.release();
    await expect(first).rejects.toMatchObject({ name: "DispatchSuspendedError", suspension: "shutdown" });
    const current = h.router.ensureSessionRecord();
    h.router.ensureSessionRecord = () => ({ ...current, acpSessionId: "different-session" });
    await expect(h.run(h.make())).rejects.toMatchObject({ name: "DispatchSuspendedError" });
    expect(h.store.turnAttempts.get("inbound-1")?.state).toBe("suspended");
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(h.router.getOrStartRuntime).toHaveBeenCalledTimes(1);
  });

  it("captures a genuine initial-panel failure before any provider work", async () => {
    const h = setup();
    h.adapter.sendPanel.mockRejectedValueOnce(new Error("synthetic panel failure"));
    await expect(h.run()).rejects.toThrow("synthetic panel failure");
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", promptStarted: false, deliveryDone: false });
    expect(h.runtime.prompt).not.toHaveBeenCalled();
  });

  it("a failed durable completion write cannot announce a terminal outcome", async () => {
    const h = setup();
    h.runtime.prompt.mockImplementationOnce(async () => { await h.emit("must remain recoverable"); return { stopReason: "end_turn" }; });
    vi.spyOn(h.store.turnAttempts, "complete").mockImplementation(() => { throw new Error("synthetic SQLite failure"); });
    await expect(h.run()).rejects.toThrow("synthetic SQLite failure");
    expect(h.store.turnAttempts.get("inbound-1")?.state).toBe("active");
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    expect(await listLiveMarkers(h.dir)).toHaveLength(1);
  });
});
