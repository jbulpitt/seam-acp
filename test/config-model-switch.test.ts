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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-model-switch-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("/seam config model — #191 failure-atomic commit", () => {
  it("explicit-id persists the new model in session and overlay", async () => {
    const { orch, router, store, threadPresets } = makeOrch();
    seedSession(store);
    const { i, replies } = slashI({ strings: { id: "claude-sonnet-4.6" } });
    await (orch as any).cmdModel(i);

    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(replies[0]?.content).toMatch(/Model will be `claude-sonnet-4\.6`/);
    expect(replies[0]?.content).not.toMatch(/Could not set model/);

    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.agentId).toBe("claude");
    expect(rec.acpSessionId).toBe("acp-old");
    const cfg = sessionConfig(store);
    expect(cfg.model).toBe("claude-sonnet-4.6");
    expect(cfg.lastContextUsage).toBeUndefined();
    expect(cfg.reasoningEffort).toBe("high");
    expect(cfg.role).toBe("worker");
    expect(threadPresets.get(THREAD)?.model?.value).toBe("claude-sonnet-4.6");

    const described = router.describeConfig(rec);
    const spawn = router.planRuntimeSpawn(rec);
    expect(described.model.value).toBe("claude-sonnet-4.6");
    expect(spawn.model).toBe("claude-sonnet-4.6");
    expect(spawn.agentId).toBe("claude");
  });

  it("picker commits before rendering success and shares the explicit-id transaction", async () => {
    const order: string[] = [];
    const { orch, router, store, sent } = makeOrch({
      sendChoicePicker: async (_ch, opts: any) => {
        expect(opts.successPanel).toBeUndefined();
        expect(typeof opts.commit).toBe("function");
        order.push("picked");
        const result = await opts.commit(
          { value: "claude-sonnet-4.6", label: "Sonnet 4.6" },
          "jesse"
        );
        order.push("commit-done");
        if (result.ok) {
          order.push("render-success");
          expect(result.successPanel?.title).toMatch(/Model/);
          return { value: "claude-sonnet-4.6", userId: ADMIN };
        }
        order.push("render-failure");
        return null;
      },
    });
    seedSession(store);
    const { i, edits } = slashI({ strings: {} });
    await (orch as any).cmdModel(i);
    expect(edits.some((e) => e.includes("Posting picker"))).toBe(true);
    expect(order).toEqual(["picked", "commit-done", "render-success"]);
    expect(sent.some((m) => m.includes("claude-sonnet-4.6"))).toBe(true);
    expect(sessionConfig(store).model).toBe("claude-sonnet-4.6");
    const rec = store.get(`discord:${THREAD}`)!;
    expect(router.describeConfig(rec).model.value).toBe("claude-sonnet-4.6");
    expect(router.planRuntimeSpawn(rec).model).toBe("claude-sonnet-4.6");
  });

  it("NEGATIVE CONTROL: overlay {ok:false} rolls back and never claims success", async () => {
    const { orch, store, threadPresets } = makeOrch();
    seedSession(store);
    const mutation = (orch as any).configMutation;
    mutation.applyThreadOverlay = () => ({ ok: false, error: "injected overlay failure" });
    const { i, replies } = slashI({ strings: { id: "claude-sonnet-4.6" } });
    await (orch as any).cmdModel(i);
    expect(replies[0]?.content).toMatch(/Could not set model: injected overlay failure/);
    expect(replies[0]?.content).not.toMatch(/Model will be/);
    expect(replies[0]?.content).not.toMatch(/Model set to/);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.acpSessionId).toBe("acp-old");
    expect(sessionConfig(store).model).toBe("claude-opus-5");
    expect(sessionConfig(store).lastContextUsage?.model).toBe("claude-opus-5");
    expect(threadPresets.get(THREAD)?.model?.value).toBeUndefined();
  });

  it("thrown overlay write rolls back and replies instead of claiming success", async () => {
    const { orch, store, presetsFile } = makeOrch();
    seedSession(store);
    const mutation = (orch as any).configMutation;
    mutation.applyThreadOverlay = () => {
      throw new Error("injected persistence exception");
    };
    const { i, replies } = slashI({ strings: { id: "claude-sonnet-4.6" } });
    await (orch as any).cmdModel(i);
    expect(replies[0]?.content).toMatch(/Could not set model: injected persistence exception/);
    expect(replies[0]?.content).not.toMatch(/Model will be/);
    expect(sessionConfig(store).model).toBe("claude-opus-5");
    expect(store.get(`discord:${THREAD}`)?.acpSessionId).toBe("acp-old");
    const raw = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
    expect(raw.threads?.[THREAD]?.model).toBeUndefined();
  });

  it("reload failure restores the previous overlay file so restart cannot activate the model", async () => {
    const { orch, store, presetsFile, threadPresets } = makeOrch();
    seedSession(store);
    const mutation = (orch as any).configMutation;
    mutation.deps.reloadPresets = () => ({ ok: false, error: "injected reload failure" });
    const { i, replies } = slashI({ strings: { id: "claude-sonnet-4.6" } });
    await (orch as any).cmdModel(i);
    expect(replies[0]?.content).toMatch(/Could not set model: injected reload failure/);
    expect(replies[0]?.content).not.toMatch(/Model will be/);
    expect(sessionConfig(store).model).toBe("claude-opus-5");
    expect(threadPresets.get(THREAD)?.model?.value).not.toBe("claude-sonnet-4.6");
    const raw = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
    expect(raw.threads?.[THREAD]?.model?.value).not.toBe("claude-sonnet-4.6");
  });

  it("effective-state mismatch rolls back session and overlay", async () => {
    const { orch, router, store, presetsFile, threadPresets } = makeOrch();
    seedSession(store);
    const orig = router.planRuntimeSpawn.bind(router);
    router.planRuntimeSpawn = ((rec: Parameters<typeof orig>[0]) => {
      const plan = orig(rec);
      if (plan.model === "claude-sonnet-4.6") return { ...plan, model: "wrong-model" };
      return plan;
    }) as typeof orig;
    const { i, replies } = slashI({ strings: { id: "claude-sonnet-4.6" } });
    await (orch as any).cmdModel(i);
    expect(replies[0]?.content).toMatch(/Could not set model: the effective configuration did not match/);
    expect(sessionConfig(store).model).toBe("claude-opus-5");
    expect(store.get(`discord:${THREAD}`)?.acpSessionId).toBe("acp-old");
    expect(threadPresets.get(THREAD)?.model?.value).not.toBe("claude-sonnet-4.6");
    const raw = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
    expect(raw.threads?.[THREAD]?.model?.value).not.toBe("claude-sonnet-4.6");
  });

  it("re-reads the live row after picker latency so concurrent repo/role/permission survive success", async () => {
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
          { value: "claude-sonnet-4.6", label: "Sonnet 4.6" },
          "jesse"
        );
        expect(result.ok).toBe(true);
        return { value: "claude-sonnet-4.6", userId: ADMIN };
      },
    });
    seedSession(store);
    await (orch as any).cmdModel(slashI({ strings: {} }).i);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.repoPath).toBe("/concurrent-repo");
    const cfg = sessionConfig(store);
    expect(cfg.model).toBe("claude-sonnet-4.6");
    expect(cfg.role).toBe("concurrent-role");
    expect(cfg.permissionPolicy).toBe("always");
    expect(rec.acpSessionId).toBe("acp-old");
  });

  it("concurrent unrelated updates also survive overlay-failure rollback", async () => {
    const { orch, store } = makeOrch({
      sendChoicePicker: async (_ch, opts: any) => {
        const rec = store.get(`discord:${THREAD}`)!;
        const cfg = JSON.parse(rec.configJson) as SessionConfigState;
        cfg.role = "kept-role";
        store.upsert({
          ...rec,
          repoPath: "/kept-repo",
          configJson: JSON.stringify(cfg),
          updatedUtc: new Date().toISOString(),
        });
        const mutation = (orch as any).configMutation;
        mutation.applyThreadOverlay = () => ({ ok: false, error: "injected overlay failure" });
        const result = await opts.commit(
          { value: "claude-sonnet-4.6", label: "Sonnet 4.6" },
          "jesse"
        );
        expect(result.ok).toBe(false);
        return null;
      },
    });
    seedSession(store);
    await (orch as any).cmdModel(slashI({ strings: {} }).i);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.repoPath).toBe("/kept-repo");
    const cfg = sessionConfig(store);
    expect(cfg.model).toBe("claude-opus-5");
    expect(cfg.role).toBe("kept-role");
    expect(rec.acpSessionId).toBe("acp-old");
  });

  it("does not restore ACP when rollback cannot make the original model effective", async () => {
    const { orch, router, store } = makeOrch();
    seedSession(store);
    const mutation = (orch as any).configMutation;
    mutation.restoreThreadPresetEntry = () => ({ ok: false, error: "injected restore failure" });
    const orig = router.planRuntimeSpawn.bind(router);
    router.planRuntimeSpawn = ((rec: Parameters<typeof orig>[0]) => {
      const plan = orig(rec);
      if (plan.model === "claude-sonnet-4.6") return { ...plan, model: "wrong-model" };
      return plan;
    }) as typeof orig;
    const { i, replies } = slashI({ strings: { id: "claude-sonnet-4.6" } });
    await (orch as any).cmdModel(i);
    expect(replies[0]?.content).toMatch(/Could not set model: the effective configuration did not match/);
    expect(replies[0]?.content).toMatch(/Previous ACP session was not restored/);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(sessionConfig(store).model).toBe("claude-opus-5");
    expect(rec.acpSessionId).toBe("");
  });

  it("live setModel failure still succeeds when the durable next-turn model is verified", async () => {
    const { orch, router, store } = makeOrch();
    seedSession(store);
    router.hasRuntime = () => true;
    router.getOrStartRuntime = (async () => ({
      setModel: async () => {
        throw new Error("setModel rejected");
      },
    })) as typeof router.getOrStartRuntime;
    const { i, replies } = slashI({ strings: { id: "claude-sonnet-4.6" } });
    await (orch as any).cmdModel(i);
    expect(replies[0]?.content).toMatch(/Model will be `claude-sonnet-4\.6` on the next turn \(session respawn\)/);
    expect(sessionConfig(store).model).toBe("claude-sonnet-4.6");
    expect(router.describeConfig(store.get(`discord:${THREAD}`)!).model.value).toBe("claude-sonnet-4.6");
  });
});
