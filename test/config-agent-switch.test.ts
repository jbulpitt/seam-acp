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
import type { SessionConfigState, SessionRecord } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const ADMIN = "1487094572696867019";
const CHAN = "111111111111111111";
const THREAD = "333333333333333333";

let dir: string;

const profiles = [
  {
    id: "claude",
    displayName: "Claude",
    defaultModel: "claude-opus-5",
    staticModels: [
      { modelId: "claude-opus-5", name: "Opus 5" },
      { modelId: "claude-sonnet-4.6", name: "Sonnet 4.6" },
    ],
    effort: { mechanism: "meta", levels: ["low", "high"] },
  },
  {
    id: "codex",
    displayName: "OpenAI Codex",
    defaultModel: "gpt-5.6-sol",
    staticModels: [
      { modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { modelId: "gpt-5.4", name: "GPT-5.4" },
    ],
    effort: { mechanism: "configOption", configId: "reasoning_effort", levels: ["low", "high"] },
  },
  {
    id: "grok",
    displayName: "Grok",
    defaultModel: "grok-4.6",
    staticModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }],
    effort: { mechanism: "none", levels: [] },
  },
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
    user: { id: ADMIN, username: "jesse", displayName: "Jesse" },
    channelId: over.channelId ?? THREAD,
    channel: {
      isThread: () => true,
      parentId: over.parentId ?? CHAN,
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

function seedSession(
  store: SessionStore,
  over: Partial<SessionRecord> = {},
  cfgOver: SessionConfigState = {}
): SessionRecord {
  const cfg: SessionConfigState = {
    model: "claude-opus-5",
    reasoningEffort: "high",
    role: "worker",
    permissionPolicy: "ask",
    lastContextUsage: {
      used: 12_000,
      size: 200_000,
      model: "claude-opus-5",
      atUtc: "2026-09-01T00:00:00.000Z",
    },
    ...cfgOver,
  };
  const record: SessionRecord = {
    id: `discord:${THREAD}`,
    platform: "discord",
    channelRef: THREAD,
    parentRef: CHAN,
    agentId: "claude",
    acpSessionId: "acp-old",
    repoPath: dir,
    configJson: JSON.stringify(cfg),
    createdUtc: "2026-09-01T00:00:00.000Z",
    updatedUtc: "2026-09-01T00:00:00.000Z",
    ...over,
  };
  store.upsert(record);
  return store.get(record.id)!;
}

function makeOrch(opts?: {
  channelPresetsFile?: unknown;
  sendChoicePicker?: (channel: unknown, picker: unknown) => Promise<{ value: string; label: string } | null>;
}) {
  const presetsFile = path.join(dir, "channel-presets.json");
  fs.writeFileSync(
    presetsFile,
    JSON.stringify(opts?.channelPresetsFile ?? { channels: {}, threads: {} })
  );
  const channelPresets = new Map<string, ChannelPreset>();
  const threadPresets = new Map<string, ThreadPreset>();
  const raw = opts?.channelPresetsFile as
    | { channels?: Record<string, ChannelPreset>; threads?: Record<string, ThreadPreset> }
    | undefined;
  for (const [id, preset] of Object.entries(raw?.channels ?? {})) {
    channelPresets.set(id, preset);
  }
  for (const [id, preset] of Object.entries(raw?.threads ?? {})) {
    threadPresets.set(id, preset);
  }
  const store = new SessionStore(path.join(dir, "seam.db"));
  const router = new SessionRouter({
    logger: silent,
    store,
    profiles,
    defaultAgentId: "claude",
    defaultModel: "claude-opus-5",
    defaultPermissionMode: "ask",
    channelPresets,
    threadPresets,
  });
  const sent: string[] = [];
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "claude-opus-5",
      DEFAULT_AGENT: "claude",
      CHANNEL_PRESETS_FILE: presetsFile,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      channelPresets,
      threadPresets,
      bridgePresets: new Map(),
      REPO_EMOJIS: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    } as any,
    adapter: {
      sendMessage: vi.fn(async (_ch: unknown, text: string) => {
        sent.push(text);
      }),
      sendChoicePicker: opts?.sendChoicePicker
        ? vi.fn(opts.sendChoicePicker)
        : undefined,
    } as any,
    router,
    store,
    renderer: {} as any,
  });
  return { orch, router, store, presetsFile, channelPresets, threadPresets, sent };
}

function sessionConfig(store: SessionStore): SessionConfigState {
  const rec = store.get(`discord:${THREAD}`);
  expect(rec).toBeTruthy();
  return JSON.parse(rec!.configJson || "{}") as SessionConfigState;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agent-switch-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("/seam config agent — #178 session/overlay split-brain", () => {
  it("explicit-id Claude → Codex persists the Codex default in session and overlay", async () => {
    const { orch, router, store, threadPresets } = makeOrch();
    seedSession(store);
    const { i, replies } = slashI({ strings: { id: "codex@local" } });
    await (orch as any).cmdAgent(i);

    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(replies[0]?.content).toMatch(/Agent switched to `codex@local`/);
    expect(replies[0]?.content).toMatch(/model `gpt-5\.6-sol`/);

    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("codex");
    expect(rec.acpSessionId).toBe("");
    const cfg = sessionConfig(store);
    // Mutation check: persistConfig then upsert({...staleRecord}) restored
    // configJson.model to claude-opus-5. This dies if that overwrite returns.
    expect(cfg.model).toBe("gpt-5.6-sol");
    expect(cfg.lastContextUsage).toBeUndefined();
    expect(cfg.reasoningEffort).toBe("high");
    expect(cfg.role).toBe("worker");
    expect(cfg.permissionPolicy).toBe("ask");

    expect(threadPresets.get(THREAD)?.agent?.value).toBe("codex");
    expect(threadPresets.get(THREAD)?.model?.value).toBe("gpt-5.6-sol");

    const described = router.describeConfig(rec);
    const spawn = router.planRuntimeSpawn(rec);
    expect(described.agent.value).toBe("codex");
    expect(described.model.value).toBe("gpt-5.6-sol");
    expect(spawn.agentId).toBe("codex");
    expect(spawn.model).toBe("gpt-5.6-sol");
  });

  it("opening /seam config model immediately afterward shows the new default as current", async () => {
    const pickerCurrent: string[] = [];
    const { orch, store } = makeOrch({
      sendChoicePicker: async (_ch, picker: any) => {
        const current = picker.panel?.fields?.find((f: { name: string }) => f.name === "Current")?.value;
        if (typeof current === "string") pickerCurrent.push(current);
        return null;
      },
    });
    seedSession(store);
    await (orch as any).cmdAgent(slashI({ strings: { id: "codex@local" } }).i);
    const { i, edits } = slashI({ strings: {} });
    await (orch as any).cmdModel(i);
    expect(edits.some((e) => e.includes("`gpt-5.6-sol`"))).toBe(true);
    expect(edits.some((e) => e.includes("claude-opus-5"))).toBe(false);
    expect(pickerCurrent.some((v) => v.includes("gpt-5.6-sol"))).toBe(true);
    expect(pickerCurrent.some((v) => v.includes("claude-opus-5"))).toBe(false);
  });

  it("picker path writes the same atomic agent/model/session reset as explicit-id", async () => {
    const order: string[] = [];
    const { orch, router, store, sent } = makeOrch({
      sendChoicePicker: async (_ch, opts: any) => {
        expect(opts.successPanel).toBeUndefined();
        expect(typeof opts.commit).toBe("function");
        order.push("picked");
        const result = await opts.commit(
          { value: "codex@local", label: "OpenAI Codex @ local" },
          "jesse"
        );
        order.push("commit-done");
        if (result.ok) {
          order.push("render-success");
          expect(result.successPanel?.title).toMatch(/Agent changed/);
          return { value: "codex@local", userId: ADMIN };
        }
        order.push("render-failure");
        return null;
      },
    });
    seedSession(store);
    const { i, replies } = slashI({ strings: {} });
    await (orch as any).cmdAgent(i);
    expect(replies[0]?.content).toMatch(/Posting picker/);
    expect(order).toEqual(["picked", "commit-done", "render-success"]);
    expect(sent.some((m) => m.includes("Agent switched to `codex@local`") && m.includes("gpt-5.6-sol"))).toBe(
      true
    );

    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("codex");
    expect(rec.acpSessionId).toBe("");
    expect(sessionConfig(store).model).toBe("gpt-5.6-sol");
    const described = router.describeConfig(rec);
    const spawn = router.planRuntimeSpawn(rec);
    expect(described.model.value).toBe("gpt-5.6-sol");
    expect(spawn.model).toBe("gpt-5.6-sol");
  });

  it("MUTATION: overlay failure rolls the session back and does not claim success", async () => {
    const { orch, store } = makeOrch();
    seedSession(store);
    const mutation = (orch as any).configMutation;
    mutation.applyThreadOverlay = () => ({ ok: false, error: "injected overlay failure" });

    const { i, replies } = slashI({ strings: { id: "codex@local" } });
    await (orch as any).cmdAgent(i);

    expect(replies[0]?.content).toMatch(/Could not switch agent: injected overlay failure/);
    expect(replies[0]?.content).not.toMatch(/Agent switched/);

    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("claude");
    expect(rec.acpSessionId).toBe("acp-old");
    const cfg = sessionConfig(store);
    expect(cfg.model).toBe("claude-opus-5");
    expect(cfg.lastContextUsage?.model).toBe("claude-opus-5");
  });

  it("pins over a locked channel preset instead of leaving the lock in charge", async () => {
    const { orch, router, store, threadPresets } = makeOrch({
      channelPresetsFile: {
        channels: {
          [CHAN]: { agent: { value: "grok" }, model: { value: "grok-4.6" }, locked: true },
        },
        threads: {},
      },
    });
    seedSession(store);
    await (orch as any).cmdAgent(slashI({ strings: { id: "codex@local" } }).i);

    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("codex");
    expect(sessionConfig(store).model).toBe("gpt-5.6-sol");
    expect(threadPresets.get(THREAD)?.agent?.value).toBe("codex");
    expect(threadPresets.get(THREAD)?.model?.value).toBe("gpt-5.6-sol");

    const described = router.describeConfig(rec);
    const spawn = router.planRuntimeSpawn(rec);
    expect(described.agent.value).toBe("codex");
    expect(described.model.value).toBe("gpt-5.6-sol");
    expect(described.agent.source).toBe("thread preset");
    expect(spawn.agentId).toBe("codex");
    expect(spawn.model).toBe("gpt-5.6-sol");
  });

  it("host-only switch clears the ACP session but keeps the current model", async () => {
    const { orch, router, store, threadPresets } = makeOrch();
    seedSession(store);
    const { i, replies } = slashI({ strings: { id: "claude@mac" } });
    await (orch as any).cmdAgent(i);

    expect(replies[0]?.content).toMatch(/Agent switched to `claude@mac`/);
    expect(replies[0]?.content).toMatch(/model `claude-opus-5`/);

    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("claude");
    expect(rec.acpSessionId).toBe("");
    const cfg = sessionConfig(store);
    expect(cfg.model).toBe("claude-opus-5");
    expect(cfg.lastContextUsage?.model).toBe("claude-opus-5");
    expect(cfg.role).toBe("worker");
    expect(threadPresets.get(THREAD)?.location).toBe("mac");
    expect(threadPresets.get(THREAD)?.agent?.value).toBe("claude");
    expect(threadPresets.get(THREAD)?.model?.value).toBe("claude-opus-5");

    const described = router.describeConfig(rec);
    const spawn = router.planRuntimeSpawn(rec);
    expect(described.agent.value).toBe("claude");
    expect(described.model.value).toBe("claude-opus-5");
    expect(described.location.value).toBe("mac");
    expect(spawn.agentId).toBe("claude");
    expect(spawn.model).toBe("claude-opus-5");
  });

  it("selecting the new default in /seam config model is a no-op after the switch", async () => {
    const { orch, store } = makeOrch();
    seedSession(store);
    await (orch as any).cmdAgent(slashI({ strings: { id: "codex@local" } }).i);
    const { i, replies } = slashI({ strings: { id: "gpt-5.6-sol" } });
    await (orch as any).cmdModel(i);
    expect(replies[0]?.content).toMatch(/already set to `gpt-5\.6-sol`/);
  });

  it("re-reads the live row after picker latency so concurrent repo/role/permission survive", async () => {
    const { orch, store } = makeOrch({
      sendChoicePicker: async (_ch, opts: any) => {
        const rec = store.get(`discord:${THREAD}`)!;
        const cfg = JSON.parse(rec.configJson) as SessionConfigState;
        cfg.role = "concurrent-role";
        cfg.permissionPolicy = "always";
        store.upsert({
          ...rec,
          repoPath: "/concurrent-repo",
          configJson: JSON.stringify(cfg),
          updatedUtc: new Date().toISOString(),
        });
        const result = await opts.commit(
          { value: "codex@local", label: "codex" },
          "jesse"
        );
        expect(result.ok).toBe(true);
        return { value: "codex@local", userId: ADMIN };
      },
    });
    seedSession(store);
    await (orch as any).cmdAgent(slashI({ strings: {} }).i);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("codex");
    expect(rec.repoPath).toBe("/concurrent-repo");
    const cfg = sessionConfig(store);
    expect(cfg.model).toBe("gpt-5.6-sol");
    expect(cfg.role).toBe("concurrent-role");
    expect(cfg.permissionPolicy).toBe("always");
  });

  it("thrown overlay write rolls back session and replies instead of claiming success", async () => {
    const { orch, store, presetsFile } = makeOrch();
    seedSession(store);
    const mutation = (orch as any).configMutation;
    mutation.applyThreadOverlay = () => {
      throw new Error("injected persistence exception");
    };
    const { i, replies } = slashI({ strings: { id: "codex@local" } });
    await (orch as any).cmdAgent(i);
    expect(replies[0]?.content).toMatch(/Could not switch agent: injected persistence exception/);
    expect(replies[0]?.content).not.toMatch(/Agent switched/);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("claude");
    expect(rec.acpSessionId).toBe("acp-old");
    expect(sessionConfig(store).model).toBe("claude-opus-5");
    const raw = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
    expect(raw.threads?.[THREAD]?.agent).toBeUndefined();
  });

  it("reload failure restores the previous overlay file so restart cannot activate the switch", async () => {
    const { orch, store, presetsFile, threadPresets } = makeOrch();
    seedSession(store);
    const mutation = (orch as any).configMutation;
    mutation.deps.reloadPresets = () => ({ ok: false, error: "injected reload failure" });
    const { i, replies } = slashI({ strings: { id: "codex@local" } });
    await (orch as any).cmdAgent(i);
    expect(replies[0]?.content).toMatch(/Could not switch agent: injected reload failure/);
    expect(replies[0]?.content).not.toMatch(/Agent switched/);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("claude");
    expect(sessionConfig(store).model).toBe("claude-opus-5");
    expect(threadPresets.get(THREAD)?.agent?.value).not.toBe("codex");
    const raw = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
    expect(raw.threads?.[THREAD]?.agent?.value).not.toBe("codex");
    expect(raw.threads?.[THREAD]?.model?.value).not.toBe("gpt-5.6-sol");
  });

  it("partial location success is rolled back when the agent overlay fails", async () => {
    const { orch, store, presetsFile, threadPresets } = makeOrch();
    seedSession(store);
    const mutation = (orch as any).configMutation;
    const origLocation = mutation.applyThreadLocation.bind(mutation);
    mutation.applyThreadLocation = (...args: unknown[]) => origLocation(...args);
    mutation.applyThreadOverlay = () => ({ ok: false, error: "injected overlay failure" });
    const { i, replies } = slashI({ strings: { id: "codex@mac" } });
    await (orch as any).cmdAgent(i);
    expect(replies[0]?.content).toMatch(/Could not switch agent: injected overlay failure/);
    expect(threadPresets.get(THREAD)?.location).toBeUndefined();
    const raw = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
    expect(raw.threads?.[THREAD]?.location).toBeUndefined();
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("claude");
    expect(rec.acpSessionId).toBe("acp-old");
  });

  it("post-overlay spawn-plan failure restores overlay and ACP when original identity is effective", async () => {
    const { orch, router, store, presetsFile, threadPresets } = makeOrch();
    seedSession(store);
    const orig = router.planRuntimeSpawn.bind(router);
    router.planRuntimeSpawn = ((rec: Parameters<typeof orig>[0]) => {
      if (rec.agentId === "codex") throw new Error("injected spawn-plan failure");
      return orig(rec);
    }) as typeof orig;
    const { i, replies } = slashI({ strings: { id: "codex@local" } });
    await (orch as any).cmdAgent(i);
    expect(replies[0]?.content).toMatch(/Could not switch agent: injected spawn-plan failure/);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("claude");
    expect(rec.acpSessionId).toBe("acp-old");
    expect(sessionConfig(store).model).toBe("claude-opus-5");
    expect(threadPresets.get(THREAD)?.agent?.value).not.toBe("codex");
    const raw = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
    expect(raw.threads?.[THREAD]?.agent?.value).not.toBe("codex");
    const described = router.describeConfig(rec);
    expect(described.agent.value).toBe("claude");
    expect(described.model.value).toBe("claude-opus-5");
  });

  it("does not restore ACP when rollback cannot make the original identity effective", async () => {
    const { orch, router, store } = makeOrch();
    seedSession(store);
    const mutation = (orch as any).configMutation;
    mutation.restoreThreadPresetEntry = () => ({ ok: false, error: "injected restore failure" });
    const orig = router.planRuntimeSpawn.bind(router);
    router.planRuntimeSpawn = ((rec: Parameters<typeof orig>[0]) => {
      if (rec.agentId === "codex") throw new Error("injected spawn-plan failure");
      return orig(rec);
    }) as typeof orig;
    const { i, replies } = slashI({ strings: { id: "codex@local" } });
    await (orch as any).cmdAgent(i);
    expect(replies[0]?.content).toMatch(/Could not switch agent: injected spawn-plan failure/);
    expect(replies[0]?.content).toMatch(/Previous ACP session was not restored/);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("claude");
    expect(rec.acpSessionId).toBe("");
  });
});
