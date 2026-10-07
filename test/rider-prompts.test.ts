import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import { localBridgeHub, localBridgeWiring } from "./local-bridge-fixture.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const THREAD = "1550000000000000001";
const PARENT = "1550000000000000002";
const MODEL = "rider-fixture-model";
const CHANNEL_RIDER = "CHANNEL_RIDER_MARKER: retain this channel rule.";
const THREAD_RIDER = "THREAD_RIDER_MARKER: retain this thread rule too.";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function expectRiders(prompt: string) {
  expect(prompt).toContain(CHANNEL_RIDER);
  expect(prompt).toContain(THREAD_RIDER);
  expect(prompt.indexOf(CHANNEL_RIDER)).toBeLessThan(prompt.indexOf(THREAD_RIDER));
  expect(prompt.split(CHANNEL_RIDER)).toHaveLength(2);
  expect(prompt.split(THREAD_RIDER)).toHaveLength(2);
}

function setup(parentRef: string | null = PARENT) {
  const cwd = mkdtempSync(path.join(tmpdir(), "seam-rider-prompts-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionStore(path.join(cwd, "test.db"));
  cleanups.push(() => store.close());
  const prompts: string[] = [];
  let sequence = 0;
  const spawn = () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout, stderr, pid: undefined, killed: false, exitCode: null,
      kill() { this.killed = true; this.emit("exit", null, "SIGTERM"); return true; },
    });
    const configOptions = [{ id: "model", name: "Model", type: "select" as const,
      currentValue: MODEL, options: [{ value: MODEL, name: MODEL }] }];
    agent({ name: "rider-fixture" })
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true } }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: `rider-acp-${++sequence}`, configOptions }))
      .onRequest(methods.agent.session.load, ({ params }) => ({ sessionId: params.sessionId, configOptions }))
      .onRequest(methods.agent.session.setConfigOption, () => ({ configOptions }))
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        prompts.push(params.prompt.map(part => part.type === "text" ? part.text : "").join("\n"));
        await client.notify(methods.client.session.update, { sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fixture completed." } } });
        return { stopReason: "end_turn" };
      })
      .onNotification(methods.agent.session.cancel, () => {})
      .connect(ndJsonStream(Writable.toWeb(stdout), Readable.toWeb(stdin)));
    return child as any;
  };
  const profile = { id: "rider-fixture", displayName: "Rider fixture", defaultModel: MODEL,
    spawn: vi.fn(() => { throw new Error("must use the synthetic bridge"); }),
    sessionManager: { deleteSession: async () => {}, getTranscript: async () => "" } } as unknown as AgentProfile;
  const config = {
    DATA_DIR: cwd, REPOS_ROOT: cwd, DEFAULT_AGENT: profile.id, DEFAULT_MODEL: MODEL,
    TURN_TIMEOUT_SECONDS: 15, SEAM_DISPATCH_STATUS_PANEL: false,
    SEAM_DISPATCH_OUTPUT_STYLE: "messages", SEAM_TURN_RESUME_ENABLED: true,
    SEAM_CONFIG_ADMIN_USER_IDS: new Set(), SEAM_PARTICIPANT_USER_IDS: new Set(),
    REPO_EMOJIS: new Map(),
    channelPresets: new Map([[PARENT, { rider: { value: CHANNEL_RIDER } }]]),
    threadPresets: new Map([[THREAD, { rider: { value: THREAD_RIDER } }]]),
  };
  const modelCatalog = fixtureModelCatalog([profile]);
  const wiring = localBridgeWiring(spawn);
  const router = new SessionRouter({ logger: pino({ level: "silent" }) as any, store,
    profiles: [profile], modelCatalog, defaultAgentId: profile.id, defaultModel: MODEL,
    defaultCwd: cwd, channelPresets: config.channelPresets, threadPresets: config.threadPresets,
    executionBridge: wiring as any, seamMcp: wiring });
  cleanups.push(() => router.disposeAll());
  const record = router.ensureSessionRecord({ platform: "discord", channelRef: THREAD,
    ...(parentRef ? { parentRef } : {}), cwd });
  const adapter = {
    resolveChannel: vi.fn(async (channel: any) => ({ ...channel, parentId: PARENT })),
    sendMessage: vi.fn(async (channel: any) => ({ channel, id: `message-${++sequence}` })),
    sendPanel: vi.fn(async (channel: any) => ({ channel, id: `panel-${++sequence}` })),
    editPanel: vi.fn(async () => {}), editMessage: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
    findMessageByNonce: vi.fn(async () => ({ status: "absent" })),
  };
  const orch = new Orchestrator({ logger: pino({ level: "silent" }) as any, store, router,
    adapter: adapter as any, config: config as any, renderer: discordRenderer, modelCatalog });
  orch.setBridgeHub(localBridgeHub([profile], cwd, wiring));
  orch.setSelfMigrationHandler(async target => ({ ok: true, record: target,
    agent: profile.id, model: MODEL, newSessionId: target.acpSessionId } as any));
  return { orch, store, router, adapter, record, profile, cwd, prompts, config };
}

describe("current channel and thread riders at the ACP prompt boundary", () => {
  it.each([
    ["handoff", "live"], ["handoff", "isolated"], ["forward", "live"],
    ["wake", "live"], ["choice", "live"], ["choice", "isolated"],
    ["migrate_self", "live"], ["ingest", "live"],
  ] as const)("stacks channel then thread for %s / %s", async (kind, session) => {
    const h = setup();
    const spec: DispatchSpec = { id: `rider-${kind}-${session}`, target: THREAD, prompt: "Do this task.",
      kind, session, createdUtc: new Date().toISOString(),
      ...(kind === "migrate_self" ? { migration: { agent: h.profile.id, model: MODEL } as any } : {}) };
    const result = await h.orch.dispatchInjectTurn(spec);
    expect(result.output).toBe("Fixture completed.");
    expect(h.prompts).toHaveLength(1);
    expectRiders(h.prompts[0]!);
    expect(h.prompts[0]).toContain(spec.prompt);
  });

  it("resolves a missing parent from Discord before dispatching", async () => {
    const h = setup(null);
    await h.orch.dispatchInjectTurn({ id: "rider-parent", target: THREAD, prompt: "Task.",
      kind: "handoff", session: "isolated", createdUtc: new Date().toISOString() });
    expect(h.adapter.resolveChannel).toHaveBeenCalledWith({ platform: "discord", id: THREAD });
    expect(h.store.get(h.record.id)?.parentRef).toBe(PARENT);
    expectRiders(h.prompts[0]!);
  });

  it("stacks the binding thread's riders for an isolated schedule", async () => {
    const h = setup(), now = new Date().toISOString();
    const row: ScheduledPrompt = { id: "rider-schedule", platform: "discord", channelRef: THREAD,
      parentRef: PARENT, name: "Rider schedule", promptText: "Scheduled task.", cron: "* * * * *",
      timezone: "UTC", model: null, cwd: null, targetChannel: "1550000000000000003", outputType: "messages",
      sessionMode: "isolated", catchupSeconds: 0, enabled: true, legacyAttachmentCount: 0,
      createdBy: "user", createdUtc: now, updatedUtc: now, lastRunUtc: null, lastStatus: null,
      nextRunUtc: null, pinnedSessionId: null };
    h.store.upsertScheduled(row);
    await h.orch.runScheduledPrompt(row.id);
    expect(h.store.getScheduled(row.id)?.lastStatus).toBe("ok");
    expect(h.prompts).toHaveLength(1);
    expectRiders(h.prompts[0]!);
    expect(h.prompts[0]).toContain(row.promptText);
  });

  it("uses authoring riders for headless ingest, not the notification thread", async () => {
    const h = setup();
    h.store.insertIngestEndpoint({ id: "ie_riders", tokenHash: "fixture", name: "Rider ingest",
      cwd: h.cwd, location: "local", agentId: h.profile.id, model: MODEL, effort: null,
      wrapper: null, resultSchema: null, corsOrigins: null, uniqueStudent: false, notifyThread: null,
      thread: null, preset: null, status: "open", createdBy: h.record.id, createdUtc: new Date().toISOString(),
      authoringChannelRef: THREAD, authoringParentRef: PARENT, platform: "discord" });
    const result = await h.orch.dispatchInjectTurn({ id: "rider-ingest", target: "ingest:ie_riders",
      prompt: "Ingest task.", kind: "ingest", session: "isolated", correlationId: "ie_riders",
      createdUtc: new Date().toISOString() });
    expect(result.output).toBe("Fixture completed.");
    expect(h.prompts).toHaveLength(1);
    expectRiders(h.prompts[0]!);
    expect(h.prompts[0]).toContain("Ingest task.");
  });

  it("carries current riders into a compaction seed", async () => {
    const h = setup();
    await (h.orch as any).seedNewSession({ profile: h.profile, restrictionChannelId: PARENT,
      cwd: h.cwd, location: "local", sessionId: h.record.id, model: MODEL, summary: "Prior context." });
    expect(h.prompts).toHaveLength(1);
    expectRiders(h.prompts[0]!);
    expect(h.prompts[0]).toContain("Prior context.");
  });
});
