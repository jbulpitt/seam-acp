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
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { inboundAttemptId } from "../packages/core/src/core/dispatch/attempt-store.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import type { ThreadPreset } from "../packages/core/src/config.js";
import type { IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import * as owners from "../packages/core/src/core/dispatch/process-owner.js";

const silent = pino({ level: "silent" }) as any;
const THREAD = "thread-302-runtime";
const PARENT = "channel-302-runtime";
const MODEL = "claude-opus-5";
const RECORDED = "acp-recorded-302";
const ORIGINAL = "finish the interrupted task";

interface AcpCalls {
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

function syntheticAcp(calls: AcpCalls, mode: "ok" | "no-load" | "reject-load" | "hang-load") {
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
        if (mode === "reject-load") throw new Error("synthetic remote session/load refusal");
        if (mode === "hang-load") return new Promise(() => {});
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
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(location: "local" | "bridge-a", mode: "ok" | "no-load" | "reject-load" | "hang-load"): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-302-runtime-"));
  const store = new SessionStore(path.join(dir, "seam.db"));
  const calls: AcpCalls = { initialized: 0, loads: [], news: 0, prompts: [], children: [] };
  const profile = {
    id: "claude",
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
    agentId: "claude", acpSessionId: RECORDED, repoPath: dir, configJson: JSON.stringify({ model: MODEL }),
    createdUtc: now, updatedUtc: now });
  const router = new SessionRouter({ logger: silent, store, profiles: [profile], modelCatalog: catalog,
    defaultAgentId: "claude", defaultModel: MODEL, defaultPermissionMode: "deny",
    threadPresets, defaultCwd: dir,
    ...(mode === "hang-load" ? { sessionLoadTimeoutMs: 25 } : {}) });
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
  };
  const orch = new Orchestrator({ logger: silent, store, router, adapter: adapter as any,
    renderer: discordRenderer, modelCatalog: catalog,
    config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 15,
      DEFAULT_AGENT: "claude", DEFAULT_MODEL: MODEL, SEAM_TURN_RESUME_ENABLED: true,
      SEAM_DISPATCH_STATUS_PANEL: false, channelPresets: new Map(), threadPresets,
      bridgePresets: new Map(), REPO_EMOJIS: new Map() } as any });
  cleanups.push(async () => { await router.disposeAll(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, router, orch, calls };
}

function seedPromptedAttempt(h: Harness): string {
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
  h.store.turnAttempts.bind(claimed, RECORDED);
  h.store.turnAttempts.startPrompt(claimed);
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

describe("#302 real ACP handshake and strict session/load recovery", () => {
  it("loads the recorded Claude session and sends one continuation without replaying the brief", async () => {
    const h = harness("local", "ok"); const id = seedPromptedAttempt(h);
    const startedAt = performance.now();
    await resume(h);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(h.calls.initialized).toBe(1);
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toEqual(["continue"]);
    expect(h.calls.prompts).not.toContain(ORIGINAL);
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
    expect(h.calls.prompts).toEqual(["continue"]);
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
          : /Strict resume refused: session\/load failed after retries/),
      });
      if (mode === "reject-load") expect(h.calls.loads).toEqual([RECORDED, RECORDED, RECORDED]);
    },
  );

  it("bounds a silent session/load and records the named refusal as recoverably suspended", async () => {
    const h = harness("local", "hang-load"); const id = seedPromptedAttempt(h);
    const startedAt = performance.now();
    await resume(h);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(500);
    expect(h.calls.loads).toEqual([RECORDED]);
    expect(h.calls.news).toBe(0);
    expect(h.calls.prompts).toEqual([]);
    expect(h.calls.children[0]?.killed).toBe(true);
    expect(h.store.turnAttempts.get(id)).toMatchObject({
      state: "suspended",
      generation: 2,
      stalledReason: "Strict resume refused: ACP session/load timed out after 0.025s for agent 'claude'; the session was not resumed and can be retried",
    });
  }, 1_000);
});
