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
import { listLiveMarkers } from "../packages/core/src/core/dispatch/turn-resume.js";

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
  const router = { listProfiles: () => [],
    describeConfig: () => ({ agent: { value: "codex" }, model: { value: "test" },
      effort: { value: null }, cwd: { value: "/synthetic" }, location: { value: "local" }, fastMode: { value: false } }),
    ensureSessionRecord: () => ({ ...record }), getProfile: () => undefined,
    getOrStartRuntime: vi.fn(async (_record: unknown, _recovery?: unknown) => runtime),
  };
  const adapter = { sendPanel: vi.fn(async (channel: any) => ({ channel, id: "panel" })),
    sendMessage: vi.fn(async (channel: any, _text: string) => ({ channel, id: "message" })),
    sendFile: vi.fn(async () => {}),
    findMessageByNonce: vi.fn(async () => ({ status: "absent" as const })),
    editPanel: vi.fn(async () => {}), editMessage: vi.fn(async () => {}) };
  const config = { DATA_DIR: dir, REPOS_ROOT: "/synthetic", TURN_TIMEOUT_SECONDS: 60,
    DEFAULT_MODEL: "test", REPO_EMOJIS: new Map(), SEAM_TURN_RESUME_ENABLED: true,
    channelPresets: new Map(), threadPresets: new Map() };
  const make = () => {
    const orch = new Orchestrator({ logger: pino({ level: "silent" }) as any,
      modelCatalog: fixtureModelCatalog([]), store, router: router as any,
      adapter: adapter as any, renderer: discordRenderer as any, config: config as any });
    vi.spyOn(orch as any, "checkResumePreconditions").mockResolvedValue("ok");
    return orch;
  };
  const orch = make();
  const message = { messageId: "1", channel: { platform: "discord", id: "worker" },
    authorId: "user", authorIsBot: false, text: "ORIGINAL DISPOSABLE WORK" };
  const run = (host = orch) => (host as any).handleIncomingMessageInner(message) as Promise<void>;
  return { dir, store, started, release, runtime, router, adapter, orch, make, run,
    emit: (text: string) => onEvent({ kind: "agent-text", text }) };
}

describe("#250 human turn production pipeline, synthetic transport only", () => {
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
    h.orch.suspendForRestart(); h.release(); await first;
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "suspended", promptStarted: true, acpSessionId: "recorded-acp" });
    expect((await listLiveMarkers(h.dir))[0]).toMatchObject({ inboundMessageId: "1", promptStarted: true });
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    h.runtime.prompt.mockImplementationOnce(async () => { await h.emit("final answer"); return { stopReason: "end_turn" }; });
    await h.run(h.make());
    expect(h.runtime.prompt.mock.calls[1]?.[0]).toBe("continue");
    expect(h.router.getOrStartRuntime.mock.calls.at(-1)?.[1]).toEqual({ resumeSessionId: "recorded-acp" });
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", generation: 2, deliveryDone: true });
    expect(await listLiveMarkers(h.dir)).toEqual([]);
  });

  it("does not transparently replay an owned original prompt on transport failure", async () => {
    const h = setup(); const first = h.run(); await h.started; h.release(); await first;
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", outcome: { status: "failed" } });
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

  it("confirms a Discord-accepted nonce after crashing before delivery_done", async () => {
    const h = setup();
    h.runtime.prompt.mockImplementationOnce(async () => {
      await h.emit("accepted exactly once");
      return { stopReason: "end_turn" };
    });
    const realMark = h.store.turnAttempts.markDeliveryDone.bind(h.store.turnAttempts);
    vi.spyOn(h.store.turnAttempts, "markDeliveryDone")
      .mockImplementationOnce(() => { throw new Error("synthetic crash after Discord accept"); })
      .mockImplementation(realMark);

    await expect(h.run()).rejects.toThrow("synthetic crash after Discord accept");
    const receipt = h.store.turnAttempts.get("inbound-1")!;
    expect(receipt).toMatchObject({
      state: "completed",
      deliveryDone: false,
      deliveryPayload: { kind: "message", text: "accepted exactly once" },
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

  it("makes an indeterminate Discord history search terminal and actionable", async () => {
    const h = setup();
    h.runtime.prompt.mockImplementationOnce(async () => {
      await h.emit("accepted but too old to scan");
      return { stopReason: "end_turn" };
    });
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
    expect(h.store.turnAttempts.isDeliveryResolved(attempt.id)).toBe(true);
    expect(attempt.deliveryAbandonedReason).toBe("Discord nonce search exceeded 5000 messages");
    const inventory = await (recovered as any).collectInterruptedRows();
    // Protects operator visibility for bounded-search exhaustion; deleting it
    // turns a safe refusal back into an invisible recurring warning.
    expect(inventory).toContainEqual(expect.objectContaining({
      id: "inbound-1",
      status: "abandoned",
      reason: "Discord nonce search exceeded 5000 messages",
    }));
    expect(h.adapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("new user input durably cancels the old execution before its late outcome", async () => {
    const h = setup(); const first = h.run(); await h.started;
    const old = h.store.getInbound("1")!;
    h.store.admitInbound({ ...old, messageId: "2", text: "replacement", createdUtc: new Date().toISOString() });
    h.release(); await first;
    expect(h.store.turnAttempts.get("inbound-1")?.state).toBe("cancelled");
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    expect(h.store.getInbound("1")?.state).toBe("completed");
  });

  it("retains a suspended turn when its current thread ACP differs, without a prompt or load", async () => {
    const h = setup();
    simulateRetiredOwnerProcess();
    const first = h.run(); await h.started; h.orch.suspendForRestart(); h.release(); await first;
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
    await h.run();
    expect(h.store.turnAttempts.get("inbound-1")?.state).toBe("active");
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    expect(await listLiveMarkers(h.dir)).toHaveLength(1);
  });
});
