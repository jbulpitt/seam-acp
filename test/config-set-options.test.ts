import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { pino } from "pino";
import { MessageFlags } from "discord.js";
import type { AgentProfile } from "@seam/adapters";
import type { ChannelPreset, ThreadPreset } from "../packages/core/src/config.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { CODEX_ACP_2_0_1_MODES } from "./fixtures/codex-acp-modes.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionConfigState, SessionRecord } from "../packages/core/src/core/types.js";
import type { ChannelRef } from "../packages/core/src/platforms/chat-adapter.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeHub, localBridgeWiring } from "./local-bridge-fixture.js";
import { acknowledgedHandler } from "./acknowledged-handler-fixture.js";

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
    user: { id: USER, username: "alex", displayName: "Alex" },
    channelId: target.channelId ?? THREAD,
    channel: { isThread: () => true, parentId: target.parentId ?? PARENT },
    deferred: false,
    replied: false,
    ephemeral: true,
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
    editReply: vi.fn(async (payload: string | { content?: string }) => {
      const content = typeof payload === "string" ? payload : payload.content ?? "";
      order.push("edit");
      edits.push(content);
      replies.push(content);
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
    seamMcp: localBridgeWiring(profiles),
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
  orch.setBridgeHub(localBridgeHub(profiles, reposRoot));
  const identityEffects = (orch as any).identityEffects;
  const realFlush = identityEffects.flush.bind(identityEffects);
  const flushIdentity = vi.spyOn(identityEffects, "flush").mockImplementation(realFlush);
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
  return { orch, router, store, threadPresets, created, addedMembers, flushIdentity };
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

    await acknowledgedHandler(i, () => (orch as any).cmdConfigSet(i));

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
    const applyPermissions = vi.spyOn(router, "applyPermissionMode");
    const { i, edits } = interaction({
      role: "analyst",
      permissions: "deny",
      card: "default",
      gif: "default",
    });

    await acknowledgedHandler(i, () => (orch as any).cmdConfigSet(i));

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
    expect(applyPermissions).toHaveBeenCalledWith(record);
    expect(edits.at(-1)).toContain("Updated `role`, `permissions`, `card`, `gif`");
    store.close();
  });

  it("rolls a failed live permission mode change back and shows its cause", async () => {
    const { orch, router, store } = makeHarness();
    vi.spyOn(router, "applyPermissionMode").mockRejectedValueOnce(new Error("session/set_mode: unsupported full access"));
    const call = interaction({ permissions: "always" });
    await acknowledgedHandler(call.i, () => (orch as any).cmdConfigSet(call.i));
    expect(call.edits.at(-1)).toContain("session/set_mode: unsupported full access");
    expect(read(store).cfg.permissionPolicy).toBe("ask");
    store.close();
  });

  it("defers approval-policy changes before applying the live mode", async () => {
    const { orch, router, store } = makeHarness();
    const call = interaction({ policy: "always" });
    vi.spyOn(router, "applyPermissionMode").mockImplementation(async record => {
      expect(call.order).toEqual(["defer"]);
      expect(store.readConfig(store.get(record.id)!).permissionPolicy).toBe("always");
      call.order.push("mode");
    });
    await acknowledgedHandler(call.i, () => (orch as any).cmdApprove(call.i));
    expect(call.order).toEqual(["defer", "mode", "edit"]);
    expect(call.edits.at(-1)).toContain("Approval policy set to `always`");
    store.close();
  });

  it("does not acknowledge a rejected approval mode as successful", async () => {
    const { orch, router, store } = makeHarness();
    const failure = new Error("session/set_mode: agent refusal");
    vi.spyOn(router, "applyPermissionMode").mockRejectedValueOnce(failure);
    const call = interaction({ policy: "always" });
    await expect(acknowledgedHandler(call.i, () => (orch as any).cmdApprove(call.i))).rejects.toBe(failure);
    expect(call.order).toEqual(["defer"]);
    expect(call.edits).toEqual([]);
    store.close();
  });

  it("keeps advertised modes through adoption and rereads the live resolved policy", async () => {
    const { orch, router, store } = makeHarness();
    await acknowledgedHandler(interaction({ agent: "codex@local" }).i, () => (orch as any).cmdConfigSet(interaction({ agent: "codex@local" }).i));
    const record = read(store).record;
    const connection = {
      newSession: vi.fn(async () => ({ sessionId: "s1", modes: { currentModeId: "agent", availableModes: [
        { id: "agent", name: "Auto review" }, { id: "agent-full-access", name: "Full access" },
      ] } })),
      setSessionMode: vi.fn(async () => ({})),
    };
    const runtime = (router as any).makeRuntime(record, router.planRuntimeSpawn(record), "gpt-5.6-sol", undefined);
    Object.assign(runtime, { connection, promptCapabilities: {} });
    await runtime.newSession({ cwd: reposRoot });
    expect(connection.setSessionMode).not.toHaveBeenCalled();
    expect(read(store).cfg.codexModes).toMatchObject({ sessionId: "s1", currentModeId: "agent" });

    const change = (patch: Record<string, unknown>) => {
      const fresh = read(store);
      const { permissionPolicy: _policy, ...cfg } = fresh.cfg;
      store.upsert({ ...fresh.record, configJson: store.writeConfig({ ...cfg, ...patch }) });
    };
    change({ autoApprovePermissions: true });
    await runtime.applyPermissionMode();
    expect(connection.setSessionMode).toHaveBeenLastCalledWith({ sessionId: "s1", modeId: "agent-full-access" });
    expect(read(store).cfg.codexModes?.currentModeId).toBe("agent-full-access");

    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const adopted = router.adoptRecoveryRuntime(read(store).record, child as any, "s1");
    Object.assign(adopted, { connection });
    change({ permissionPolicy: "deny", autoApprovePermissions: true });
    await router.applyPermissionMode(record);
    expect(connection.setSessionMode).toHaveBeenLastCalledWith({ sessionId: "s1", modeId: "agent" });
    expect(read(store).cfg.codexModes?.currentModeId).toBe("agent");
    expect(read(store).cfg.availableTools).toEqual(["read"]);
    adopted.releaseRecovery();
    child.stdout.end();
    child.stdin.end();
    child.stderr.end();
    store.close();
  });

  it.each(["always", "ask"] as const)("uses the resolved %s policy for a fresh isolated Codex turn", async policy => {
    const { orch, store } = makeHarness();
    await acknowledgedHandler(interaction({ agent: "codex@local", permissions: policy }).i, () => (orch as any).cmdConfigSet(interaction({ agent: "codex@local", permissions: policy }).i));
    const bound = read(store);
    const modes = { sessionId: "bound-s1", ...structuredClone(CODEX_ACP_2_0_1_MODES) };
    store.upsert({ ...bound.record, acpSessionId: modes.sessionId,
      configJson: store.writeConfig({ ...bound.cfg, codexModes: modes }) });
    const connection = {
      newSession: vi.fn(async () => ({ sessionId: "isolated-s1", modes: structuredClone(CODEX_ACP_2_0_1_MODES),
        models: { currentModelId: "gpt-5.6-sol", availableModels: [] } })),
      setSessionMode: vi.fn(async () => ({})),
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    };
    const start = vi.spyOn(AgentRuntime.prototype, "start").mockImplementation(async function () {
      Object.assign(this, { connection, promptCapabilities: {} });
    });
    const dispose = vi.spyOn(AgentRuntime.prototype, "dispose").mockResolvedValue(undefined);
    try {
      const result = await orch.injectTurn(read(store).record, "isolated check", {
        session: "isolated", profile: profiles[1], model: "gpt-5.6-sol", cwd: reposRoot,
      });
      expect(result.error).toBeUndefined();
      expect(connection.prompt).toHaveBeenCalledTimes(1);
      expect(connection.setSessionMode.mock.calls).toEqual(policy === "always"
        ? [[{ sessionId: "isolated-s1", modeId: "agent-full-access" }]] : []);
      expect(read(store).cfg.codexModes).toEqual(modes);
    } finally {
      start.mockRestore();
      dispose.mockRestore();
      store.close();
    }
  });

  it("uses the selected agent default model when model is omitted", async () => {
    const { orch, router, store, threadPresets } = makeHarness();
    await acknowledgedHandler(interaction({ agent: "codex@local" }).i, () => (orch as any).cmdConfigSet(interaction({ agent: "codex@local" }).i));
    const { record, cfg } = read(store);
    expect(record.agentId).toBe("codex");
    expect(cfg.model).toBeUndefined();
    expect(cfg.reasoningEffort).toBeUndefined();
    expect(threadPresets.get(THREAD)?.model).toBeUndefined();
    expect(threadPresets.get(THREAD)?.effort).toBeUndefined();
    expect(router.describeConfig(record).model.value).toBe("gpt-5.6-sol");
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
    await acknowledgedHandler(interaction({ agent: "codex@local", model: "gpt-5.4", effort: "high" }).i, () => (orch as any).cmdConfigSet(
      interaction({ agent: "codex@local", model: "gpt-5.4", effort: "high" }).i
    ));
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

    await acknowledgedHandler(call.i, () => (orch as any).cmdConfigSet(call.i));

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
    await acknowledgedHandler(mixed.i, () => (orch as any).cmdConfigSet(mixed.i));
    expect(mixed.replies[0]).toMatch(/either `json:` or named fields/);
    expect(read(store).cfg.role).toBe("worker");

    const unsupported = interaction({ agent: "codex@local", effort: "ultra" });
    await acknowledgedHandler(unsupported.i, () => (orch as any).cmdConfigSet(unsupported.i));
    expect(unsupported.edits[0]).toMatch(/not supported by `codex\/gpt-5\.6-sol`/);
    expect(read(store).record.agentId).toBe("claude");
    store.close();
  });

  it("keeps JSON as full replacement mode and acknowledges before invalidation", async () => {
    const { orch, store } = makeHarness();
    const call = interaction({ json: '{"role":"planner","permissionPolicy":"deny"}' });
    await acknowledgedHandler(call.i, () => (orch as any).cmdConfigSet(call.i));
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
    await acknowledgedHandler(call.i, () => (orch as any).cmdConfigSet(call.i));
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
    const flushIdentity = (orch as any).identityEffects.flush as ReturnType<typeof vi.fn>;

    const call = interaction({ model: "gpt-5.4", repo: "alpha" }, { rebuild: true });
    await acknowledgedHandler(call.i, () => (orch as any).cmdConfigSet(call.i));

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(call.edits.at(-1)).toMatch(/Updated `model`, `repo`/);
    expect(call.edits.at(-1)).toMatch(/Rebuilt from Discord/);
    expect(call.edits.at(-1)).toMatch(/gpt-5\.4/);
    expect(call.edits.at(-1)).toMatch(/window 200000/);
    expect(read(store).cfg.model).toBe("gpt-5.4");
    expect(read(store).record.repoPath).toBe(path.join(reposRoot, "alpha"));
    expect(flushIdentity).toHaveBeenCalled();
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
    await acknowledgedHandler(empty.i, () => (orch as any).cmdConfigSet(empty.i));
    expect(empty.replies[0]).toMatch(/at least one named field/);
    expect(rebuild).not.toHaveBeenCalled();

    const call = interaction({}, { rebuild: true });
    await acknowledgedHandler(call.i, () => (orch as any).cmdConfigSet(call.i));
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
    await acknowledgedHandler(call.i, () => (orch as any).cmdConfigSet(call.i));
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
    await acknowledgedHandler(interaction({ name: "one-call", ...fields }).i, () => (oneCall.orch as any).cmdNew(interaction({ name: "one-call", ...fields }).i));
    const oneRecord = oneCall.store.get(`discord:${NEW_THREAD}`)!;
    const oneOverlay = oneCall.threadPresets.get(NEW_THREAD);

    const twoCalls = makeHarness();
    (twoCalls.orch as any).openConfigEditorCard = vi.fn(async () => true);
    await acknowledgedHandler(interaction({ name: "two-calls" }).i, () => (twoCalls.orch as any).cmdNew(interaction({ name: "two-calls" }).i));
    await acknowledgedHandler(interaction(fields, {}, { channelId: NEW_THREAD }).i, () => (twoCalls.orch as any).cmdConfigSet(
      interaction(fields, {}, { channelId: NEW_THREAD }).i
    ));
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
    const { orch, router, store, created, addedMembers, flushIdentity } = makeHarness();
    const invalidate = vi.spyOn(router, "invalidate");
    const getOrStart = vi.spyOn(router, "getOrStartRuntime");
    const realFlush = flushIdentity.getMockImplementation()!;
    flushIdentity.mockImplementationOnce(async (sessionId: string) => {
      const effective = router.describeConfig(store.get(sessionId)!);
      expect(effective.agent.value).toBe("codex");
      expect(effective.model.value).toBe("gpt-5.4");
      expect(effective.effort.value).toBe("high");
      expect(effective.role.value).toBe("qa");
      await realFlush(sessionId);
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

    await acknowledgedHandler(call.i, () => (orch as any).cmdNew(call.i));

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
    expect(flushIdentity).toHaveBeenCalledTimes(1);
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

    await acknowledgedHandler(call.i, () => (orch as any).cmdNew(call.i));

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

    await acknowledgedHandler(newCall.i, () => (orch as any).cmdNew(newCall.i));
    await acknowledgedHandler(setCall.i, () => (orch as any).cmdConfigSet(setCall.i));

    expect(newCall.edits.at(-1)).toBe(setCall.edits.at(-1));
    expect(created).toEqual([]);
    expect(store.get(`discord:${NEW_THREAD}`)).toBeNull();
    store.close();
  });

  it("rejects JSON/named mixing and invalid JSON shape before thread creation", async () => {
    const { orch, store, created } = makeHarness();
    const mixed = interaction({ json: '{"model":"gpt-5.4"}', role: "qa" });
    await acknowledgedHandler(mixed.i, () => (orch as any).cmdNew(mixed.i));
    expect(mixed.edits.at(-1)).toBe("Use either `json:` or named fields, not both.");

    const invalid = interaction({ json: '{"permissionPolicy":"sometimes"}' });
    await acknowledgedHandler(invalid.i, () => (orch as any).cmdNew(invalid.i));
    expect(invalid.edits.at(-1)).toMatch(/Invalid JSON.*permissionPolicy/);
    const invalidSet = interaction({ json: '{"permissionPolicy":"sometimes"}' });
    await acknowledgedHandler(invalidSet.i, () => (orch as any).cmdConfigSet(invalidSet.i));
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
    await acknowledgedHandler(jsonCall.i, () => (jsonHarness.orch as any).cmdNew(jsonCall.i));
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
    await acknowledgedHandler(clearCall.i, () => (clearHarness.orch as any).cmdNew(clearCall.i));
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
    const { orch, router, store, created, flushIdentity } = makeHarness();
    (orch as any).configMutation.applyThreadOverlay = () => ({
      ok: false,
      error: "injected overlay failure",
    });
    const call = interaction({ agent: "codex@local", model: "gpt-5.4", permissions: "always" });

    await acknowledgedHandler(call.i, () => (orch as any).cmdNew(call.i));

    expect(created).toHaveLength(1);
    const record = store.get(`discord:${NEW_THREAD}`)!;
    const effective = router.describeConfig(record);
    expect(record.agentId).toBe("claude");
    expect(effective.model.value).toBe("claude-opus-5");
    expect(effective.permission.value).toBe("ask");
    expect(call.edits.at(-1)).toMatch(
      /Created thread <#444444444444444444>, but configuration was not applied: injected overlay failure.*Actual: agent `claude`/
    );
    expect(flushIdentity).not.toHaveBeenCalled();
    store.close();
  });

  it("rejects rebuild:true before creation while rebuild:false remains inert", async () => {
    const rejected = makeHarness();
    const rebuild = interaction({ name: "no-clone" }, { rebuild: true });
    await acknowledgedHandler(rebuild.i, () => (rejected.orch as any).cmdNew(rebuild.i));
    expect(rebuild.replies.at(-1)).toMatch(/requires an existing thread with Discord history/);
    expect(rejected.created).toEqual([]);
    rejected.store.close();

    const inert = makeHarness();
    const ordinary = interaction({ name: "ordinary" }, { rebuild: false });
    (inert.orch as any).openConfigEditorCard = vi.fn(async () => true);
    await acknowledgedHandler(ordinary.i, () => (inert.orch as any).cmdNew(ordinary.i));
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

    await acknowledgedHandler(call.i, () => (orch as any).cmdNew(call.i));

    expect(call.edits.at(-1)).toBe("Could not create thread: Discord unavailable");
    expect(created).toEqual([]);
    expect(store.get(`discord:${NEW_THREAD}`)).toBeNull();
    store.close();
  });
});
