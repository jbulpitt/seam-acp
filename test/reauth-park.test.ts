/**
 * #454 wire: a prompt that already started is suspended, not completed, and
 * a waiting attempt is not continued. A test that still passes when the park
 * is removed is not this file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { classifyClaudeError, type AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { pino } from "pino";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { REAUTH_WAITING_TEXT } from "../packages/core/src/core/reauth-negotiation.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { makeChoiceCustomId } from "../packages/core/src/core/choice/types.js";
import type { ChoiceInteraction } from "../packages/core/src/platforms/chat-adapter.js";
import type { MessageRef, StructuredPanel } from "../packages/core/src/core/types.js";
import type { AgentEvent } from "../packages/core/src/agents/agent-runtime.js";

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const OAUTH = "Failed to authenticate: OAuth session expired and could not be refreshed https://device.example.com/start code ABCD-EFGH http://127.0.0.1:9/cb";

function harness(facts: () => { refreshTokenExpiresAt: number | null } | undefined, panels = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-454-park-"));
  dirs.push(dir);
  const store = new SessionStore(path.join(dir, "fixture.db"));
  const profile = {
    id: "claude", defaultModel: "fixture-model", classifyError: classifyClaudeError,
    spawn() { throw new Error("provider spawn forbidden"); },
  } as unknown as AgentProfile;
  const logger = pino({ level: "silent" });
  const runtime = new AgentRuntime({
    profile, logger: logger as never,
    claudeCredentialFacts: facts,
    spawnFn: profile.spawn.bind(profile),
  });
  const prompt = vi.fn(async () => {
    throw new RequestError(-32603, OAUTH, { errorKind: "authentication_failed" });
  });
  Object.assign(runtime, {
    connection: { prompt }, sessionId: "fixture-acp", promptCapabilities: {},
    sessionInfo: { sessionId: "fixture-acp", availableModels: [], currentModelId: "fixture-model" },
    supportsSessionLoad: () => true,
    loadSession: async () => ({ sessionId: "fixture-acp" }),
    idle: async () => {},
    getProcessId: () => undefined,
    getProviderIdentity: () => undefined,
  });
  const record = {
    id: "discord:fixture-thread", platform: "discord", channelRef: "fixture-thread",
    parentRef: null, agentId: "claude", acpSessionId: "fixture-acp", repoPath: dir, configJson: "{}",
    createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString(),
  };
  store.upsert(record);
  const messages: string[] = [];
  const cards = new Map<string, StructuredPanel>();
  const edits: { ref: MessageRef; panel: StructuredPanel }[] = [];
  let panelOrdinal = 0;
  let unavailableCard: string | undefined;
  const described = {
    agent: { value: "claude" }, location: { value: "local" }, model: { value: "fixture-model" },
    effort: { value: null }, cwd: { value: dir }, fastMode: { value: false },
  };
  const orch = new Orchestrator({
    logger: logger as never, store, renderer: discordRenderer,
    modelCatalog: fixtureModelCatalog([profile]),
    config: {
      DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60, REPO_EMOJIS: new Map(),
      DEFAULT_MODEL: "fixture-model", channelPresets: new Map(), threadPresets: new Map(),
      DISCORD_ALLOWED_USER_IDS: new Set(["fixture-user"]),
      SEAM_DISPATCH_STATUS_PANEL: panels, SEAM_DISPATCH_OUTPUT_STYLE: "messages",
    } as never,
    router: {
      listProfiles: () => [profile],
      ensureSessionRecord: () => record,
      getProfile: () => profile,
      resolveProfileForChannel: () => profile,
      assertAgentAllowedForChannel() {},
      assertAgentAllowedForRecord() {},
      isBusy: () => false,
      getOrStartRuntime: async () => runtime,
      describeConfig: () => described,
    } as never,
    adapter: {
      async sendPanel(channel: unknown, panel: StructuredPanel) {
        const id = `panel-${++panelOrdinal}`; cards.set(id, panel); return { channel, id };
      },
      async editPanel(ref: MessageRef, panel: StructuredPanel) {
        if (ref.id === unavailableCard) throw new Error("Unknown Message");
        cards.set(ref.id, panel); edits.push({ ref, panel });
      },
      async sendChoiceCard(channel: unknown) { return { channel, id: "reauth-choice" }; },
      async editChoiceCard() {},
      async sendMessage(_channel: unknown, text: string) { messages.push(text); return { channel: _channel, id: "message" }; },
      async editMessage() {},
      async sendFile() {},
    } as never,
  });
  cleanups.push(() => {
    for (const panel of (orch as unknown as { attemptStatusPanels: Map<string, { stop(): void }> }).attemptStatusPanels.values()) panel.stop();
  });
  const watcher = new DispatchWatcher({ dataDir: dir, logger: logger as never,
    attempts: store.turnAttempts, onDispatch: spec => orch.dispatchInjectTurn(spec), pollMs: 1_000_000 });
  orch.setDispatchWatcher(watcher);
  cleanups.push(() => watcher.stop());
  return { dir, store, orch, runtime, prompt, messages, record, described, cards, edits, watcher,
    removeCard: (id: string) => { unavailableCard = id; cards.delete(id); } };
}

async function clickReauth(h: ReturnType<typeof harness>) {
  const card = h.store.listOpenChoiceCards("discord", h.record.channelRef)[0]!;
  expect(card).toBeDefined();
  const event: ChoiceInteraction = {
    customId: makeChoiceCustomId(card.id, 0), kind: "button", userId: "fixture-user", userName: "Fixture",
    channel: { platform: "discord", id: h.record.channelRef }, messageId: "reauth-choice",
    async deferUpdate() {}, async followUpEphemeral() {}, async replyEphemeral() {}, async showModal() {},
  };
  await (h.orch as unknown as { handleChoiceCardInteraction(evt: ChoiceInteraction): Promise<void> })
    .handleChoiceCardInteraction(event);
}

function resumeOutcome(h: ReturnType<typeof harness>, failed: boolean) {
  h.prompt.mockImplementationOnce(async () => {
    if (failed) throw new RequestError(-32602, "provider refused the resumed turn", { errorKind: "invalid_request" });
    await (h.runtime as unknown as { emit(event: AgentEvent): Promise<void> })
      .emit({ kind: "agent-text", text: "RESUMED-ONCE" });
    return { stopReason: "end_turn" } as never;
  });
}

async function parkMessage(h: ReturnType<typeof harness>) {
  const messageId = "reauth-message";
  h.store.admitInbound({ messageId, platform: "discord", channelRef: h.record.channelRef,
    parentRef: null, sessionRecordId: h.record.id, authorId: "fixture-user", authorName: "Fixture",
    text: "ORIGINAL-ONCE", attachments: [], createdUtc: h.record.createdUtc });
  h.store.claimInbound(messageId, 0, h.record.createdUtc);
  await (h.orch as unknown as { executeIncomingMessage(message: unknown): Promise<void> }).executeIncomingMessage({
    channel: { platform: "discord", id: h.record.channelRef }, authorId: "fixture-user",
    authorIsBot: false, text: "ORIGINAL-ONCE", messageId,
  });
  return `inbound-${messageId}`;
}

describe("reauth resume status-card settlement", () => {
  it.each([
    ["wake", false], ["wake", true], ["handoff", false], ["handoff", true],
  ] as const)("settles the original %s card after button resume (failed=%s)", async (kind, failed) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const h = harness(() => ({ refreshTokenExpiresAt: 1 }), true);
    const spec: DispatchSpec = { id: "reauth-dispatch", target: h.record.channelRef,
      prompt: "ORIGINAL-ONCE", session: "live", kind, createdUtc: h.record.createdUtc, stream: false };
    await expect(h.orch.dispatchInjectTurn(spec)).rejects.toMatchObject({ reason: expect.stringContaining("reauth-waiting:") });
    const original = h.store.turnAttempts.get(spec.id)!;
    const cardId = original.statusCard!.messageId;
    expect(h.cards.get(cardId)?.title).toContain("Waiting");
    resumeOutcome(h, failed);
    await clickReauth(h);
    await h.watcher.start(); await h.watcher.drain(); h.watcher.stop();
    expect(h.store.turnAttempts.get(spec.id)).toMatchObject({ state: "completed", generation: 2,
      acpSessionId: "fixture-acp", statusCard: original.statusCard });
    expect(h.prompt).toHaveBeenCalledTimes(2);
    const calls = JSON.stringify(h.prompt.mock.calls);
    expect(calls.match(/ORIGINAL-ONCE/g)).toHaveLength(1);
    expect(calls).toContain("continue");
    expect(h.cards.size).toBe(1);
    expect(h.cards.get(cardId)?.title).toContain(failed ? "Failed" : "Done");
    const settledEdits = h.edits.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.edits).toHaveLength(settledEdits);
    expect(h.cards.get(cardId)?.title).toContain(failed ? "Failed" : "Done");
    if (!failed) expect(h.messages.filter(text => text === "RESUMED-ONCE")).toHaveLength(1);
    h.store.close();
  });

  it.each([false, true])("settles an ordinary message's original card after button resume (failed=%s)", async failed => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const h = harness(() => ({ refreshTokenExpiresAt: 1 }), true);
    const id = await parkMessage(h);
    const original = h.store.turnAttempts.get(id)!;
    expect(h.cards.get(original.statusCard!.messageId)?.title).toContain("Waiting");
    resumeOutcome(h, failed);
    await clickReauth(h);
    expect(h.store.turnAttempts.get(id)).toMatchObject({ state: "completed", generation: 2,
      acpSessionId: "fixture-acp", statusCard: original.statusCard });
    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.prompt.mock.calls).match(/ORIGINAL-ONCE/g)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.cards.size).toBe(1);
    expect(h.cards.get(original.statusCard!.messageId)?.title).toContain(failed ? "Failed" : "Done");
    if (!failed) expect(h.messages.filter(text => text === "RESUMED-ONCE")).toHaveLength(1);
    h.store.close();
  });

  it.each(["wake", "message"] as const)("replaces an unavailable %s card on button resume", async kind => {
    const h = harness(() => ({ refreshTokenExpiresAt: 1 }), true);
    const spec: DispatchSpec = { id: "reauth-dispatch", target: h.record.channelRef,
      prompt: "ORIGINAL-ONCE", session: "live", kind: "wake", createdUtc: h.record.createdUtc, stream: false };
    const id = kind === "message" ? await parkMessage(h) : spec.id;
    if (kind === "wake") await expect(h.orch.dispatchInjectTurn(spec)).rejects.toMatchObject({ name: "DispatchSuspendedError" });
    const original = h.store.turnAttempts.get(id)!;
    h.removeCard(original.statusCard!.messageId);
    resumeOutcome(h, false);
    await clickReauth(h);
    if (kind === "wake") { await h.watcher.start(); await h.watcher.drain(); h.watcher.stop(); }
    const finished = h.store.turnAttempts.get(id)!;
    expect(finished.state).toBe("completed");
    expect(finished.statusCard!.messageId).not.toBe(original.statusCard!.messageId);
    expect(h.cards.size).toBe(1);
    expect(h.cards.get(finished.statusCard!.messageId)?.title).toContain("Done");
    expect(h.messages.filter(text => text === "RESUMED-ONCE")).toHaveLength(1);
    h.store.close();
  });

  it.each(["wake", "handoff", "message"] as const)("stops a %s card after re-parking and later resumes it to Done", async kind => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const h = harness(() => ({ refreshTokenExpiresAt: 1 }), true);
    const spec: DispatchSpec = { id: "reauth-dispatch", target: h.record.channelRef,
      prompt: "ORIGINAL-ONCE", session: "live", kind: kind === "message" ? "wake" : kind,
      createdUtc: h.record.createdUtc, stream: false };
    const id = kind === "message" ? await parkMessage(h) : spec.id;
    if (kind !== "message") await expect(h.orch.dispatchInjectTurn(spec)).rejects.toMatchObject({ name: "DispatchSuspendedError" });
    const original = h.store.turnAttempts.get(id)!;
    const resume = async () => {
      await clickReauth(h);
      if (kind !== "message") { await h.watcher.start(); await h.watcher.drain(); h.watcher.stop(); }
    };
    // Authentication still fails after the first confirmation.
    await resume();
    expect(h.store.turnAttempts.get(id)).toMatchObject({ state: "suspended", generation: 2,
      acpSessionId: "fixture-acp", statusCard: original.statusCard });
    expect(h.cards.get(original.statusCard!.messageId)?.title).toContain("Waiting");
    const parkedEdits = h.edits.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.edits).toHaveLength(parkedEdits);
    resumeOutcome(h, false);
    await resume();
    expect(h.store.turnAttempts.get(id)).toMatchObject({ state: "completed", generation: 3,
      acpSessionId: "fixture-acp", statusCard: original.statusCard });
    expect(h.prompt).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(h.prompt.mock.calls).match(/ORIGINAL-ONCE/g)).toHaveLength(1);
    expect(h.cards.size).toBe(1);
    expect(h.cards.get(original.statusCard!.messageId)?.title).toContain("Done");
    const settledEdits = h.edits.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.edits).toHaveLength(settledEdits);
    expect(h.messages.filter(text => text === "RESUMED-ONCE")).toHaveLength(1);
    h.store.close();
  });
});

describe("#454 prompt park", () => {
  it("suspends a started turn instead of completing it, and does not send the prompt again", async () => {
    const h = harness(() => ({ refreshTokenExpiresAt: 1 }));
    const messageId = "owned-message";
    h.store.admitInbound({
      messageId, platform: "discord", channelRef: h.record.channelRef, parentRef: null,
      sessionRecordId: h.record.id, authorId: "fixture-user", authorName: "Fixture",
      text: "DO-NOT-REPLAY-9f3a", attachments: [], createdUtc: h.record.createdUtc,
    });
    h.store.claimInbound(messageId, 0, h.record.createdUtc);
    await (h.orch as unknown as { executeIncomingMessage(message: unknown): Promise<void> }).executeIncomingMessage({
      channel: { platform: "discord", id: h.record.channelRef },
      authorId: "fixture-user", authorIsBot: false, text: "DO-NOT-REPLAY-9f3a", messageId,
    });
    expect(h.prompt).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(h.prompt.mock.calls);
    expect(sent).toContain("DO-NOT-REPLAY-9f3a");
    expect(sent).not.toContain("Device code");
    expect(sent).not.toContain("continue\\n");
    const row = h.store.turnAttempts.get(`inbound-${messageId}`)!;
    expect(row.state).toBe("suspended");
    expect(row.promptStarted).toBe(true);
    expect(row.outcome).toBeNull();
    expect(row.stalledReason?.startsWith("reauth-waiting:")).toBe(true);
    expect(row.stalledReason).toContain("url=https://device.example.com/start");
    expect(row.stalledReason).toContain("code=ABCD-EFGH");
    expect(row.stalledReason).toContain("loopback=1");
    expect(row.stalledReason).not.toContain("127.0.0.1");
    expect(h.messages.some(text => text.includes("https://device.example.com/start") && text.includes("ABCD-EFGH"))).toBe(true);
    expect(h.messages.some(text => text.includes("Authenticate button"))).toBe(false);
    h.store.close();
  });

  it("does not park when the refresh-token expiry could not be read", async () => {
    const h = harness(() => ({ refreshTokenExpiresAt: null }));
    const messageId = "unreadable";
    h.store.admitInbound({
      messageId, platform: "discord", channelRef: h.record.channelRef, parentRef: null,
      sessionRecordId: h.record.id, authorId: "fixture-user", authorName: "Fixture",
      text: "DO-NOT-REPLAY-9f3a", attachments: [], createdUtc: h.record.createdUtc,
    });
    h.store.claimInbound(messageId, 0, h.record.createdUtc);
    await (h.orch as unknown as { executeIncomingMessage(message: unknown): Promise<void> }).executeIncomingMessage({
      channel: { platform: "discord", id: h.record.channelRef },
      authorId: "fixture-user", authorIsBot: false, text: "DO-NOT-REPLAY-9f3a", messageId,
    });
    const row = h.store.turnAttempts.get(`inbound-${messageId}`)!;
    expect(row.state).toBe("completed");
    expect(row.stalledReason ?? "").not.toContain("reauth-waiting");
    expect(h.prompt).toHaveBeenCalledTimes(1);
    h.store.close();
  });

  it("parks a dispatch prompt instead of completing the worker turn", async () => {
    const h = harness(() => ({ refreshTokenExpiresAt: 1 }));
    const spec: DispatchSpec = {
      id: "worker-sso-first", target: h.record.channelRef, prompt: "ORIGINAL-BRIEF-DO-NOT-REPLAY",
      session: "live", kind: "handoff", createdUtc: h.record.createdUtc, stream: false,
    };
    await expect(h.orch.dispatchInjectTurn(spec)).rejects.toMatchObject({
      reason: expect.stringContaining("reauth-waiting:"),
    });
    expect(h.prompt).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(h.prompt.mock.calls);
    expect(sent).toContain("ORIGINAL-BRIEF-DO-NOT-REPLAY");
    expect(sent).not.toContain("Device code");
    const row = h.store.turnAttempts.get(spec.id)!;
    expect(row.state).toBe("suspended");
    expect(row.promptStarted).toBe(true);
    expect(row.outcome).toBeNull();
    expect(row.stalledReason?.startsWith("reauth-waiting:")).toBe(true);
    expect(row.stalledReason).toContain("code=ABCD-EFGH");
    h.store.close();
  });

  it("does not continue a dispatch that is still waiting for authentication", async () => {
    const h = harness(() => ({ refreshTokenExpiresAt: 1 }));
    const boot = (h.orch as unknown as { attemptBoot: string }).attemptBoot;
    h.store.turnAttempts.registerOwner(boot);
    const spec: DispatchSpec = {
      id: "worker-sso", target: h.record.channelRef, prompt: "ORIGINAL-BRIEF-DO-NOT-REPLAY",
      session: "live", kind: "handoff", createdUtc: h.record.createdUtc, stream: false,
    };
    const identity = executionIdentity({
      agentId: "claude", location: "local", session: "live", model: "fixture-model",
      effort: null, cwd: h.dir, config: h.record.configJson,
    });
    const row = h.store.turnAttempts.claim(spec, identity, boot);
    h.store.turnAttempts.bind(row, "fixture-acp");
    h.store.turnAttempts.startPrompt(row);
    expect(h.store.turnAttempts.markStalled(spec.id, `${REAUTH_WAITING_TEXT} url=https://device.example.com/start code=ABCD-EFGH`)).toBe(true);
    await expect(h.orch.dispatchInjectTurn(spec)).rejects.toMatchObject({
      reason: expect.stringContaining("reauth-waiting:"),
    });
    expect(h.prompt).not.toHaveBeenCalled();
    const after = h.store.turnAttempts.get(spec.id)!;
    expect(after.state).toBe("suspended");
    expect(after.stalledReason?.startsWith("reauth-waiting:")).toBe(true);
    expect(after.promptStarted).toBe(true);
    h.store.close();
  });
});
