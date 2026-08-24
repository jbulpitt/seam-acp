import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { MessageFlags } from "discord.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { AgentProfile } from "@seam/adapters";
import type { ChannelPreset, ThreadPreset } from "../packages/core/src/config.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

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
  });

  it("scope:thread writes the thread-preset cwd overlay", async () => {
    const { orch, threadPresets, store } = makeOrch();
    const { i } = slashI({ strings: { path: "beta", scope: "thread" } });
    await (orch as any).cmdRepo(i);
    expect(threadPresets.get("333333333333333333")?.cwd?.value).toBe(path.resolve(dir, "beta"));
    const rec = store.get("discord:333333333333333333");
    expect(rec?.repoPath).not.toBe(path.resolve(dir, "beta"));
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
  });
});
