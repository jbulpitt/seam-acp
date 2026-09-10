import { afterEach, describe, expect, it, vi } from "vitest";
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

const transport = vi.hoisted(() => ({ prompt: vi.fn(), load: vi.fn(), fresh: vi.fn(), delete: vi.fn() }));
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
    async dispose() {}
  } };
});
const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.clearAllMocks(); });
function setup(mode: "live" | "isolated" = "isolated") {
  transport.prompt.mockReset();
  transport.delete.mockResolvedValue(undefined);
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
    editPanel: vi.fn(async () => {}), editMessage: vi.fn(async () => {}) };
  const make = () => new Orchestrator({ logger: pino({ level: "silent" }) as any, store, router: router as any,
    adapter: adapter as any, renderer: discordRenderer as any, modelCatalog: fixtureModelCatalog([profile]),
    config: { DATA_DIR: dir, REPOS_ROOT: "/synthetic", REPO_EMOJIS: new Map(), TURN_TIMEOUT_SECONDS: 60,
      SEAM_TURN_RESUME_ENABLED: true, channelPresets: new Map(), threadPresets: new Map() } as any });
  return { dir, store, make, adapter, row, router };
}

describe("#252 actual isolated scheduler + injectTurn, synthetic transport", () => {
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
    vi.spyOn(h.store.turnAttempts, "registerOwner").mockImplementation(() => {});
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
  });

  it("a durable cancellation never resumes, while disable/delete only stops future ticks", async () => {
    const h = setup(); vi.spyOn(h.store.turnAttempts, "registerOwner").mockImplementation(() => {});
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
    const h = setup(); vi.spyOn(h.store.turnAttempts, "registerOwner").mockImplementation(() => {});
    const due = new Date(Date.now() - 120000).toISOString();
    const orch = h.make(); const key = scheduledOccurrenceKey(h.row.id, due);
    transport.prompt.mockImplementationOnce(async () => { orch.suspendForRestart(); throw new Error("cutoff"); });
    await orch.runScheduledPrompt(h.row.id, key);
    h.store.upsertScheduled({ ...h.row, nextRunUtc: due });
    transport.prompt.mockResolvedValue({ stopReason: "end_turn" });
    const fresh = h.make();
    const manager = new ScheduledPromptManager({ store: h.store, logger: pino({ level: "silent" }) as any,
      onFire: (id, occurrence) => fresh.runScheduledPrompt(id, occurrence) });
    manager.start(); await manager.drain(); manager.stop();
    expect(transport.prompt).toHaveBeenCalledTimes(2);
    expect(transport.prompt.mock.calls[1]?.[0]).toBe("continue");
    expect(h.store.scheduledOccurrences.pending()).toEqual([]);
  });

  it("a cutoff during target preconditions retains an unstarted occurrence for its first prompt", async () => {
    const h = setup(); vi.spyOn(h.store.turnAttempts, "registerOwner").mockImplementation(() => {});
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
    const h = setup(); vi.spyOn(h.store.turnAttempts, "registerOwner").mockImplementation(() => {});
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
    const h = setup(); vi.spyOn(h.store.turnAttempts, "registerOwner").mockImplementation(() => {});
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
});
