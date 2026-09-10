import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); });
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
    sendFile: vi.fn(async () => {}), editPanel: vi.fn(async () => {}), editMessage: vi.fn(async () => {}) };
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
  it("retains the inbound execution and marker on cutoff, then submits only continue to the same ACP", async () => {
    const h = setup();
    // In-process boot simulation; real PID retirement has separate offline tests.
    vi.spyOn(h.store.turnAttempts, "registerOwner").mockImplementation(() => {});
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
    await h.run(h.make());
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    expect(h.store.turnAttempts.get("inbound-1")?.deliveryDone).toBe(true);
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
    vi.spyOn(h.store.turnAttempts, "registerOwner").mockImplementation(() => {});
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
