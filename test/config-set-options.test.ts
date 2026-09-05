import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { MessageFlags } from "discord.js";
import type { AgentProfile } from "@seam/adapters";
import type { ChannelPreset, ThreadPreset } from "../packages/core/src/config.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionConfigState, SessionRecord } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const THREAD = "333333333333333333";
const PARENT = "111111111111111111";
const USER = "1487094572696867019";

let dir: string;
let reposRoot: string;

const profiles = [
  {
    id: "claude",
    displayName: "Claude",
    defaultModel: "claude-opus-5",
    staticModels: [{ modelId: "claude-opus-5", name: "Opus 5" }],
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
    effort: { mechanism: "configOption", levels: ["low", "high"] },
  },
] as unknown as AgentProfile[];

function interaction(
  strings: Record<string, string | null>,
  booleans: Record<string, boolean | null> = {}
) {
  const replies: string[] = [];
  const edits: string[] = [];
  const order: string[] = [];
  const i = {
    options: {
      getString: (name: string) => strings[name] ?? null,
      getBoolean: (name: string) => booleans[name] ?? null,
    },
    user: { id: USER, username: "jesse", displayName: "Jesse" },
    channelId: THREAD,
    channel: { isThread: () => true, parentId: PARENT },
    deferred: false,
    replied: false,
    reply: vi.fn(async (payload: { content?: string; flags?: number }) => {
      i.replied = true;
      order.push("reply");
      replies.push(payload.content ?? "");
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
    }),
    deferReply: vi.fn(async (payload: { flags?: number }) => {
      i.deferred = true;
      order.push("defer");
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
    }),
    editReply: vi.fn(async (content: string) => {
      order.push("edit");
      edits.push(content);
    }),
  };
  return { i, replies, edits, order };
}

function makeHarness(opts?: { channelPreset?: ChannelPreset }) {
  const presetsFile = path.join(dir, "channel-presets.json");
  fs.writeFileSync(
    presetsFile,
    JSON.stringify({
      channels: opts?.channelPreset ? { [PARENT]: opts.channelPreset } : {},
      threads: {},
    })
  );
  const store = new SessionStore(path.join(dir, "seam.db"));
  const channelPresets = new Map<string, ChannelPreset>(
    opts?.channelPreset ? [[PARENT, opts.channelPreset]] : []
  );
  const threadPresets = new Map<string, ThreadPreset>();
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
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: reposRoot,
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "claude-opus-5",
      DEFAULT_AGENT: "claude",
      CHANNEL_PRESETS_FILE: presetsFile,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      channelPresets,
      threadPresets,
      bridgePresets: new Map(),
      REPO_EMOJIS: new Map(),
    } as any,
    adapter: {} as any,
    router,
    store,
    renderer: { codeBlock: (value: string) => value } as any,
  });
  (orch as any).applyThreadName = vi.fn(async () => ({ status: "unchanged" }));
  const cfg: SessionConfigState = {
    model: "claude-opus-5",
    reasoningEffort: "low",
    role: "worker",
    permissionPolicy: "ask",
    statusCardStyle: "full",
    simpleCardGif: false,
    availableTools: ["read"],
    lastContextUsage: {
      used: 10,
      size: 100,
      model: "claude-opus-5",
      atUtc: "2026-09-04T00:00:00.000Z",
    },
  };
  const record: SessionRecord = {
    id: `discord:${THREAD}`,
    platform: "discord",
    channelRef: THREAD,
    parentRef: PARENT,
    agentId: "claude",
    acpSessionId: "acp-old",
    repoPath: reposRoot,
    configJson: JSON.stringify(cfg),
    createdUtc: "2026-09-04T00:00:00.000Z",
    updatedUtc: "2026-09-04T00:00:00.000Z",
  };
  store.upsert(record);
  return { orch, router, store, threadPresets };
}

function read(store: SessionStore) {
  const record = store.get(`discord:${THREAD}`)!;
  return { record, cfg: store.readConfig(record) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-config-set-"));
  reposRoot = path.join(dir, "repos");
  fs.mkdirSync(path.join(reposRoot, "alpha"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("/seam config set named parameters", () => {
  it("applies all named fields together and clears the old ACP binding on agent change", async () => {
    const { orch, router, store } = makeHarness();
    const { i, edits, order } = interaction({
      agent: "codex@local",
      model: "gpt-5.4",
      effort: "high",
      repo: "alpha",
      role: "qa",
      permissions: "always",
      card: "simple",
      gif: "on",
    });

    await (orch as any).cmdConfigSet(i);

    expect(order[0]).toBe("defer");
    expect(edits.at(-1)).toMatch(/Updated `agent`, `model`, `effort`, `repo`, `role`, `permissions`, `card`, `gif`/);
    const { record, cfg } = read(store);
    expect(record.agentId).toBe("codex");
    expect(record.acpSessionId).toBe("");
    expect(record.repoPath).toBe(path.join(reposRoot, "alpha"));
    expect(cfg).toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "high",
      role: "qa",
      permissionPolicy: "always",
      statusCardStyle: "simple",
      simpleCardGif: true,
      availableTools: ["read"],
    });
    expect(cfg.lastContextUsage).toBeUndefined();
    expect(router.describeConfig(record).agent.value).toBe("codex");
    expect(router.describeConfig(record).model.value).toBe("gpt-5.4");
    store.close();
  });

  it("patches only supplied fields and preserves the resumable session", async () => {
    const { orch, router, store } = makeHarness();
    const invalidate = vi.spyOn(router, "invalidate");
    const { i, edits } = interaction({
      role: "analyst",
      permissions: "deny",
      card: "default",
      gif: "default",
    });

    await (orch as any).cmdConfigSet(i);

    const { record, cfg } = read(store);
    expect(record.agentId).toBe("claude");
    expect(record.acpSessionId).toBe("acp-old");
    expect(record.repoPath).toBe(reposRoot);
    expect(cfg.model).toBe("claude-opus-5");
    expect(cfg.reasoningEffort).toBe("low");
    expect(cfg.role).toBe("analyst");
    expect(cfg.permissionPolicy).toBe("deny");
    expect(cfg.statusCardStyle).toBeUndefined();
    expect(cfg.simpleCardGif).toBeUndefined();
    expect(cfg.availableTools).toEqual(["read"]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(edits.at(-1)).toContain("Updated `role`, `permissions`, `card`, `gif`");
    store.close();
  });

  it("uses the selected agent default model when model is omitted", async () => {
    const { orch, store } = makeHarness();
    await (orch as any).cmdConfigSet(interaction({ agent: "codex@local" }).i);
    const { record, cfg } = read(store);
    expect(record.agentId).toBe("codex");
    expect(cfg.model).toBe("gpt-5.6-sol");
    expect(cfg.lastContextUsage).toBeUndefined();
    store.close();
  });

  it("writes an agent/model thread overlay so a locked channel preset cannot shadow the bulk set", async () => {
    const { orch, router, store, threadPresets } = makeHarness({
      channelPreset: {
        agent: { value: "claude" },
        model: { value: "claude-opus-5" },
        locked: true,
      },
    });
    await (orch as any).cmdConfigSet(
      interaction({ agent: "codex@local", model: "gpt-5.4", effort: "high" }).i
    );
    const record = read(store).record;
    expect(threadPresets.get(THREAD)?.agent?.value).toBe("codex");
    expect(threadPresets.get(THREAD)?.model?.value).toBe("gpt-5.4");
    expect(threadPresets.get(THREAD)?.effort?.value).toBe("high");
    expect(router.describeConfig(record).agent.value).toBe("codex");
    expect(router.describeConfig(record).model.value).toBe("gpt-5.4");
    expect(router.describeConfig(record).effort.value).toBe("high");
    store.close();
  });

  it("rolls the session row back when the thread overlay cannot be committed", async () => {
    const { orch, store } = makeHarness();
    (orch as any).configMutation.applyThreadOverlay = () => ({
      ok: false,
      error: "injected overlay failure",
    });
    const call = interaction({
      agent: "codex@local",
      model: "gpt-5.4",
      permissions: "always",
    });

    await (orch as any).cmdConfigSet(call.i);

    expect(call.edits.at(-1)).toMatch(/Could not update config: injected overlay failure/);
    const { record, cfg } = read(store);
    expect(record.agentId).toBe("claude");
    expect(record.acpSessionId).toBe("acp-old");
    expect(cfg.model).toBe("claude-opus-5");
    expect(cfg.permissionPolicy).toBe("ask");
    store.close();
  });

  it("refuses mixed JSON/named mode and unsupported effort without mutating", async () => {
    const { orch, store } = makeHarness();
    const mixed = interaction({ json: '{"model":"x"}', role: "qa" });
    await (orch as any).cmdConfigSet(mixed.i);
    expect(mixed.replies[0]).toMatch(/either `json:` or named fields/);
    expect(read(store).cfg.role).toBe("worker");

    const unsupported = interaction({ agent: "codex@local", effort: "ultra" });
    await (orch as any).cmdConfigSet(unsupported.i);
    expect(unsupported.edits[0]).toMatch(/not supported by `codex`/);
    expect(read(store).record.agentId).toBe("claude");
    store.close();
  });

  it("keeps JSON as full replacement mode and acknowledges before invalidation", async () => {
    const { orch, store } = makeHarness();
    const call = interaction({ json: '{"role":"planner","permissionPolicy":"deny"}' });
    await (orch as any).cmdConfigSet(call.i);
    expect(call.order[0]).toBe("defer");
    expect(call.edits.at(-1)).toMatch(/Config replaced/);
    const { record, cfg } = read(store);
    expect(record.acpSessionId).toBe("acp-old");
    expect(cfg).toEqual({ role: "planner", permissionPolicy: "deny", model: "claude-opus-5" });
    store.close();
  });

  it("applies an explicit host binding through the same agent autocomplete value", async () => {
    const { orch, store, threadPresets } = makeHarness();
    const call = interaction({ agent: "codex@mac" });
    await (orch as any).cmdConfigSet(call.i);
    expect(call.edits.at(-1)).toMatch(/Updated `agent`/);
    expect(read(store).record.agentId).toBe("codex");
    expect(read(store).record.acpSessionId).toBe("");
    expect(threadPresets.get(THREAD)?.location).toBe("mac");
    expect(threadPresets.get(THREAD)?.agent?.value).toBe("codex");
    store.close();
  });

  it("rebuild:true after a model/repo patch invokes Rebuild once and does not Discord-rename from repo", async () => {
    const { orch, store } = makeHarness();
    const rebuild = vi.fn(async (args: { record: { repoPath: string | null; agentId: string } }) => {
      expect(args.record.repoPath).toBe(path.join(reposRoot, "alpha"));
      return {
        newSessionId: "acp-rebuilt",
        seed: { text: "discord-history" },
        destination: { agentId: "claude", model: "gpt-5.4", contextWindow: 200_000 },
      };
    });
    (orch as any).reconstructSessionFromDiscord = rebuild;
    const applyThreadName = (orch as any).applyThreadName as ReturnType<typeof vi.fn>;

    const call = interaction({ model: "gpt-5.4", repo: "alpha" }, { rebuild: true });
    await (orch as any).cmdConfigSet(call.i);

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(call.edits.at(-1)).toMatch(/Updated `model`, `repo`/);
    expect(call.edits.at(-1)).toMatch(/Rebuilt from Discord/);
    expect(call.edits.at(-1)).toMatch(/gpt-5\.4/);
    expect(call.edits.at(-1)).toMatch(/window 200000/);
    expect(read(store).cfg.model).toBe("gpt-5.4");
    expect(read(store).record.repoPath).toBe(path.join(reposRoot, "alpha"));
    expect(applyThreadName).toHaveBeenCalled();
    store.close();
  });

  it("rebuild:true with no other fields still Rebuilds when the command succeeds", async () => {
    const { orch, store } = makeHarness();
    const rebuild = vi.fn(async () => ({
      newSessionId: "acp-rebuilt",
      seed: { text: "discord-history" },
      destination: { agentId: "claude", model: "claude-opus-5", contextWindow: 1_000_000 },
    }));
    (orch as any).reconstructSessionFromDiscord = rebuild;

    const empty = interaction({});
    await (orch as any).cmdConfigSet(empty.i);
    expect(empty.replies[0]).toMatch(/at least one named field/);
    expect(rebuild).not.toHaveBeenCalled();

    const call = interaction({}, { rebuild: true });
    await (orch as any).cmdConfigSet(call.i);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(call.order[0]).toBe("defer");
    expect(call.edits.at(-1)).toMatch(/Rebuilt from Discord/);
    expect(call.edits.at(-1)).toMatch(/claude-opus-5/);
    expect(read(store).record.agentId).toBe("claude");
    store.close();
  });

  it("does not Rebuild when the set is refused", async () => {
    const { orch, store } = makeHarness();
    const rebuild = vi.fn();
    (orch as any).reconstructSessionFromDiscord = rebuild;
    const call = interaction({ agent: "nope" }, { rebuild: true });
    await (orch as any).cmdConfigSet(call.i);
    expect(call.edits.at(-1)).toMatch(/Unknown agent/);
    expect(rebuild).not.toHaveBeenCalled();
    expect(read(store).record.agentId).toBe("claude");
    store.close();
  });
});
