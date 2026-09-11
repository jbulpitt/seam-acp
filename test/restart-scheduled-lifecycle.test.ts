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
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import { scheduledOccurrenceKey } from "../packages/core/src/core/scheduled-prompts/occurrence-store.js";
import { ScheduledPromptManager } from "../packages/core/src/core/scheduled-prompts/manager.js";

const transport = vi.hoisted(() => ({ prompt: vi.fn(), load: vi.fn(), fresh: vi.fn(), delete: vi.fn(), dispose: vi.fn() }));
vi.mock("../packages/core/src/agents/agent-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return { ...actual, AgentRuntime: class {
    private sessionId = "new-disposable-session";
    async start() {} supportsSessionLoad() { return true; }
    async newSession() { transport.fresh(); return { sessionId: this.sessionId }; }
    async loadSession(p: { sessionId: string }) { transport.load(p.sessionId); this.sessionId = p.sessionId; return { sessionId: p.sessionId }; }
    onEvent() {} async prompt(p: string) { return transport.prompt(p); } async idle() {}
    getSessionInfo() { return { sessionId: this.sessionId }; }
    getProviderIdentity() { return "synthetic-codex"; } getProcessId() { return undefined; }
    async dispose() { await transport.dispose(); }
  } };
});
const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.clearAllMocks(); vi.restoreAllMocks(); });
function setup(mode: "live" | "isolated" = "isolated") {
  transport.prompt.mockReset();
  transport.delete.mockResolvedValue(undefined);
  transport.dispose.mockResolvedValue(undefined);
  const dir = mkdtempSync(path.join(tmpdir(), "seam-252-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "test.db")); cleanups.push(() => store.close());
  const now = new Date().toISOString();
  const record = { id: "discord:worker", platform: "discord", channelRef: "worker", parentRef: "parent",
    agentId: "codex", acpSessionId: "live-session", repoPath: "/synthetic", configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const row: ScheduledPrompt = { id: "schedule-1", platform: "discord", channelRef: "worker", parentRef: "parent",
    name: "Disposable schedule", promptText: "ORIGINAL DISPOSABLE SCHEDULE", cron: "* * * * *", timezone: "UTC",
    model: null, cwd: null, targetChannel: null, outputType: "messages", sessionMode: mode,
    catchupSeconds: 0, enabled: true, legacyAttachmentCount: 0, createdBy: "user", createdUtc: now, updatedUtc: now,
    lastRunUtc: null, lastStatus: null, nextRunUtc: null, pinnedSessionId: null };
  store.upsertScheduled(row);
  const profile = { id: "codex", defaultModel: "test", displayName: "Codex", sessionManager: { deleteSession: transport.delete } } as any;
  const router = { ensureSessionRecord: () => ({ ...record }), listProfiles: () => [profile], getProfile: () => profile,
    isBusy: () => false,
    getOrStartRuntime: vi.fn(async (_record: unknown, _resume?: unknown) => ({
      getSessionInfo: () => ({ sessionId: record.acpSessionId }), getProcessId: () => undefined,
      getProviderIdentity: () => "synthetic-codex", getFastModeOutcome: () => undefined,
      getPromptCapabilities: () => ({}), onEvent() {}, idle: async () => {},
      prompt: (text: string) => transport.prompt(text),
    })),
    reuseMcpServers: () => [], describeConfig: () => ({ agent: { value: "codex" }, model: { value: "test" },
      cwd: { value: "/synthetic" }, effort: { value: null }, location: { value: "local" }, fastMode: { value: false } }) };
  const adapter = { sendPanel: vi.fn(async (channel: any) => ({ channel, id: "panel" })),
    sendMessage: vi.fn(async (channel: any, _text: string) => ({ channel, id: "message" })),
    findMessageByNonce: vi.fn(async () => ({ status: "absent" as const })),
    editPanel: vi.fn(async () => {}), editMessage: vi.fn(async () => {}) };
  const make = () => new Orchestrator({ logger: pino({ level: "silent" }) as any, store, router: router as any,
    adapter: adapter as any, renderer: discordRenderer as any, modelCatalog: fixtureModelCatalog([profile]),
    config: { DATA_DIR: dir, REPOS_ROOT: "/synthetic", REPO_EMOJIS: new Map(), TURN_TIMEOUT_SECONDS: 60,
      SEAM_TURN_RESUME_ENABLED: true, channelPresets: new Map(), threadPresets: new Map() } as any });
  return { dir, store, make, adapter, row, router };
}

describe("#252 actual isolated scheduler + injectTurn, synthetic transport", () => {
  it.each((['live', 'isolated'] as const).flatMap(mode => (['manual', 'cron'] as const)
    .flatMap(trigger => (['record', 'config', 'read-config'] as const).map(stage => ({ mode, trigger, stage })))))
    ("admits $mode $trigger intent before $stage failure and recovers only its first submission", async ({ mode, trigger, stage }) => {
      const h = setup(mode); const orch = h.make();
      const failed = () => { throw new Error("synthetic snapshot failure"); };
      if (stage === 'record') vi.spyOn(h.router, 'ensureSessionRecord').mockImplementationOnce(failed);
      if (stage === 'config') vi.spyOn(h.router, 'describeConfig').mockImplementationOnce(failed);
      if (stage === 'read-config') vi.spyOn(h.store, 'readConfig').mockImplementationOnce(failed);
      const onFire = vi.fn((id: string, key: ReturnType<typeof scheduledOccurrenceKey>) => orch.runScheduledPrompt(id, key));
      const manager = new ScheduledPromptManager({ store: h.store, logger: pino({ level: 'silent' }) as any,
        resolveExecution: row => orch.scheduleExecution(row), onFire });
      try {
        if (trigger === 'manual') await manager.runNow(h.row.id);
        else { manager.start(); (manager as any).onCronTick(h.row.id); await manager.drain(); }
      } finally { manager.stop(); }
      const pending = h.store.scheduledOccurrences.pending();
      expect(pending).toHaveLength(1);
      const occurrence = pending[0]!;
      expect(occurrence).toMatchObject({ execution: null, settled: false, row: { promptText: h.row.promptText } });
      expect(Boolean(occurrence.scheduledFor)).toBe(trigger === 'cron');
      expect(h.store.getScheduled(h.row.id)?.lastStatus).toContain('retained');
      expect(onFire).not.toHaveBeenCalled();
      expect(h.store.turnAttempts.get(occurrence.id)).toBeNull();
      expect(transport.prompt).not.toHaveBeenCalled();
      expect(h.adapter.sendPanel).not.toHaveBeenCalled();
      // Accepted snapshot survives deletion; no later schedule edit supplies a
      // new prompt. The unresolved identity is resolved before runnable onFire.
      h.store.deleteScheduled(h.row.id);
      const next = h.make();
      const recovery = new ScheduledPromptManager({ store: h.store, logger: pino({ level: 'silent' }) as any,
        resolveExecution: row => next.scheduleExecution(row), onFire: async (id, key) => {
          expect(h.store.scheduledOccurrences.get(key.id)?.execution).not.toBeNull();
          await next.runScheduledPrompt(id, key);
        } });
      transport.prompt.mockResolvedValue({ stopReason: 'end_turn' });
      try { recovery.start(); await recovery.drain(); } finally { recovery.stop(); }
      expect(transport.prompt).toHaveBeenCalledTimes(1);
      expect(transport.prompt.mock.calls[0]?.[0]).toContain(h.row.promptText);
      expect(h.store.scheduledOccurrences.get(occurrence.id)?.settled).toBe(true);
      await next.runScheduledPrompt(h.row.id, occurrence);
      expect(transport.prompt).toHaveBeenCalledTimes(1);
    });

  it.each(['live', 'isolated'] as const)("retains submitted %s work through resumed precondition failure without replay", async mode => {
    const h = setup(mode); simulateRetiredOwnerProcess();
    const first = h.make(); const key = scheduledOccurrenceKey(h.row.id);
    transport.prompt.mockImplementationOnce(async () => { first.suspendForRestart(); throw new Error('cutoff'); });
    await first.runScheduledPrompt(h.row.id, key);
    Object.assign(h.adapter, { getThreadLiveState: async () => { throw new Error('synthetic precondition outage'); } });
    await h.make().runScheduledPrompt(h.row.id, key);
    expect(h.store.turnAttempts.get(key.id)).toMatchObject({ state: 'suspended', promptStarted: true });
    expect(h.store.scheduledOccurrences.get(key.id)?.settled).toBe(false);
    expect(transport.prompt).toHaveBeenCalledTimes(1);
    Object.assign(h.adapter, { getThreadLiveState: async () => ({ locked: false, archived: false }) });
    transport.prompt.mockResolvedValue({ stopReason: 'end_turn' });
    await h.make().runScheduledPrompt(h.row.id, key);
    expect(transport.prompt.mock.calls[1]?.[0]).toBe('continue');
  });

  it("freezes identity before publication even if the later runner setup fails", async () => {
    const h = setup(); const orch = h.make(); const config = h.router.describeConfig();
    vi.spyOn(h.router, 'describeConfig').mockReturnValueOnce(config)
      .mockImplementationOnce(() => { throw new Error('synthetic post-publication setup failure'); });
    const onFire = vi.fn((id: string, key: ReturnType<typeof scheduledOccurrenceKey>) => {
      expect(h.store.scheduledOccurrences.get(key.id)?.execution).toMatchObject({ model: 'test' });
      return orch.runScheduledPrompt(id, key);
    });
    const manager = new ScheduledPromptManager({ store: h.store, logger: pino({ level: 'silent' }) as any,
      resolveExecution: row => orch.scheduleExecution(row), onFire });
    try { await manager.runNow(h.row.id); } finally { manager.stop(); }
    expect(onFire).toHaveBeenCalledTimes(1);
    const saved = h.store.scheduledOccurrences.pending()[0]!;
    expect(saved.execution?.model).toBe('test');
    expect(h.store.turnAttempts.get(saved.id)).toBeNull();
    expect(transport.prompt).not.toHaveBeenCalled();
    h.router.describeConfig = () => ({ ...config, model: { value: 'changed' } });
    await h.make().runScheduledPrompt(h.row.id, saved);
    expect(transport.prompt).not.toHaveBeenCalled();
    expect(h.store.scheduledOccurrences.get(saved.id)?.execution?.model).toBe('test');
  });

  it("persists occurrence/session/start before an isolated prompt can be interrupted", async () => {
    const h = setup(); const orch = h.make();
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    transport.prompt.mockImplementationOnce(async () => { entered(); await gate; throw new Error("ACP connection closed"); });
    const run = orch.runScheduledPrompt(h.row.id);
    await started;
    const active = h.store.turnAttempts.list("active");
    orch.suspendForRestart(); release(); await run;
    expect(active).toEqual([expect.objectContaining({ source: "schedule", acpSessionId: "new-disposable-session", promptStarted: true })]);
    expect(transport.delete).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.list("suspended")).toHaveLength(1);
  });

  it.each(["live", "isolated"] as const)("continues the same %s occurrence/session after repeated cutoff without the original task", async mode => {
    const h = setup(mode);
    simulateRetiredOwnerProcess();
    const key = scheduledOccurrenceKey(h.row.id, "2026-09-09T00:00:00.000Z");
    for (let i = 0; i < 2; i++) {
      const orch = h.make();
      transport.prompt.mockImplementationOnce(async () => { orch.suspendForRestart(); throw new Error("ACP connection closed"); });
      await orch.runScheduledPrompt(h.row.id, key);
      expect(h.store.turnAttempts.get(key.id)?.state).toBe("suspended");
    }
    expect(transport.delete).not.toHaveBeenCalled();
    transport.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });
    await h.make().runScheduledPrompt(h.row.id, key);
    expect(transport.prompt.mock.calls[0]?.[0]).toContain("ORIGINAL DISPOSABLE SCHEDULE");
    expect(transport.prompt.mock.calls.slice(1).map(c => c[0])).toEqual(["continue", "continue"]);
    expect(h.store.turnAttempts.get(key.id)).toMatchObject({ generation: 3, state: "completed", deliveryDone: true });
    expect(h.store.scheduledOccurrences.get(key.id)?.settled).toBe(true);
    if (mode === "isolated") {
      expect(transport.fresh).toHaveBeenCalledTimes(1);
      expect(transport.load).toHaveBeenCalledTimes(2);
      expect(transport.delete).toHaveBeenCalledTimes(1);
    } else expect(h.router.getOrStartRuntime.mock.calls.at(-1)?.[1]).toEqual({ resumeSessionId: "live-session" });
  });

  it("deduplicates the same cron slot but admits a later slot and distinct manual runs", async () => {
    const h = setup(); transport.prompt.mockResolvedValue({ stopReason: "end_turn" });
    const orch = h.make(); const key = scheduledOccurrenceKey(h.row.id, "2026-09-09T00:00:00.000Z");
    await orch.runScheduledPrompt(h.row.id, key);
    await orch.runScheduledPrompt(h.row.id, scheduledOccurrenceKey(h.row.id, key.scheduledFor!));
    expect(transport.prompt).toHaveBeenCalledTimes(1);
    await orch.runScheduledPrompt(h.row.id, scheduledOccurrenceKey(h.row.id, "2026-09-09T00:01:00.000Z"));
    await orch.runScheduledPrompt(h.row.id); await orch.runScheduledPrompt(h.row.id);
    expect(transport.prompt).toHaveBeenCalledTimes(4);
  });

  it("recovers saved output after failed delivery and does not recreate the deleted provider session", async () => {
    const h = setup(); transport.prompt.mockResolvedValue({ stopReason: "end_turn" });
    const key = scheduledOccurrenceKey(h.row.id);
    h.adapter.sendPanel.mockRejectedValue(new Error("synthetic output outage"));
    await h.make().runScheduledPrompt(h.row.id, key);
    expect(h.store.turnAttempts.get(key.id)).toMatchObject({ state: "completed", deliveryDone: false });
    expect(transport.delete).toHaveBeenCalledTimes(1);
    h.adapter.sendPanel.mockImplementation(async channel => ({ channel, id: "recovered" }));
    await h.make().runScheduledPrompt(h.row.id, key);
    expect(transport.prompt).toHaveBeenCalledTimes(1);
    expect(h.store.scheduledOccurrences.get(key.id)?.settled).toBe(true);
    const deliveryCalls = h.adapter.sendPanel.mock.calls.filter(call => call[2]);
    const firstDelivery = deliveryCalls[0]?.[2];
    const replayDelivery = deliveryCalls.at(-1)?.[2];
    // Protects scheduled-result dedup after an accepted/rejected ambiguity;
    // deleting it lets boot replay create a second result card.
    expect(replayDelivery).toEqual(firstDelivery);
    expect(replayDelivery).toMatchObject({ enforceNonce: true });
  });

  it("a durable cancellation never resumes, while disable/delete only stops future ticks", async () => {
    const h = setup(); simulateRetiredOwnerProcess();
    const orch = h.make(); const key = scheduledOccurrenceKey(h.row.id);
    transport.prompt.mockImplementationOnce(async () => { orch.suspendForRestart(); throw new Error("cutoff"); });
    await orch.runScheduledPrompt(h.row.id, key);
    h.store.upsertScheduled({ ...h.row, enabled: false });
    h.store.deleteScheduled(h.row.id);
    transport.prompt.mockResolvedValue({ stopReason: "end_turn" });
    await h.make().runScheduledPrompt(h.row.id, key);
    expect(transport.prompt.mock.calls.at(-1)?.[0]).toBe("continue");
    expect(h.store.getScheduled(h.row.id)).toBeNull();
    h.store.upsertScheduled(h.row);
    const cancelledKey = scheduledOccurrenceKey(h.row.id);
    const second = h.make();
    transport.prompt.mockImplementationOnce(async () => { second.suspendForRestart(); throw new Error("cutoff"); });
    await second.runScheduledPrompt(h.row.id, cancelledKey);
    h.store.turnAttempts.cancel(cancelledKey.id);
    await h.make().runScheduledPrompt(h.row.id, cancelledKey);
    expect(transport.prompt).toHaveBeenCalledTimes(3);
  });

  it("boot recovery owns a due slot before catch-up and does not run it twice", async () => {
    const h = setup(); simulateRetiredOwnerProcess();
    const due = new Date(Date.now() - 120000).toISOString();
    const orch = h.make(); const key = scheduledOccurrenceKey(h.row.id, due);
    transport.prompt.mockImplementationOnce(async () => { orch.suspendForRestart(); throw new Error("cutoff"); });
    await orch.runScheduledPrompt(h.row.id, key);
    h.store.upsertScheduled({ ...h.row, nextRunUtc: due });
    transport.prompt.mockResolvedValue({ stopReason: "end_turn" });
    const fresh = h.make();
    const manager = new ScheduledPromptManager({ store: h.store, logger: pino({ level: "silent" }) as any,
      resolveExecution: row => fresh.scheduleExecution(row),
      onFire: (id, occurrence) => fresh.runScheduledPrompt(id, occurrence) });
    manager.start(); await manager.drain(); manager.stop();
    expect(transport.prompt).toHaveBeenCalledTimes(2);
    expect(transport.prompt.mock.calls[1]?.[0]).toBe("continue");
    expect(h.store.scheduledOccurrences.pending()).toEqual([]);
  });

  it("a cutoff during target preconditions retains an unstarted occurrence for its first prompt", async () => {
    const h = setup(); simulateRetiredOwnerProcess();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    Object.assign(h.adapter, { getThreadLiveState: async () => { await gate; return { locked: false, archived: false }; } });
    const orch = h.make(); const key = scheduledOccurrenceKey(h.row.id);
    const run = orch.runScheduledPrompt(h.row.id, key);
    expect(h.store.turnAttempts.get(key.id)).toMatchObject({ promptStarted: false, acpSessionId: null });
    orch.suspendForRestart(); release(); await run;
    expect(transport.fresh).not.toHaveBeenCalled(); expect(transport.prompt).not.toHaveBeenCalled();
    transport.prompt.mockResolvedValue({ stopReason: "end_turn" });
    await h.make().runScheduledPrompt(h.row.id, key);
    expect(transport.prompt.mock.calls[0]?.[0]).toBe(h.row.promptText);
    expect(h.store.turnAttempts.get(key.id)).toMatchObject({ generation: 2, state: "completed" });
  });

  it("does not allow a later slot to overlap a suspended occurrence, or inherit its updated configuration", async () => {
    const h = setup(); simulateRetiredOwnerProcess();
    const orch = h.make(); const key = scheduledOccurrenceKey(h.row.id);
    transport.prompt.mockImplementationOnce(async () => { orch.suspendForRestart(); throw new Error("cutoff"); });
    await orch.runScheduledPrompt(h.row.id, key);
    const fresh = h.make();
    await fresh.runScheduledPrompt(h.row.id);
    expect(transport.prompt).toHaveBeenCalledTimes(1);
    const original = h.router.describeConfig();
    h.router.describeConfig = () => ({ ...original, model: { value: "changed" } });
    await fresh.runScheduledPrompt(h.row.id, key);
    expect(transport.prompt).toHaveBeenCalledTimes(1);
    expect(h.store.turnAttempts.get(key.id)?.state).toBe("suspended");
  });

  it("strict session-load refusal retains provider material and never falls back to a new original turn", async () => {
    const h = setup(); simulateRetiredOwnerProcess();
    const orch = h.make(); const key = scheduledOccurrenceKey(h.row.id);
    transport.prompt.mockImplementationOnce(async () => { orch.suspendForRestart(); throw new Error("cutoff"); });
    await orch.runScheduledPrompt(h.row.id, key);
    transport.load.mockImplementationOnce(() => { throw new Error("synthetic session unavailable"); });
    await h.make().runScheduledPrompt(h.row.id, key);
    expect(h.store.turnAttempts.get(key.id)?.state).toBe("suspended");
    expect(transport.fresh).toHaveBeenCalledTimes(1);
    expect(transport.prompt).toHaveBeenCalledTimes(1);
    expect(transport.delete).not.toHaveBeenCalled();
  });

  it("#253 identifies held isolated work while its live thread stays idle, without crossing channel scope", async () => {
    const h = setup(); const orch = h.make();
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    transport.prompt.mockImplementationOnce(async () => { entered(); await gate; return { stopReason: "end_turn" }; });
    const key = scheduledOccurrenceKey(h.row.id);
    const run = orch.runScheduledPrompt(h.row.id, key); await started;
    try {
      expect(orch.activeTurnCount()).toBe(1);
      expect(orch.isChannelBusy(h.row.channelRef)).toBe(false);
      const own = (orch as any).scheduledWorkForCaller(h.store.get("discord:worker"));
      expect(own).toMatchObject({ total: 1, entries: [{ occurrenceId: key.id, scheduleId: h.row.id,
        channelRef: "worker", mode: "isolated", phase: "provider" }] });
      const other = (orch as any).scheduledWorkForCaller({ platform: "discord", parentRef: "other-channel", channelRef: "other-thread" });
      expect(other).toEqual({ total: 1, entries: [] });
      expect(JSON.stringify(own)).not.toContain(h.row.promptText);
      expect(JSON.stringify(own)).not.toContain("/synthetic");
      const current = h.store.get("discord:worker")!;
      h.store.upsert({ ...current, parentRef: "moved-parent" });
      expect(orch.scheduledWorkForCaller(current).entries).toEqual([]);
      expect(orch.scheduledWorkForCaller({ ...current, parentRef: "moved-parent" }).entries).toEqual([]);
    } finally { release(); await run; }
    expect((orch as any).scheduledWorkForCaller(h.store.get("discord:worker"))).toEqual({ total: 0, entries: [] });
  });

  it("#253 remains attributed through isolated runtime cleanup and output delivery", async () => {
    const h = setup(); const orch = h.make();
    let releaseCleanup!: () => void; let enteredCleanup!: () => void;
    const cleanupStarted = new Promise<void>(r => { enteredCleanup = r; });
    const cleanupGate = new Promise<void>(r => { releaseCleanup = r; });
    let releaseOutput!: () => void; let enteredOutput!: () => void;
    const outputStarted = new Promise<void>(r => { enteredOutput = r; });
    const outputGate = new Promise<void>(r => { releaseOutput = r; });
    transport.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });
    transport.dispose.mockImplementationOnce(async () => { enteredCleanup(); await cleanupGate; });
    h.adapter.sendPanel.mockImplementationOnce(async channel => ({ channel, id: "start" }))
      .mockImplementationOnce(async channel => { enteredOutput(); await outputGate; return { channel, id: "output" }; });
    const run = orch.runScheduledPrompt(h.row.id); await cleanupStarted;
    expect(orch.scheduledWorkForCaller(h.store.get("discord:worker")!).entries[0]?.phase).toBe("cleanup");
    expect(orch.activeTurnCount()).toBe(1);
    releaseCleanup(); await outputStarted;
    expect(orch.scheduledWorkForCaller(h.store.get("discord:worker")!).entries[0]?.phase).toBe("output");
    expect(orch.activeTurnCount()).toBe(1);
    releaseOutput(); await run;
    expect(orch.activeScheduledOccurrenceCount()).toBe(0); expect(orch.activeTurnCount()).toBe(0);
  });

  it("#253 counts a live schedule once even while it owns two drain tokens", async () => {
    const h = setup("live"); const orch = h.make();
    transport.prompt.mockImplementationOnce(async () => {
      expect(orch.activeTurnCount()).toBe(2);
      expect(orch.activeScheduledOccurrenceCount()).toBe(1);
      expect(orch.scheduledWorkForCaller(h.store.get("discord:worker")!).entries[0]?.phase).toBe("provider");
      return { stopReason: "end_turn" };
    });
    await orch.runScheduledPrompt(h.row.id);
    expect(orch.activeScheduledOccurrenceCount()).toBe(0); expect(orch.activeTurnCount()).toBe(0);
  });

  it("#253 attributes startup before async preconditions and releases after failure", async () => {
    const h = setup(); const orch = h.make();
    Object.assign(h.adapter, { getThreadLiveState: async () => {
      expect(orch.activeScheduledOccurrenceCount()).toBe(1);
      expect(orch.scheduledWorkForCaller(h.store.get("discord:worker")!).entries[0]?.phase).toBe("startup");
      throw new Error("synthetic precondition outage");
    } });
    await orch.runScheduledPrompt(h.row.id);
    expect(orch.activeScheduledOccurrenceCount()).toBe(0); expect(orch.activeTurnCount()).toBe(0);
  });

  it("#253 cannot leak a drain token when metadata registration fails", async () => {
    const h = setup(); const orch = h.make();
    vi.spyOn((orch as any).scheduledActivity, "begin").mockImplementation(() => { throw new Error("synthetic metadata failure"); });
    await expect(orch.runScheduledPrompt(h.row.id)).rejects.toThrow("synthetic metadata failure");
    expect(orch.activeTurnCount()).toBe(0);
    expect(h.store.scheduledOccurrences.pending()).toHaveLength(1);
    expect(h.store.scheduledOccurrences.pending()[0]?.execution).toBeNull();
  });

  it("does not invent identity for unresolved intent with any existing execution owner", async () => {
    const h = setup(); const key = scheduledOccurrenceKey(h.row.id);
    h.store.scheduledOccurrences.reserve(key, h.row);
    h.store.turnAttempts.registerOwner('synthetic-owner');
    h.store.turnAttempts.claim({ id: key.id, target: h.row.channelRef, session: 'isolated',
      prompt: 'never replay', kind: 'scheduled', createdUtc: new Date().toISOString() }, 'unknown-frozen-identity', 'synthetic-owner', 'schedule');
    const resolveExecution = vi.fn(() => h.make().scheduleExecution(h.row));
    const onFire = vi.fn(async () => {});
    const manager = new ScheduledPromptManager({ store: h.store, logger: pino({ level: 'silent' }) as any, resolveExecution, onFire });
    h.store.deleteScheduled(h.row.id);
    try { manager.start(); await manager.drain(); } finally { manager.stop(); }
    expect(resolveExecution).not.toHaveBeenCalled(); expect(onFire).not.toHaveBeenCalled();
    expect(h.store.scheduledOccurrences.get(key.id)?.execution).toBeNull();
    expect(h.store.turnAttempts.get(key.id)).toMatchObject({ state: 'active', generation: 1 });
  });
});
