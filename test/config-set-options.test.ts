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
import type { ChannelRef } from "../packages/core/src/platforms/chat-adapter.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const THREAD = "333333333333333333";
const NEW_THREAD = "444444444444444444";
const PARENT = "111111111111111111";
const USER = "1487094572696867019";

let dir: string;
let reposRoot: string;
let harnessSequence = 0;

const profiles = [
  {
    id: "claude",
    displayName: "Claude",
    defaultModel: "claude-opus-5",
    staticModels: [
      { modelId: "claude-opus-5", name: "Opus 5" },
      { modelId: "gpt-5.4", name: "GPT-5.4 compatibility" },
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
    effort: { mechanism: "configOption", levels: ["low", "high"] },
  },
] as unknown as AgentProfile[];

function interaction(
  strings: Record<string, string | null>,
  booleans: Record<string, boolean | null> = {},
  target: { channelId?: string; parentId?: string } = {}
) {
  const replies: string[] = [];
  const edits: string[] = [];
  const order: string[] = [];
  const i = {
    options: {
      getString: (name: string) => strings[name] ?? null,
      getBoolean: (name: string) => booleans[name] ?? null,
      getSubcommand: () => "new",
      getSubcommandGroup: () => null,
      data: [],
    },
    user: { id: USER, username: "jesse", displayName: "Jesse" },
    channelId: target.channelId ?? THREAD,
    channel: { isThread: () => true, parentId: target.parentId ?? PARENT },
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
  const harnessDir = path.join(dir, `harness-${++harnessSequence}`);
  fs.mkdirSync(harnessDir, { recursive: true });
  const presetsFile = path.join(harnessDir, "channel-presets.json");
  fs.writeFileSync(
    presetsFile,
    JSON.stringify({
      channels: opts?.channelPreset ? { [PARENT]: opts.channelPreset } : {},
      threads: {},
    })
  );
  const store = new SessionStore(path.join(harnessDir, "seam.db"));
  const channelPresets = new Map<string, ChannelPreset>(
    opts?.channelPreset ? [[PARENT, opts.channelPreset]] : []
  );
  const threadPresets = new Map<string, ThreadPreset>();
  const router = new SessionRouter({
    logger: silent,
    store,
    profiles,
    modelCatalog: fixtureModelCatalog(profiles),
    defaultAgentId: "claude",
    defaultModel: "claude-opus-5",
    defaultPermissionMode: "ask",
    channelPresets,
    threadPresets,
  });
  const created: Array<{ parent: ChannelRef; name: string }> = [];
  const addedMembers: Array<{ channel: ChannelRef; userId: string }> = [];
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: harnessDir,
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
    adapter: {
      createThread: async (parent: ChannelRef, name: string): Promise<ChannelRef> => {
        created.push({ parent, name });
        return { platform: "discord", id: NEW_THREAD, parentId: PARENT };
      },
      addThreadMember: async (channel: ChannelRef, userId: string) => {
        addedMembers.push({ channel, userId });
      },
      sendMessage: vi.fn(async () => ({ id: "message" })),
    } as any,
    modelCatalog: fixtureModelCatalog(profiles),
    router,
    store,
    renderer: { codeBlock: (value: string) => value } as any,
  });
  const applyThreadName = vi.fn(async () => ({ status: "unchanged" }));
  (orch as any).applyThreadName = applyThreadName;
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
  return { orch, router, store, threadPresets, created, addedMembers, applyThreadName };
}

function read(store: SessionStore) {
  const record = store.get(`discord:${THREAD}`)!;
  return { record, cfg: store.readConfig(record) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-config-set-"));
  harnessSequence = 0;
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
    expect(unsupported.edits[0]).toMatch(/not supported by `codex\/gpt-5\.6-sol`/);
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
    expect(cfg).toEqual({ role: "planner", permissionPolicy: "deny", model: "claude-opus-5", reasoningEffort: "default" });
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

describe("configured /seam new (#294)", () => {
  it("reaches the same durable end state as create followed by config set", async () => {
    const fields = {
      agent: "codex@local",
      model: "gpt-5.4",
      effort: "high",
      repo: "alpha",
      role: "qa",
      permissions: "always",
      card: "simple",
      gif: "on",
    };
    const oneCall = makeHarness();
    await (oneCall.orch as any).cmdNew(interaction({ name: "one-call", ...fields }).i);
    const oneRecord = oneCall.store.get(`discord:${NEW_THREAD}`)!;
    const oneOverlay = oneCall.threadPresets.get(NEW_THREAD);

    const twoCalls = makeHarness();
    (twoCalls.orch as any).openConfigEditorCard = vi.fn(async () => true);
    await (twoCalls.orch as any).cmdNew(interaction({ name: "two-calls" }).i);
    await (twoCalls.orch as any).cmdConfigSet(
      interaction(fields, {}, { channelId: NEW_THREAD }).i
    );
    const twoRecord = twoCalls.store.get(`discord:${NEW_THREAD}`)!;
    const twoOverlay = twoCalls.threadPresets.get(NEW_THREAD);

    expect({
      agentId: oneRecord.agentId,
      acpSessionId: oneRecord.acpSessionId,
      repoPath: oneRecord.repoPath,
      cfg: oneCall.store.readConfig(oneRecord),
      overlay: oneOverlay,
    }).toEqual({
      agentId: twoRecord.agentId,
      acpSessionId: twoRecord.acpSessionId,
      repoPath: twoRecord.repoPath,
      cfg: twoCalls.store.readConfig(twoRecord),
      overlay: twoOverlay,
    });
    oneCall.store.close();
    twoCalls.store.close();
  });

  it("applies every named field before one final naming pass without starting or invalidating a runtime", async () => {
    const { orch, router, store, created, addedMembers, applyThreadName } = makeHarness();
    const invalidate = vi.spyOn(router, "invalidate");
    const getOrStart = vi.spyOn(router, "getOrStartRuntime");
    applyThreadName.mockImplementationOnce(async (record: SessionRecord) => {
      const effective = router.describeConfig(store.get(record.id) ?? record);
      expect(effective.agent.value).toBe("codex");
      expect(effective.model.value).toBe("gpt-5.4");
      expect(effective.effort.value).toBe("high");
      expect(effective.role.value).toBe("qa");
      return { status: "renamed" };
    });
    const call = interaction({
      name: "investigation",
      agent: "codex@local",
      model: "gpt-5.4",
      effort: "high",
      repo: "alpha",
      role: "qa",
      permissions: "always",
      card: "simple",
      gif: "on",
    });

    await (orch as any).cmdNew(call.i);

    expect(created).toEqual([
      { parent: { platform: "discord", id: THREAD }, name: "investigation" },
    ]);
    expect(addedMembers).toEqual([
      { channel: { platform: "discord", id: NEW_THREAD, parentId: PARENT }, userId: USER },
    ]);
    const record = store.get(`discord:${NEW_THREAD}`)!;
    const cfg = store.readConfig(record);
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
      sessionCwdExplicit: true,
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(getOrStart).not.toHaveBeenCalled();
    expect(applyThreadName).toHaveBeenCalledTimes(1);
    expect(call.edits.at(-1)).toContain(`Created and configured thread <#${NEW_THREAD}>`);
    expect(call.edits.at(-1)).toContain("agent `codex`, model `gpt-5.4`, effort `high`");
    store.close();
  });

  it("uses the destination parent defaults rather than the invoking thread session", async () => {
    const { orch, router, store } = makeHarness({
      channelPreset: {
        agent: { value: "codex" },
        model: { value: "gpt-5.6-sol" },
        effort: { value: "high" },
      },
    });
    const call = interaction({ role: "worker" });

    await (orch as any).cmdNew(call.i);

    const record = store.get(`discord:${NEW_THREAD}`)!;
    const effective = router.describeConfig(record);
    expect(effective.agent.value).toBe("codex");
    expect(effective.model.value).toBe("gpt-5.6-sol");
    expect(effective.effort.value).toBe("high");
    expect(effective.role.value).toBe("worker");
    store.close();
  });

  it("refuses the same invalid request as config set before creating anything", async () => {
    const { orch, store, created } = makeHarness();
    const newCall = interaction({ agent: "codex@mac", effort: "ultra" });
    const setCall = interaction({ agent: "codex@mac", effort: "ultra" });

    await (orch as any).cmdNew(newCall.i);
    await (orch as any).cmdConfigSet(setCall.i);

    expect(newCall.edits.at(-1)).toBe(setCall.edits.at(-1));
    expect(created).toEqual([]);
    expect(store.get(`discord:${NEW_THREAD}`)).toBeNull();
    store.close();
  });

  it("rejects JSON/named mixing and invalid JSON shape before thread creation", async () => {
    const { orch, store, created } = makeHarness();
    const mixed = interaction({ json: '{"model":"gpt-5.4"}', role: "qa" });
    await (orch as any).cmdNew(mixed.i);
    expect(mixed.edits.at(-1)).toBe("Use either `json:` or named fields, not both.");

    const invalid = interaction({ json: '{"permissionPolicy":"sometimes"}' });
    await (orch as any).cmdNew(invalid.i);
    expect(invalid.edits.at(-1)).toMatch(/Invalid JSON.*permissionPolicy/);
    const invalidSet = interaction({ json: '{"permissionPolicy":"sometimes"}' });
    await (orch as any).cmdConfigSet(invalidSet.i);
    expect(invalid.edits.at(-1)).toBe(invalidSet.edits.at(-1));
    expect(created).toEqual([]);
    expect(store.get(`discord:${NEW_THREAD}`)).toBeNull();
    store.close();
  });

  it("supports JSON replacement and named clearing semantics", async () => {
    const jsonHarness = makeHarness();
    const jsonCall = interaction({
      json: '{"model":"claude-opus-5","reasoningEffort":"high","role":"planner","permissionPolicy":"deny"}',
    });
    await (jsonHarness.orch as any).cmdNew(jsonCall.i);
    const jsonRecord = jsonHarness.store.get(`discord:${NEW_THREAD}`)!;
    expect(jsonHarness.store.readConfig(jsonRecord)).toMatchObject({
      model: "claude-opus-5",
      reasoningEffort: "high",
      role: "planner",
      permissionPolicy: "deny",
    });
    jsonHarness.store.close();

    const clearHarness = makeHarness({
      channelPreset: {
        role: { value: "inherited-role" },
        statusCardStyle: { value: "simple" },
        simpleCardGif: { value: true },
      },
    });
    const clearCall = interaction({ role: "auto", card: "default", gif: "default" });
    await (clearHarness.orch as any).cmdNew(clearCall.i);
    const clearRecord = clearHarness.store.get(`discord:${NEW_THREAD}`)!;
    const clearCfg = clearHarness.store.readConfig(clearRecord);
    expect(clearCfg.role).toBeUndefined();
    expect(clearCfg.statusCardStyle).toBeUndefined();
    expect(clearCfg.simpleCardGif).toBeUndefined();
    const effective = clearHarness.router.describeConfig(clearRecord);
    expect(effective.role.value).toBe("inherited-role");
    expect(effective.statusCardStyle.value).toBe("simple");
    expect(effective.simpleCardGif.value).toBe(true);
    clearHarness.store.close();
  });

  it("retains a created thread but rolls back and reports actual state on a mid-apply failure", async () => {
    const { orch, router, store, created, applyThreadName } = makeHarness();
    (orch as any).configMutation.applyThreadOverlay = () => ({
      ok: false,
      error: "injected overlay failure",
    });
    const call = interaction({ agent: "codex@local", model: "gpt-5.4", permissions: "always" });

    await (orch as any).cmdNew(call.i);

    expect(created).toHaveLength(1);
    const record = store.get(`discord:${NEW_THREAD}`)!;
    const effective = router.describeConfig(record);
    expect(record.agentId).toBe("claude");
    expect(effective.model.value).toBe("claude-opus-5");
    expect(effective.permission.value).toBe("ask");
    expect(call.edits.at(-1)).toMatch(
      /Created thread <#444444444444444444>, but configuration was not applied: injected overlay failure.*Actual: agent `claude`/
    );
    expect(applyThreadName).not.toHaveBeenCalled();
    store.close();
  });

  it("rejects rebuild:true before creation while rebuild:false remains inert", async () => {
    const rejected = makeHarness();
    const rebuild = interaction({ name: "no-clone" }, { rebuild: true });
    await (rejected.orch as any).cmdNew(rebuild.i);
    expect(rebuild.replies.at(-1)).toMatch(/requires an existing thread with Discord history/);
    expect(rejected.created).toEqual([]);
    rejected.store.close();

    const inert = makeHarness();
    const ordinary = interaction({ name: "ordinary" }, { rebuild: false });
    (inert.orch as any).openConfigEditorCard = vi.fn(async () => true);
    await (inert.orch as any).cmdNew(ordinary.i);
    expect(inert.created).toHaveLength(1);
    expect((inert.orch as any).openConfigEditorCard).toHaveBeenCalledTimes(1);
    inert.store.close();
  });

  it("keeps config authorization on the production slash path", async () => {
    const { orch, store, created } = makeHarness();
    (orch as any).config.SEAM_PARTICIPANT_USER_IDS = new Set([USER]);
    const call = interaction({ agent: "codex@local" });

    await orch.handleSlashInteraction(call.i as any);

    expect(call.replies.at(-1)).toContain("admin setting");
    expect(created).toEqual([]);
    expect(store.get(`discord:${NEW_THREAD}`)).toBeNull();
    store.close();
  });

  it("reports a Discord creation failure without claiming a thread exists", async () => {
    const { orch, store, created } = makeHarness();
    (orch as any).adapter.createThread = vi.fn(async () => {
      throw new Error("Discord unavailable");
    });
    const call = interaction({ agent: "codex@local" });

    await (orch as any).cmdNew(call.i);

    expect(call.edits.at(-1)).toBe("Could not create thread: Discord unavailable");
    expect(created).toEqual([]);
    expect(store.get(`discord:${NEW_THREAD}`)).toBeNull();
    store.close();
  });
});
