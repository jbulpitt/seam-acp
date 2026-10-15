import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { testSessionRouter } from "./helpers/session-fixture.js";
import type { IncomingMessage, ChannelRef } from "../packages/core/src/platforms/chat-adapter.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const root: ChannelRef = { platform: "google-chat", id: "session-home" };
const reply: ChannelRef = { ...root, id: "session-home.topic", parentId: root.id };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(detachB = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-chat-interrupt-"));
  const store = new SessionStore(path.join(dir, "seam.db"));
  const now = new Date().toISOString(), logger = pino({ level: "silent" });
  const record = { id: "google-chat:session-home", platform: root.platform, channelRef: root.id,
    parentRef: null, agentId: "codex", acpSessionId: "same-acp", repoPath: dir,
    configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const a = deferred(), b = deferred(), beganA = deferred(), beganB = deferred();
  let busy = false, cancelledA = false;
  let feed: (event: any) => Promise<void> = async () => {};
  const received: IncomingMessage[] = [], runs: Promise<void>[] = [], hosts: Orchestrator[] = [];
  const runtime = {
    onEvent(handler: typeof feed) { feed = handler; }, getSessionInfo: () => ({ sessionId: "same-acp" }),
    getProcessId: () => undefined, getProviderIdentity: () => "fixture",
    getFastModeOutcome: () => undefined, getPromptCapabilities: () => ({}), idle: async () => {},
    prompt: vi.fn(async (text: string) => {
      busy = true;
      try {
        if (text.includes("PROMPT_A")) {
          beganA.resolve(); await a.promise;
          if (cancelledA) return { stopReason: "cancelled", cancelled: true };
        } else {
          if (detachB) {
            const attempt = store.turnAttempts.get(`inbound-${received[1]!.messageId}`)!;
            store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "local", slot: 6,
              submissionId: "submission-B", acpSessionId: "same-acp", delegatedUtc: now });
          }
          beganB.resolve(); await b.promise;
          if (detachB) throw new Error("controller detached");
        }
        await feed({ kind: "agent-text", text: "B_FINAL" });
        return { stopReason: "end_turn" };
      } finally { busy = false; }
    }),
  };
  const router = testSessionRouter({ listProfiles: () => [], getProfile: () => undefined,
    ensureSessionRecord: () => store.get(record.id)!, isBusy: () => busy,
    describeConfig: () => ({ agent: { value: "codex" }, model: { value: "test" },
      effort: { value: null }, cwd: { value: dir }, location: { value: "local" }, fastMode: { value: false },
      role: { value: null }, disableThreadPrefix: { value: false } }),
    getOrStartRuntime: vi.fn(async () => runtime),
    abortTurn: vi.fn(async () => { cancelledA = true; a.resolve(); return "cancelled"; }),
  });
  let cards = 0;
  const output = {
    platform: root.platform,
    sendPanel: vi.fn(async (channel: ChannelRef, _panel: any) => ({ channel, id: `card-${++cards}` })),
    editPanel: vi.fn(async (_ref: any, _panel: any) => {}),
    sendMessage: vi.fn(async (channel: ChannelRef, _text: string, _options?: any) => ({ channel, id: "answer" })),
    editMessage: vi.fn(async () => {}),
    findMessageByNonce: vi.fn(async () => ({ status: "absent" })),
    getThreadLiveState: vi.fn(async () => ({ locked: false, archived: false })),
  };
  const make = () => {
    const host = new Orchestrator({ store, router: router as any, adapter: output as any, renderer: discordRenderer,
      modelCatalog: fixtureModelCatalog([]), logger: logger as any,
      config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60, DEFAULT_MODEL: "test", REPO_EMOJIS: new Map(),
        SEAM_TURN_RESUME_ENABLED: true, channelPresets: new Map(), threadPresets: new Map() } as any });
    hosts.push(host); return host;
  };
  const host = make();
  const space = { name: "spaces/session-home", spaceType: "SPACE", spaceThreadingState: "THREADED_MESSAGES" };
  const input = new GoogleChatAdapter({ logger, api: { request: vi.fn() } as any,
    subscription: "projects/test/subscriptions/events", allowedUserIds: new Set(["users/42"]), defaultCwd: dir,
    spaceEvents: { space: () => space, appUser: () => "users/seam", recordAppUser: vi.fn() } as any });
  input.setCommandDeps({ store, router, mutation: { readThreadPresetEntry: () => undefined },
    runtimeTransition: {}, cancelChannel: vi.fn() } as any);
  input.onMessage(message => {
    received.push(message);
    const run = (host as any).handleIncomingMessage(message) as Promise<void>;
    runs.push(run); return run;
  });
  const receive = (letter: "A" | "B", inThread: boolean, source: "direct" | "workspace" = "workspace") => input.receiveEvent({
    type: "MESSAGE", space, user: { name: "users/42", type: "HUMAN", displayName: "Tester" },
    message: { name: `${space.name}/messages/${letter}`, text: `PROMPT_${letter}`,
      thread: { name: `${space.name}/threads/topic` }, threadReply: inThread },
  }, undefined, undefined, source);
  cleanups.push(async () => {
    a.resolve(); b.resolve(); await Promise.allSettled(runs);
    for (const current of hosts) {
      await (current as any).queueOnChannel(root.id, async () => {});
      await (current as any).settleTrackedContinuations();
      current.suspendForRestart(); current.stopSentinelWatcher();
    }
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { store, record, host, make, input, receive, received, runs, output, router, runtime, a, b, beganA, beganB };
}

describe("Google Chat session Space priority interrupts", () => {
  it.each([false, true])("cancels A and settles its card while B keeps its own target (A in thread: %s)", async aInThread => {
    const h = fixture();
    await h.receive("A", aInThread); await h.beganA.promise;
    const first = h.store.listInboundNonterminal(root.id)[0]!;
    await h.receive("B", !aInThread);
    await vi.waitFor(() => expect(h.router.abortTurn).toHaveBeenCalledOnce());
    await h.beganB.promise;
    expect(h.router.abortTurn).toHaveBeenCalledWith(h.record.id, { force: true });
    expect(h.store.getInbound(first.messageId)?.state).toBe("completed");
    expect(h.store.turnAttempts.get(`inbound-${first.messageId}`)?.state).toBe("cancelled");
    await vi.waitFor(() => expect(h.output.editPanel.mock.calls.some(([ref, panel]) =>
      ref.id === "card-1" && JSON.stringify(panel).includes("Cancelled") && !panel.title.includes("Working"))).toBe(true));
    expect(h.output.sendPanel.mock.calls.map(([target]) => target)).toEqual(aInThread ? [reply, root] : [root, reply]);
    h.b.resolve(); await Promise.all(h.runs);
    const final = h.output.sendMessage.mock.calls.filter(([, text]) => text === "B_FINAL");
    expect(final).toHaveLength(1);
    expect(final[0]![0]).toEqual(aInThread ? root : reply);
    await h.receive("B", !aInThread, "direct");
    await Promise.all(h.runs);
    expect(h.runtime.prompt).toHaveBeenCalledTimes(2);
    expect(h.store.listInboundNonterminal(root.id)).toEqual([]);
    expect(h.store.get(h.record.id)?.acpSessionId).toBe("same-acp");
  });

  it("reattaches B after restart without reviving A or submitting either prompt again", async () => {
    const h = fixture(true);
    await h.receive("A", false); await h.beganA.promise;
    await h.receive("B", true);
    await vi.waitFor(() => expect(h.router.abortTurn).toHaveBeenCalledOnce());
    await h.beganB.promise;
    const aId = `inbound-${h.received[0]!.messageId}`, bId = `inbound-${h.received[1]!.messageId}`;
    h.host.suspendForRestart(); h.b.resolve(); await Promise.all(h.runs);
    expect(h.store.turnAttempts.get(aId)?.state).toBe("cancelled");
    expect(h.store.turnAttempts.get(bId)?.state).toBe("suspended");
    const child = Object.assign(new EventEmitter(), { detach: vi.fn(), kill: vi.fn() });
    const mux = { adopt: vi.fn(() => child), sendCmd: vi.fn(async () => ({ health: [{ slot: 6, alive: true, attached: true,
      recovery: { version: 1, owner: "bridge", submissionId: "submission-B", acpSessionId: "same-acp",
        rung: 1, phase: "executing", retry: 0, budget: 3, remaining: 3, disposition: "none", updatedUtc: new Date().toISOString() } }] })) };
    vi.spyOn(h.router, "adoptRecoveryRuntime").mockReturnValue({ onEvent: vi.fn(), idle: async () => {}, watchInFlightHang: async () => {} } as any);
    vi.spyOn(h.router, "releaseRecoveryRuntime").mockReturnValue(false);
    const restarted = h.make();
    restarted.setBridgeHub({ muxFor: () => mux, slotHealthFor: () => [], onBridgeReady: () => () => {} } as any);
    await restarted.recoverInterruptedTurns();
    expect(mux.adopt).toHaveBeenCalledOnce();
    child.emit("remoteRecoveryResult", { version: 1, submissionId: "submission-B", acpSessionId: "same-acp",
      status: "completed", text: "B_RECOVERED", stopReason: "end_turn", finishedUtc: new Date().toISOString() });
    await (restarted as any).queueOnChannel(root.id, async () => {});
    await vi.waitFor(() => expect(h.store.turnAttempts.get(bId)?.deliveryDone).toBe(true));
    expect(h.store.turnAttempts.get(aId)?.state).toBe("cancelled");
    expect(h.runtime.prompt).toHaveBeenCalledTimes(2);
    expect(h.output.sendMessage.mock.calls.filter(([, text]) => text === "B_RECOVERED"))
      .toEqual([[reply, "B_RECOVERED", expect.objectContaining({ enforceNonce: true })]]);
    expect(h.store.listInboundNonterminal(root.id)).toEqual([]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("settles a superseded prompted card after a crash between admission and live finalization", async () => {
    const h = fixture(), now = new Date().toISOString();
    const admit = (id: string) => h.store.admitInbound({ messageId: id, platform: root.platform,
      channelRef: root.id, deliveryChannel: id === "A" ? reply : root, sessionRecordId: h.record.id,
      authorId: "42", text: id, createdUtc: now });
    admit("A"); h.store.claimInbound("A", 0, now);
    const attempt = h.store.turnAttempts.claim({ id: "inbound-A", target: root.id, prompt: "A", session: "live", createdUtc: now },
      "fixture", "previous-boot", "inbound");
    h.store.turnAttempts.bind(attempt, "same-acp"); h.store.turnAttempts.startPrompt(attempt);
    h.store.turnAttempts.bindStatusCard(attempt, { channelId: reply.id, messageId: "old-card" });
    admit("B");
    expect(h.store.getInbound("A")?.state).toBe("completed");
    const restarted = h.make();
    await (restarted as any).recoverInboundOutput();
    expect(h.output.editPanel).toHaveBeenCalledWith({ channel: { platform: "google-chat", id: reply.id }, id: "old-card" },
      expect.objectContaining({ title: expect.not.stringContaining("Working"),
        fields: expect.arrayContaining([expect.objectContaining({ name: "Action", value: expect.stringContaining("Cancelled") })]) }));
    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(h.store.getInbound("B")?.state).toBe("pending");
  });
});
