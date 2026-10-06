/**
 * #302 production-path resume: the ACP initialize/load boundary, durable claim,
 * and orchestrator outcome handling must agree. No provider process is used.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { pino } from "pino";
import { classifyCodexError, type AgentProfile } from "@seam/adapters";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { inboundAttemptId } from "../packages/core/src/core/dispatch/attempt-store.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import type { ThreadPreset } from "../packages/core/src/config.js";
import type { ChoiceInteraction, IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";
import { makeChoiceCustomId } from "../packages/core/src/core/choice/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";
import * as owners from "../packages/core/src/core/dispatch/process-owner.js";
import { acceptReauthWait } from "../packages/core/src/core/reauth-negotiation.js";

const silent = pino({ level: "silent" }) as any;
const THREAD = "thread-302-runtime";
const PARENT = "channel-302-runtime";
const MODEL = "claude-opus-5";
const RECORDED = "acp-recorded-302";
const ORIGINAL = "finish the interrupted task";

interface AcpCalls {
  authRequired: boolean;
  initialized: number;
  loads: string[];
  news: number;
  prompts: string[];
  children: Array<{ killed: boolean }>;
}

function modelOptions() {
  return [{ id: "model", name: "Model", type: "select" as const, currentValue: MODEL,
    options: [{ value: MODEL, name: "Opus" }] }];
}

type AcpMode = "ok" | "no-load" | "reject-load" | "reject-load-once" | "hang-load" | "hang-load-once" | "codex-auth";
function syntheticAcp(calls: AcpCalls, mode: AcpMode) {
  return () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout, stderr, pid: undefined, detached: false, killed: false,
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals = "SIGTERM") {
        if (this.killed) return true;
        this.killed = true;
        this.signalCode = signal;
        this.emit("exit", null, signal);
        return true;
      },
    });
    calls.children.push(child);
    agent({ name: "synthetic-302-agent" })
      .onRequest(methods.agent.initialize, () => {
        calls.initialized++;
        return { protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: mode !== "no-load" } };
      })
      .onRequest(methods.agent.session.new, () => {
        calls.news++;
        return { sessionId: "acp-replacement", configOptions: modelOptions() };
      })
      .onRequest(methods.agent.session.load, ({ params }) => {
        calls.loads.push(params.sessionId);
        if (mode === "codex-auth" && calls.authRequired) {
          stderr.write("codex-acp: recorded session/load diagnostic\n");
          throw new RequestError(-32000, "Authentication required", null);
        }
        if (mode === "reject-load" || (mode === "reject-load-once" && calls.loads.length === 1)) throw new Error("synthetic remote session/load refusal");
        if (mode === "hang-load" || (mode === "hang-load-once" && calls.loads.length === 1)) return new Promise(() => {});
        return { sessionId: params.sessionId, configOptions: modelOptions() };
      })
      .onRequest(methods.agent.session.prompt, ({ params }) => {
        calls.prompts.push(params.prompt
          .filter((block): block is Extract<(typeof params.prompt)[number], { type: "text" }> => block.type === "text")
          .map((block) => block.text).join(""));
        return { stopReason: "end_turn" };
      })
      .onRequest(methods.agent.session.setConfigOption, () => ({ configOptions: modelOptions() }))
      .onNotification(methods.agent.session.cancel, () => {})
      .connect(ndJsonStream(
        Writable.toWeb(stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(stdin) as ReadableStream<Uint8Array>,
      ));
    return child as any;
  };
}

interface Harness {
  dir: string;
  store: SessionStore;
  router: SessionRouter;
  orch: Orchestrator;
  calls: AcpCalls;
  adapter: { sendMessage: ReturnType<typeof vi.fn> };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(location: "local" | "bridge-a", mode: AcpMode): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-302-runtime-"));
  const store = new SessionStore(path.join(dir, "seam.db"));
  const calls: AcpCalls = { authRequired: true, initialized: 0, loads: [], news: 0, prompts: [], children: [] };
  const agentId = mode === "codex-auth" ? "codex" : "claude";
  const profile = {
    id: agentId,
    ...(agentId === "codex" ? { classifyError: classifyCodexError } : {}),
    displayName: "Synthetic Claude",
    defaultModel: MODEL,
    staticModels: [{ modelId: MODEL, name: "Opus" }],
    effort: { mechanism: "none", levels: [] },
    spawn: syntheticAcp(calls, mode),
  } as unknown as AgentProfile;
  const threadPresets = new Map<string, ThreadPreset>(
    location === "local" ? [] : [[THREAD, { location }]],
  );
  const catalog = fixtureModelCatalog([profile]);
  const now = new Date().toISOString();
  store.upsert({ id: `discord:${THREAD}`, platform: "discord", channelRef: THREAD, parentRef: PARENT,
    agentId, acpSessionId: RECORDED, repoPath: dir, configJson: JSON.stringify({ model: MODEL }),
    createdUtc: now, updatedUtc: now });
  const router = new SessionRouter({ logger: silent, store, profiles: [profile], modelCatalog: catalog,
    defaultAgentId: agentId, defaultModel: MODEL, defaultPermissionMode: "deny",
    threadPresets, defaultCwd: dir, seamMcp: localBridgeWiring(profile),
    ...(mode === "hang-load" || mode === "hang-load-once" ? { sessionLoadTimeoutMs: 25 } : {}) });
  (router as any).startFailureCooldownMs = 0;
  if (location !== "local") {
    const localPlan = router.planRuntimeSpawn.bind(router);
    vi.spyOn(router, "planRuntimeSpawn").mockImplementation((record) => ({
      ...localPlan(record),
      remote: true,
      spawnChild: profile.spawn,
    }));
  }
  const adapter = {
    sendPanel: vi.fn(async (channel: any) => ({ channel, id: "panel" })),
    editPanel: vi.fn(async () => {}),
    sendMessage: vi.fn(async (channel: any) => ({ channel, id: "message" })),
    editMessage: vi.fn(async () => {}),
    sendChoiceCard: vi.fn(async (channel: any) => ({ channel, id: "reauth-choice" })),
    editChoiceCard: vi.fn(async () => {}),
  };
  const orch = new Orchestrator({ logger: silent, store, router, adapter: adapter as any,
    renderer: discordRenderer, modelCatalog: catalog,
    recoverySleep: async () => {},
    config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 15,
      DEFAULT_AGENT: "claude", DEFAULT_MODEL: MODEL, SEAM_TURN_RESUME_ENABLED: true,
      DISCORD_ALLOWED_USER_IDS: new Set(["human"]),
      SEAM_DISPATCH_STATUS_PANEL: false, channelPresets: new Map(), threadPresets,
      bridgePresets: new Map(), REPO_EMOJIS: new Map() } as any });
  cleanups.push(async () => { await router.disposeAll(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, router, orch, calls, adapter };
}

function seedPromptedAttempt(h: Harness, promptStarted = true): string {
  const currentOwner = owners.processOwner();
  if (!currentOwner) throw new Error("synthetic ownership fixture requires readable process identity");
  const ownerSpy = vi.spyOn(owners, "processOwner").mockReturnValue({ ...currentOwner, start: "0" });
  const record = h.store.get(`discord:${THREAD}`)!;
  h.store.admitInbound({ messageId: "msg-302", platform: "discord", channelRef: THREAD,
    parentRef: PARENT, sessionRecordId: record.id, authorId: "human", authorName: "Human",
    text: ORIGINAL, attachmentsJson: "[]", createdUtc: new Date().toISOString(),
    expectedAcpSessionId: RECORDED, preemptive: false } as never);
  const described = h.router.describeConfig(record);
  const { lastContextUsage: _usage, ...identityConfig } = h.store.readConfig(record);
  const id = inboundAttemptId("msg-302");
  h.store.turnAttempts.registerOwner("boot-before-restart");
  const claimed = h.store.turnAttempts.claim({ id, target: THREAD, prompt: ORIGINAL,
    session: "live", kind: "parked", createdUtc: new Date().toISOString() },
  executionIdentity({ agent: described.agent.value, location: described.location.value,
    model: described.model.value, effort: described.effort.value, cwd: described.cwd.value,
    config: identityConfig }), "boot-before-restart", "inbound");
  if (promptStarted) {
    h.store.turnAttempts.bind(claimed, RECORDED);
    h.store.turnAttempts.startPrompt(claimed);
  }
  h.store.turnAttempts.suspendBoot("boot-before-restart");
  ownerSpy.mockRestore();
  return id;
}

async function resume(h: Harness): Promise<void> {
  const message: IncomingMessage = { messageId: "msg-302", text: ORIGINAL,
    authorId: "human", authorName: "Human", authorIsBot: false,
    channel: { platform: "discord", id: THREAD, parentId: PARENT }, attachments: [] };
  await (h.orch as any).executeIncomingMessage(message);
}

describe("explicit operator continuation after identity drift", () => {
  function dispatchAttempt(h: Harness, promptStarted: boolean) {
    const boot = (h.orch as any).attemptBoot;
    const spec = { id: "operator-drift-dispatch", target: THREAD, prompt: ORIGINAL,
      kind: "handoff" as const, session: "live" as const, stream: false, reportBack: false };
    const record = h.store.get(`discord:${THREAD}`)!;
    const current = h.router.describeConfig(record);
    h.store.turnAttempts.registerOwner(boot);
    const claimed = h.store.turnAttempts.claim(spec, executionIdentity({
      agentId: record.agentId, location: "before-move", session: "live", model: current.model.value,
      effort: current.effort.value, cwd: current.cwd.value, config: record.configJson,
    }), boot);
    if (promptStarted) {
      h.store.turnAttempts.bind(claimed, RECORDED);
      h.store.turnAttempts.startPrompt(claimed);
    }
    h.store.turnAttempts.markStalled(spec.id, "thread moved from before-move to local");
    return spec;
  }

  it("the durable Resume button sends a never-started brief once under current configuration", async () => {
    const h = harness("local", "ok");
    const spec = dispatchAttempt(h, false);
    await expect(h.orch.dispatchInjectTurn(spec)).rejects.toMatchObject({ reason: expect.stringContaining("moved") });
    expect(h.calls.prompts).toEqual([]);
    const watcher = new DispatchWatcher({ dataDir: h.dir, logger: silent, attempts: h.store.turnAttempts,
      onDispatch: (spec, operatorResume) => h.orch.dispatchInjectTurn(spec, operatorResume) });
    (h.orch as any).dispatchWatcher = watcher;
    cleanups.push(() => watcher.stop());
    await h.orch.observeRetainedDispatch(spec);
    const card = h.store.listOpenChoiceCards("discord", THREAD)[0]!;
    expect(card.body).toContain("Use Resume");
    expect(card.options[0]!.label).toMatch(/^Resume /);
    const click = { customId: makeChoiceCustomId(card.id, 0), userId: "human", userName: "Human",
      channel: { platform: "discord", id: THREAD, parentId: PARENT }, messageId: card.messageId, kind: "button",
      replyEphemeral: vi.fn(async () => {}), followUpEphemeral: vi.fn(async () => {}), showModal: vi.fn() };
    await (h.orch as any).handleChoiceCardInteraction(click);
    await (h.orch as any).handleChoiceCardInteraction(click);
    await watcher.start();
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.calls.prompts[0]).toContain(ORIGINAL);
    expect(h.calls.prompts[0]).not.toMatch(/^continue\n/);
    expect(h.store.turnAttempts.get(spec.id)).toMatchObject({ state: "completed", generation: 2 });
    expect(JSON.parse(h.store.turnAttempts.get(spec.id)!.identity).location).toBe("local");
  });

  it("a started drifted dispatch reaches the actual provider session/load refusal", async () => {
    const h = harness("local", "reject-load");
    const spec = dispatchAttempt(h, true);
    await expect(h.orch.dispatchInjectTurn(spec)).rejects.toMatchObject({ reason: expect.stringContaining("moved") });
    expect(h.calls.loads).toEqual([]);
    await expect(h.orch.dispatchInjectTurn(spec, true)).rejects.toMatchObject({ message: expect.stringContaining("synthetic remote session/load refusal") });
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.prompts).toEqual([]);
    expect(h.calls.news).toBe(0);
  });

  it("explicit inbound continuation also bypasses drift while boot retains it", async () => {
    const h = harness("local", "ok");
    const id = seedPromptedAttempt(h, false);
    const record = h.store.get(`discord:${THREAD}`)!;
    h.store.upsert({ ...record, configJson: JSON.stringify({ model: MODEL, role: "current-role" }) });
    await expect(resume(h)).rejects.toMatchObject({ reason: expect.stringContaining("config") });
    expect(h.calls.prompts).toEqual([]);
    await (h.orch as any).executeIncomingMessage({ messageId: "msg-302", text: ORIGINAL,
      authorId: "human", authorName: "Human", authorIsBot: false,
      channel: { platform: "discord", id: THREAD, parentId: PARENT }, attachments: [] }, undefined, undefined, true);
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.calls.prompts[0]).toContain(ORIGINAL);
    expect(h.store.turnAttempts.get(id)?.state).toBe("completed");
  });
});

describe("#302 real ACP handshake and strict session/load recovery", () => {
  it.each([false, true])("keeps an auth park through repeated sweeps, then resumes once on acceptance (promptStarted=%s)", async promptStarted => {
    const h = harness("local", "codex-auth");
    const id = seedPromptedAttempt(h, promptStarted);
    h.store.claimInbound("msg-302", 0, new Date(Date.now() - 60_000).toISOString());
    await resume(h);
    const admission = h.store.getInbound("msg-302");
    const parked = h.store.turnAttempts.get(id)!;
    const card = h.store.listOpenChoiceCards("discord", THREAD)[0]!;
    const noticeCount = h.adapter.sendMessage.mock.calls.length;
    expect(card).toBeDefined();
    expect(parked).toMatchObject({ state: "suspended", promptStarted,
      stalledReason: expect.stringMatching(/^reauth-waiting:/) });
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    for (let tick = 0; tick < 35; tick++) {
      now += 60_000;
      expect(h.orch.inspectChannelQueue(THREAD)).toMatchObject({ state: "stalled", epoch: 0 });
      expect(await h.orch.sweepWedgedQueues()).toEqual([]);
    }
    clock.mockRestore();
    expect(h.store.getInbound("msg-302")).toEqual(admission);
    expect(h.store.turnAttempts.get(id)).toEqual(parked);
    expect(h.store.listConfigMutations()).toEqual([]);
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.prompts).toEqual([]);
    expect(h.adapter.sendMessage).toHaveBeenCalledTimes(noticeCount);
    expect(h.adapter.sendMessage.mock.calls.filter(call => String(call[1]).includes("Cause: Authentication required")))
      .toHaveLength(1);
    expect(h.store.listOpenChoiceCards("discord", THREAD)).toHaveLength(1);
    await expect(resume(h)).rejects.toMatchObject({ message: parked.stalledReason });

    h.calls.authRequired = false;
    const event: ChoiceInteraction = {
      customId: makeChoiceCustomId(card.id, 0), kind: "button", userId: "human", userName: "Human",
      channel: { platform: "discord", id: THREAD }, messageId: "reauth-choice",
      deferUpdate: vi.fn(async () => {}), followUpEphemeral: vi.fn(async () => {}),
      replyEphemeral: vi.fn(async () => {}), showModal: vi.fn(async () => {}),
    };
    const click = () => (h.orch as unknown as {
      handleChoiceCardInteraction(event: ChoiceInteraction): Promise<void>;
    }).handleChoiceCardInteraction(event);
    await click();
    await click();
    expect(h.store.getChoiceCard(card.id)?.clickCount).toBe(1);
    expect(event.replyEphemeral).toHaveBeenCalledWith("This card is closed.");
    expect(h.store.getInbound("msg-302")).toMatchObject({ state: "completed", queueEpoch: 0 });
    expect(h.store.turnAttempts.get(id)).toMatchObject({ state: "completed",
      generation: parked.generation + 1, deliveryDone: true });
    expect(h.calls.loads).toEqual([RECORDED, RECORDED]);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toHaveLength(1);
    if (promptStarted) {
      expect(h.calls.prompts[0]).toMatch(/^continue\n/);
      expect(h.calls.prompts[0]).not.toContain(ORIGINAL);
    } else {
      expect(h.calls.prompts[0]).toContain(ORIGINAL);
      expect(h.calls.prompts[0]).not.toMatch(/^continue\n/);
    }
  });

  it.each([false, true])("parks a recovered dispatch with promptStarted=%s when Codex session/load requires authentication", async promptStarted => {
    const h = harness("bridge-a", "codex-auth");
    const boot = (h.orch as unknown as { attemptBoot: string }).attemptBoot;
    const record = h.store.get(`discord:${THREAD}`)!;
    const d = h.router.describeConfig(record);
    const spec = { id: "codex-load-auth-dispatch", target: THREAD, prompt: ORIGINAL,
      session: "live" as const, kind: "handoff" as const,
      createdUtc: record.createdUtc, stream: false, reportBack: false };
    h.store.turnAttempts.registerOwner(boot);
    const claimed = h.store.turnAttempts.claim(spec, executionIdentity({
      agentId: "codex", location: "bridge-a", session: "live", model: d.model.value,
      effort: d.effort.value, cwd: d.cwd.value, config: record.configJson,
    }), boot);
    if (promptStarted) {
      h.store.turnAttempts.bind(claimed, RECORDED);
      h.store.turnAttempts.startPrompt(claimed);
    }
    h.store.turnAttempts.suspend(spec.id, boot);
    await expect(h.orch.dispatchInjectTurn(spec)).rejects.toMatchObject({
      reason: expect.stringMatching(/^reauth-waiting:/),
    });
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.prompts).toEqual([]);
    expect(h.store.turnAttempts.get(spec.id)).toMatchObject({
      state: "suspended", promptStarted, acpSessionId: promptStarted ? RECORDED : null, outcome: null,
      stalledReason: expect.stringMatching(/^reauth-waiting:/),
    });
    expect(h.adapter.sendMessage.mock.calls.map(call => String(call[1])).join("\n"))
      .toContain("Cause: Authentication required");
    expect(h.store.turnAttempts.get(spec.id)?.stallNoticeUtc).not.toBeNull();
    const noticeCount = h.adapter.sendMessage.mock.calls.length;
    await h.orch.observeRetainedDispatch(spec);
    expect(h.adapter.sendMessage.mock.calls).toHaveLength(noticeCount);
    await expect(h.orch.dispatchInjectTurn(spec)).rejects.toMatchObject({
      reason: expect.stringMatching(/^reauth-waiting:/),
    });
    expect(h.calls.loads).toEqual([RECORDED]);
    h.calls.authRequired = false;
    expect(acceptReauthWait(h.store.turnAttempts, spec.id)).not.toBeNull();
    await h.orch.dispatchInjectTurn(spec);
    expect(h.calls.loads).toEqual([RECORDED, RECORDED]);
    expect(h.calls.prompts).toHaveLength(1);
    if (promptStarted) {
      expect(h.calls.prompts[0]).toMatch(/^continue\n/);
      expect(h.calls.prompts[0]).not.toContain(ORIGINAL);
    } else {
      expect(h.calls.prompts[0]).toContain(ORIGINAL);
      expect(h.calls.prompts[0]).not.toMatch(/^continue\n/);
    }
    expect(h.store.turnAttempts.get(spec.id)?.state).toBe("completed");
  });

  it("parks pre-prompt inbound acquisition and sends the pending prompt once after sign-in", async () => {
    const h = harness("local", "codex-auth");
    const id = seedPromptedAttempt(h, false);
    await resume(h);
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toEqual([]);
    expect(h.store.turnAttempts.get(id)).toMatchObject({
      state: "suspended", promptStarted: false, acpSessionId: null, outcome: null,
      stalledReason: expect.stringMatching(/^reauth-waiting:/),
    });
    const notice = h.adapter.sendMessage.mock.calls.map(call => String(call[1])).join("\n");
    expect(notice).toContain("Cause: Authentication required");
    expect(notice).toContain("The pending prompt has not been sent; it will be sent once.");
    expect(notice).not.toContain("will not be replayed");
    h.calls.authRequired = false;
    expect(acceptReauthWait(h.store.turnAttempts, id)).not.toBeNull();
    await resume(h);
    expect(h.calls.loads).toEqual([RECORDED, RECORDED]);
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.calls.prompts[0]).toContain(ORIGINAL);
    expect(h.calls.prompts[0]).not.toMatch(/^continue\n/);
    expect(h.store.turnAttempts.get(id)?.state).toBe("completed");
  });

  it.each(["local", "bridge-a"] as const)("parks the exact Codex auth failure on %s session/load, then continues only after sign-in confirmation", async location => {
    const h = harness(location, "codex-auth");
    const id = seedPromptedAttempt(h);
    await resume(h);
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toEqual([]);
    expect(h.store.turnAttempts.get(id)).toMatchObject({
      state: "suspended", acpSessionId: RECORDED, promptStarted: true, outcome: null,
      stalledReason: expect.stringMatching(/^reauth-waiting:/),
    });
    const notice = h.adapter.sendMessage.mock.calls.map(call => String(call[1])).join("\n");
    expect(notice).toContain(`Codex on ${location === "local" ? os.hostname() : location} needs to sign in again (\`codex login\`)`);
    expect(notice).toContain("Cause: Authentication required");
    expect(notice).toContain("Authentication is done — continue");
    expect(notice).not.toContain("safety checks");
    expect(notice).not.toContain("boot recovery exhausted");
    await expect(resume(h)).rejects.toMatchObject({ reason: expect.stringMatching(/^reauth-waiting:/) });
    expect(h.calls.loads).toEqual([RECORDED]);
    h.calls.authRequired = false;
    expect(acceptReauthWait(h.store.turnAttempts, id)).not.toBeNull();
    await resume(h);
    expect(h.calls.loads).toEqual([RECORDED, RECORDED]);
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.calls.prompts[0]).toMatch(/^continue\n/);
    expect(h.calls.prompts[0]).not.toContain(ORIGINAL);
    expect(h.store.turnAttempts.get(id)?.state).toBe("completed");
  });

  it("loads the recorded Claude session and sends one continuation without replaying the brief", async () => {
    const h = harness("local", "ok"); const id = seedPromptedAttempt(h);
    const startedAt = performance.now();
    await resume(h);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(h.calls.initialized).toBe(1);
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.calls.prompts[0]?.startsWith("continue\n")).toBe(true);
    expect(h.calls.prompts[0]).toContain("The process restarted while the turn was in flight.");
    expect(h.calls.prompts[0]).not.toContain(ORIGINAL);
    expect(h.store.turnAttempts.get(id)).toMatchObject({ state: "completed", generation: 2 });
  });

  it("lands an initialize capability refusal suspended with its actionable reason", async () => {
    const h = harness("local", "no-load"); const id = seedPromptedAttempt(h);
    await resume(h);
    expect(h.calls.loads).toEqual([]);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toEqual([]);
    expect(h.store.turnAttempts.get(id)).toMatchObject({
      state: "suspended",
      generation: 2,
      stalledReason: "Strict resume refused: provider does not advertise session/load",
    });
  });

  it("uses the exact recorded session through a synthetic remote runtime with one continuation", async () => {
    const h = harness("bridge-a", "ok"); const id = seedPromptedAttempt(h);
    await resume(h);
    expect(h.router.describeConfig(h.store.get(`discord:${THREAD}`)!).location.value).toBe("bridge-a");
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.calls.prompts[0]?.startsWith("continue\n")).toBe(true);
    expect(h.calls.prompts[0]).toContain("The session runs on bridge-a. This resume does not include that host's git state.");
    expect(h.calls.prompts[0]).not.toContain(ORIGINAL);
    expect(h.store.turnAttempts.get(id)?.state).toBe("completed");
  });

  it.each(["no-load", "reject-load"] as const)(
    "keeps a synthetic remote %s refusal recoverably suspended with zero prompts",
    async (mode) => {
      const h = harness("bridge-a", mode); const id = seedPromptedAttempt(h);
      await resume(h);
      expect(h.calls.news).toBe(0);
      expect(h.calls.prompts).toEqual([]);
      expect(h.store.turnAttempts.get(id)).toMatchObject({
        state: "suspended",
        generation: 2,
        stalledReason: expect.stringMatching(mode === "no-load"
          ? /does not advertise session\/load/
          : /boot recovery exhausted 3 pre-prompt acquisition attempts/),
      });
      if (mode === "reject-load") {
        expect(h.calls.loads).toEqual([RECORDED, RECORDED, RECORDED]);
        // The count is unchanged; ownership is not. Each load now belongs to
        // one acquisition, not three retries inside a single router call.
        expect(h.calls.initialized).toBe(3);
        expect(h.calls.children.every(child => child.killed)).toBe(true);
      }
    },
  );

  it("bounds a silent session/load and records the named refusal as recoverably suspended", async () => {
    const h = harness("local", "hang-load"); const id = seedPromptedAttempt(h);
    const startedAt = performance.now();
    await resume(h);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(500);
    expect(h.calls.loads).toEqual([RECORDED, RECORDED, RECORDED]);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toEqual([]);
    expect(h.calls.children.every((child) => child.killed)).toBe(true);
    expect(h.store.turnAttempts.get(id)).toMatchObject({
      state: "suspended",
      generation: 2,
      stalledReason: expect.stringContaining("boot recovery exhausted 3 pre-prompt acquisition attempts"),
    });
  }, 1_000);

  it("retries a timed-out session/load in a fresh runtime and then continues once", async () => {
    const h = harness("bridge-a", "hang-load-once"); const id = seedPromptedAttempt(h);
    await resume(h);
    expect(h.calls.loads).toEqual([RECORDED, RECORDED]);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.calls.prompts[0]?.startsWith("continue\n")).toBe(true);
    expect(h.calls.prompts[0]).toContain("does not include that host's git state");
    expect(h.calls.children[0]?.killed).toBe(true);
    expect(h.store.turnAttempts.get(id)).toMatchObject({ state: "completed", generation: 2 });
  }, 10_000);

  it("#448 retries a rejected load through the acquisition owner and continues once", async () => {
    const h = harness("local", "reject-load-once"); const id = seedPromptedAttempt(h);
    await resume(h);
    expect(h.calls.loads).toEqual([RECORDED, RECORDED]);
    expect(h.calls.initialized).toBe(2);
    expect(h.calls.children[0]?.killed).toBe(true);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.calls.prompts[0]?.startsWith("continue\n")).toBe(true);
    expect(h.calls.prompts[0]).toContain("The process restarted while the turn was in flight.");
    expect(h.calls.prompts[0]).not.toContain(ORIGINAL);
    expect(h.store.turnAttempts.get(id)?.state).toBe("completed");
  });

  it("#448 strict router acquisition makes one load attempt and never creates a replacement session", async () => {
    const h = harness("local", "reject-load");
    const record = h.store.get(`discord:${THREAD}`)!;
    await expect(h.router.getOrStartRuntime(record, { resumeSessionId: RECORDED })).rejects.toThrow();
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.initialized).toBe(1);
    expect(h.calls.news).toBe(0);
    expect(h.calls.children[0]?.killed).toBe(true);
    expect(h.store.get(record.id)?.acpSessionId).toBe(RECORDED);
  });

  it("ordinary attachment leaves a failed load to its recovery owner and retains the session", async () => {
    const h = harness("local", "reject-load-once");
    const record = h.store.get(`discord:${THREAD}`)!;
    await expect(h.router.getOrStartRuntime(record)).rejects.toThrow("Internal error");
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.initialized).toBe(1);
    expect(h.calls.news).toBe(0);
    expect(h.calls.children[0]?.killed).toBe(true);
    expect(h.store.get(record.id)?.acpSessionId).toBe(RECORDED);
  });
});
