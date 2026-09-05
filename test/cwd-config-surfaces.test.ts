import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { MessageFlags } from "discord.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { AgentProfile } from "@seam/adapters";
import type { ChannelPreset, ThreadPreset } from "../packages/core/src/config.js";
import type { SessionRecord, StructuredPanel } from "../packages/core/src/core/types.js";
import type { ChannelRef, IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const ADMIN = "1487094572696867019";

let dir: string;

const profiles = [
  { id: "copilot", effort: { mechanism: "none", levels: [] } },
] as unknown as AgentProfile[];

function slashI(over: {
  channelId?: string;
  parentId?: string;
  strings?: Record<string, string | null>;
}) {
  const replies: Array<{ content?: string; flags?: number }> = [];
  const edits: string[] = [];
  const i = {
    options: {
      getString: (name: string, _req?: boolean) => over.strings?.[name] ?? null,
    },
    user: { id: ADMIN, username: "jesse" },
    channelId: over.channelId ?? "333333333333333333",
    channel: {
      isThread: () => true,
      parentId: over.parentId ?? "111111111111111111",
    },
    deferred: false,
    replied: false,
    reply: vi.fn(async (payload: { content?: string; flags?: number }) => {
      i.replied = true;
      replies.push(payload);
    }),
    deferReply: vi.fn(async () => {
      i.deferred = true;
    }),
    editReply: vi.fn(async (content: string) => {
      edits.push(content);
    }),
  };
  return { i, replies, edits };
}

function makeOrch() {
  const presetsFile = path.join(dir, "channel-presets.json");
  fs.writeFileSync(presetsFile, JSON.stringify({ channels: {}, threads: {} }));
  const channelPresets = new Map<string, ChannelPreset>();
  const threadPresets = new Map<string, ThreadPreset>();
  const store = new SessionStore(path.join(dir, "seam.db"));
  const router = new SessionRouter({
    logger: silent,
    store,
    profiles,
    defaultAgentId: "copilot",
    defaultModel: "gpt-5.4",
    defaultPermissionMode: "ask",
    channelPresets,
    threadPresets,
    defaultCwd: dir,
  });
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "gpt-5.4",
      DEFAULT_AGENT: "copilot",
      CHANNEL_PRESETS_FILE: presetsFile,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      channelPresets,
      threadPresets,
      bridgePresets: new Map(),
      REPO_EMOJIS: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    } as any,
    adapter: {} as any,
    router,
    store,
    renderer: {} as any,
  });
  return { orch, router, store, presetsFile, channelPresets, threadPresets };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-cwd-surfaces-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("/seam config repo scope", () => {
  it("scope:session writes the session row repoPath", async () => {
    const { orch, store } = makeOrch();
    const { i, replies } = slashI({ strings: { path: "alpha", scope: "session" } });
    await (orch as any).cmdRepo(i);
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(replies[0]?.content).toMatch(/Repo set to/);
    const rec = store.get("discord:333333333333333333");
    expect(rec?.repoPath).toBe(path.resolve(dir, "alpha"));
    expect(store.readConfig(rec!).sessionCwdExplicit).toBe(true);
  });

  it("scope:thread writes the thread-preset cwd overlay", async () => {
    const { orch, threadPresets, store, router } = makeOrch();
    const { i } = slashI({ strings: { path: "beta", scope: "thread" } });
    await (orch as any).cmdRepo(i);
    expect(threadPresets.get("333333333333333333")?.cwd?.value).toBe(path.resolve(dir, "beta"));
    const rec = store.get("discord:333333333333333333");
    expect(rec?.repoPath).not.toBe(path.resolve(dir, "beta"));
    expect(store.readConfig(rec!).sessionCwdExplicit).not.toBe(true);
    expect(router.describeConfig(rec!).cwd).toEqual({
      value: path.resolve(dir, "beta"),
      source: "thread preset",
    });
  });

  it("scope:channel writes the caller's parent overlay only", async () => {
    const { orch, channelPresets, presetsFile } = makeOrch();
    const { i, replies } = slashI({
      parentId: "111111111111111111",
      strings: { path: "gamma", scope: "channel" },
    });
    await (orch as any).cmdRepo(i);
    expect(replies[0]?.content).toMatch(/Channel repo set/);
    expect(channelPresets.get("111111111111111111")?.cwd?.value).toBe(path.resolve(dir, "gamma"));
    expect(channelPresets.get("999999999999999999")).toBeUndefined();
    const raw = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
    expect(Object.keys(raw.channels)).toEqual(["111111111111111111"]);
  });

  it("resolver is session > thread preset > channel preset", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { cwd: { value: "/repo/chan" }, locked: false }],
    ]);
    const threadPresets = new Map<string, ThreadPreset>([
      ["thread-1", { cwd: { value: "/repo/thread" } }],
    ]);
    const store = new SessionStore(path.join(dir, "seam.db"));
    const router = new SessionRouter({
      logger: silent,
      store,
      profiles,
      defaultAgentId: "copilot",
      defaultModel: "gpt-5.4",
      defaultPermissionMode: "ask",
      channelPresets,
      threadPresets,
    });
    const session: SessionRecord = {
      id: "discord:thread-1",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "chan-1",
      agentId: "copilot",
      acpSessionId: "",
      repoPath: "/repo/session",
      configJson: "{}",
      createdUtc: "2026-01-01T00:00:00Z",
      updatedUtc: "2026-01-01T00:00:00Z",
    };
    expect(router.describeConfig(session).cwd).toEqual({
      value: "/repo/session",
      source: "session config",
    });
    expect(router.planRuntimeSpawn(session).cwd).toBe("/repo/session");
    expect(router.describeConfig({ ...session, repoPath: null }).cwd).toEqual({
      value: "/repo/thread",
      source: "thread preset",
    });
    expect(
      router.describeConfig({ ...session, repoPath: null, channelRef: "other" }).cwd
    ).toEqual({
      value: "/repo/chan",
      source: "channel preset",
    });
  });
});

describe("DB preset repoPath applies as cwd", () => {
  it("upsertPreset stores repoPath and apply writes it onto the session", async () => {
    const { orch, store } = makeOrch();
    store.upsertPreset({
      id: "p-reviewer",
      name: "reviewer",
      projectRef: "chan-1",
      description: null,
      agentId: "copilot",
      model: "gpt-5.4",
      effort: null,
      repoPath: path.join(dir, "special"),
      permission: null,
      toolsAllow: null,
      toolsExclude: null,
      instructions: null,
      statusCardStyle: null,
      createdBy: ADMIN,
      createdUtc: "2026-01-01T00:00:00Z",
      updatedUtc: "2026-01-01T00:00:00Z",
    });
    const record = {
      id: "discord:thread-1",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "chan-1",
      agentId: "copilot",
      acpSessionId: "old",
      repoPath: path.join(dir, "other"),
      configJson: "{}",
      createdUtc: "2026-01-01T00:00:00Z",
      updatedUtc: "2026-01-01T00:00:00Z",
    };
    store.upsert(record);
    await (orch as any).applyPresetToSession(
      { platform: "discord", id: "thread-1", parentId: "chan-1" },
      record,
      store.getPreset("p-reviewer")!
    );
    expect(store.get("discord:thread-1")?.repoPath).toBe(path.join(dir, "special"));
    expect(store.readConfig(store.get("discord:thread-1")!).sessionCwdExplicit).toBe(true);
  });
});

const THREAD = "333333333333333333";
const PARENT = "111111111111111111";

describe("#207 stale REPOS_ROOT session cwd vs thread overlay", () => {
  it("does not stamp REPOS_ROOT into repoPath on session creation", () => {
    const { router, store } = makeOrch();
    const rec = router.ensureSessionRecord({
      platform: "discord",
      channelRef: THREAD,
      parentRef: PARENT,
      cwd: dir,
    });
    expect(rec.repoPath).toBeNull();
    expect(store.get(rec.id)?.repoPath).toBeNull();
    expect(router.describeConfig(rec).cwd).toEqual({ value: dir, source: "default" });
    expect(router.planRuntimeSpawn(rec).cwd).toBe(dir);
  });

  it("creation with a live thread overlay keeps repoPath unset and sources thread", () => {
    const selected = path.join(dir, "seam-acp");
    const { router, threadPresets } = makeOrch();
    threadPresets.set(THREAD, { cwd: { value: selected } });
    const rec = router.ensureSessionRecord({
      platform: "discord",
      channelRef: THREAD,
      parentRef: PARENT,
      cwd: dir,
    });
    expect(rec.repoPath).toBeNull();
    expect(router.describeConfig(rec).cwd).toEqual({
      value: selected,
      source: "thread preset",
    });
    expect(router.planRuntimeSpawn(rec).cwd).toBe(selected);
  });

  it("stale REPOS_ROOT row + thread overlay: describeConfig and spawn use the selected repo", async () => {
    const selected = path.resolve(dir, "seam-acp");
    const { orch, router, store, threadPresets } = makeOrch();
    store.upsert({
      id: `discord:${THREAD}`,
      platform: "discord",
      channelRef: THREAD,
      parentRef: PARENT,
      agentId: "copilot",
      acpSessionId: "acp-stale",
      repoPath: dir,
      configJson: "{}",
      createdUtc: "2026-01-01T00:00:00Z",
      updatedUtc: "2026-01-01T00:00:00Z",
    });
    const { i } = slashI({ strings: { path: "seam-acp", scope: "thread" } });
    await (orch as any).cmdRepo(i);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.repoPath).toBe(dir);
    expect(threadPresets.get(THREAD)?.cwd?.value).toBe(selected);
    expect(router.describeConfig(rec).cwd).toEqual({
      value: selected,
      source: "thread preset",
    });
    expect(router.planRuntimeSpawn(rec).cwd).toBe(selected);
    expect(router.effectiveCwd(rec)).toBe(selected);
  });

  it("repeated thread-scope selections take effect each time without SQLite edits", async () => {
    const first = path.resolve(dir, "seam-acp");
    const second = path.resolve(dir, "other");
    const { orch, router, store } = makeOrch();
    store.upsert({
      id: `discord:${THREAD}`,
      platform: "discord",
      channelRef: THREAD,
      parentRef: PARENT,
      agentId: "copilot",
      acpSessionId: "",
      repoPath: dir,
      configJson: "{}",
      createdUtc: "2026-01-01T00:00:00Z",
      updatedUtc: "2026-01-01T00:00:00Z",
    });
    await (orch as any).cmdRepo(slashI({ strings: { path: "seam-acp", scope: "thread" } }).i);
    expect(router.describeConfig(store.get(`discord:${THREAD}`)!).cwd.value).toBe(first);
    await (orch as any).cmdRepo(slashI({ strings: { path: "other", scope: "thread" } }).i);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.repoPath).toBe(dir);
    expect(router.describeConfig(rec).cwd).toEqual({
      value: second,
      source: "thread preset",
    });
    expect(router.planRuntimeSpawn(rec).cwd).toBe(second);
  });

  it("an explicit session-scope repo still wins over a later thread overlay", async () => {
    const sessionRepo = path.resolve(dir, "alpha");
    const threadRepo = path.resolve(dir, "beta");
    const { orch, router, store } = makeOrch();
    await (orch as any).cmdRepo(slashI({ strings: { path: "alpha", scope: "session" } }).i);
    await (orch as any).cmdRepo(slashI({ strings: { path: "beta", scope: "thread" } }).i);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.repoPath).toBe(sessionRepo);
    expect(store.readConfig(rec).sessionCwdExplicit).toBe(true);
    expect(router.describeConfig(rec).cwd).toEqual({
      value: sessionRepo,
      source: "session config",
    });
    expect(router.planRuntimeSpawn(rec).cwd).toBe(sessionRepo);
    expect(router.planRuntimeSpawn(rec).cwd).not.toBe(threadRepo);
  });

  it("an explicit session pin to REPOS_ROOT still wins over a thread overlay", async () => {
    const selected = path.resolve(dir, "seam-acp");
    const { orch, router, store, threadPresets } = makeOrch();
    await (orch as any).cmdRepo(slashI({ strings: { path: dir, scope: "session" } }).i);
    threadPresets.set(THREAD, { cwd: { value: selected } });
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.repoPath).toBe(path.resolve(dir));
    expect(store.readConfig(rec).sessionCwdExplicit).toBe(true);
    expect(router.describeConfig(rec).cwd).toEqual({
      value: path.resolve(dir),
      source: "session config",
    });
  });

  it("channel overlay wins when session repoPath is the stale default and no thread overlay exists", () => {
    const channelRepo = path.resolve(dir, "chan-repo");
    const { router, store, channelPresets } = makeOrch();
    channelPresets.set(PARENT, { cwd: { value: channelRepo }, locked: false });
    store.upsert({
      id: `discord:${THREAD}`,
      platform: "discord",
      channelRef: THREAD,
      parentRef: PARENT,
      agentId: "copilot",
      acpSessionId: "",
      repoPath: dir,
      configJson: "{}",
      createdUtc: "2026-01-01T00:00:00Z",
      updatedUtc: "2026-01-01T00:00:00Z",
    });
    const rec = store.get(`discord:${THREAD}`)!;
    expect(router.describeConfig(rec).cwd).toEqual({
      value: channelRepo,
      source: "channel preset",
    });
    expect(router.planRuntimeSpawn(rec).cwd).toBe(channelRepo);
  });
});

function fakeAcpSpawn(sessionNews: string[], sessionLoads: string[]) {
  return () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      pid: undefined,
      killed: false,
      kill() {
        this.killed = true;
        this.emit("exit", 0, null);
        return true;
      },
    });
    agent({ name: "cwd-207-agent" })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(methods.agent.session.new, ({ params }) => {
        sessionNews.push(params.cwd);
        return { sessionId: `acp-${sessionNews.length}` };
      })
      .onRequest(methods.agent.session.load, ({ params }) => {
        sessionLoads.push(params.cwd);
        return { sessionId: params.sessionId };
      })
      .onRequest(methods.agent.session.prompt, () => ({ stopReason: "end_turn" }))
      .onNotification(methods.agent.session.cancel, () => {})
      .connect(
        ndJsonStream(
          Writable.toWeb(stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(stdin) as ReadableStream<Uint8Array>
        )
      );
    return child;
  };
}

describe("#207 orchestrator live-turn spawn + status card", () => {
  it("status card and ACP session/new|load use the thread overlay, not stale REPOS_ROOT; reset keeps it", async () => {
    const selected = path.join(dir, "seam-acp");
    fs.mkdirSync(selected, { recursive: true });
    const sessionNews: string[] = [];
    const sessionLoads: string[] = [];
    const panels: StructuredPanel[] = [];

    const runtimeProfiles = [
      {
        id: "copilot",
        displayName: "Copilot",
        defaultModel: "gpt-5.4",
        effort: { mechanism: "none", levels: [] },
        spawn: fakeAcpSpawn(sessionNews, sessionLoads),
      },
    ] as unknown as AgentProfile[];

    const presetsFile = path.join(dir, "channel-presets.json");
    fs.writeFileSync(presetsFile, JSON.stringify({ channels: {}, threads: {} }));
    const channelPresets = new Map<string, ChannelPreset>();
    const threadPresets = new Map<string, ThreadPreset>([
      [THREAD, { cwd: { value: selected } }],
    ]);
    const store = new SessionStore(path.join(dir, "seam.db"));
    store.upsert({
      id: `discord:${THREAD}`,
      platform: "discord",
      channelRef: THREAD,
      parentRef: PARENT,
      agentId: "copilot",
      acpSessionId: "",
      repoPath: dir,
      configJson: "{}",
      createdUtc: "2026-01-01T00:00:00Z",
      updatedUtc: "2026-01-01T00:00:00Z",
    });
    const router = new SessionRouter({
      logger: silent,
      store,
      profiles: runtimeProfiles,
      defaultAgentId: "copilot",
      defaultModel: "gpt-5.4",
      defaultPermissionMode: "ask",
      channelPresets,
      threadPresets,
      defaultCwd: dir,
    });
    const channel: ChannelRef = { platform: "discord", id: THREAD, parentId: PARENT };
    const orch = new Orchestrator({
      logger: silent,
      config: {
        DATA_DIR: dir,
        REPOS_ROOT: dir,
        TURN_TIMEOUT_SECONDS: 15,
        DEFAULT_MODEL: "gpt-5.4",
        DEFAULT_AGENT: "copilot",
        CHANNEL_PRESETS_FILE: presetsFile,
        SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
        channelPresets,
        threadPresets,
        bridgePresets: new Map(),
        REPO_EMOJIS: new Map(),
        SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
      } as any,
      adapter: {
        sendPanel: async (_ch: ChannelRef, panel: StructuredPanel) => {
          panels.push(panel);
          return { id: `panel-${panels.length}`, channel };
        },
        editPanel: async () => {},
        sendMessage: async () => ({ id: "m1", channel }),
        editMessage: async () => {},
      } as any,
      router,
      store,
      renderer: discordRenderer,
    });

    const rec = store.get(`discord:${THREAD}`)!;
    expect(router.describeConfig(rec).cwd).toEqual({
      value: selected,
      source: "thread preset",
    });

    const prompt = (text: string): IncomingMessage => ({
      channel,
      authorId: ADMIN,
      authorIsBot: false,
      text,
    });

    await (orch as any).handleIncomingMessageInner(prompt("first turn"));
    expect(sessionNews).toEqual([selected]);
    expect(sessionLoads).toEqual([]);
    const repoField = panels[0]?.fields.find((f) => f.name === "Repo")?.value;
    expect(repoField).toBe("seam-acp");
    expect(repoField).not.toBe("/");

    // Warm runtime reuse does not re-call session/new. Retire it without
    // clearing the ACP id so the next turn takes session/load.
    await router.invalidate(`discord:${THREAD}`, { clearAcpSession: false });
    await (orch as any).handleIncomingMessageInner(prompt("second turn resumes"));
    expect(sessionLoads).toEqual([selected]);
    expect(sessionNews).toEqual([selected]);

    const { i } = slashI({});
    await (orch as any).cmdReset(i);
    const afterReset = store.get(`discord:${THREAD}`)!;
    expect(afterReset.acpSessionId).toBe("");
    expect(afterReset.repoPath).toBe(dir);
    expect(router.describeConfig(afterReset).cwd.value).toBe(selected);

    await (orch as any).handleIncomingMessageInner(prompt("after reset"));
    expect(sessionNews).toEqual([selected, selected]);
    expect(sessionNews).not.toContain(dir);
    const lastRepo = panels.at(-1)?.fields.find((f) => f.name === "Repo")?.value;
    expect(lastRepo).toBe("seam-acp");
    expect(lastRepo).not.toBe("/");

    await router.disposeAll();
    store.close();
  }, 20_000);
});
