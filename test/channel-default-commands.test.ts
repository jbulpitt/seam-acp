import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { buildChannelPresetMaps, type Config } from "../packages/core/src/config.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { ParentConfigCleanup } from "../packages/core/src/core/channel-config-cleanup.js";
import { configTarget } from "../packages/core/src/core/config-target.js";
import { applyPickerValue, buildSavePlan, INHERIT_VALUE, type ThreadConfigDraft } from "../packages/core/src/platforms/discord/config-editor.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { visualConfig } from "./plugin-card-visuals-fixture.js";
import { localBridgeHub, localBridgeWiring } from "./local-bridge-fixture.js";

const PARENT = "100000000000000001";
const THREAD = "100000000000000002";
const CATEGORY = "100000000000000003";
const actor = { id: "admin", name: "Admin" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-channel-default-"));
  const file = path.join(dir, "presets.json");
  fs.writeFileSync(file, JSON.stringify({ channels: { [PARENT]: {
    agent: { value: "claude" }, model: { value: "claude-channel" }, effort: { value: "high" },
    role: { value: "worker" }, statusCardStyle: { value: "simple" }, simpleCardGif: { value: true },
  } }, threads: {} }));
  const logger = pino({ level: "silent" });
  const store = new SessionStore(path.join(dir, "seam.db"));
  const profiles = ["claude", "codex"].map(id => ({ id, displayName: id, defaultModel: `${id}-default`,
    staticModels: ["default", "channel", "pin"].map(name => ({ modelId: `${id}-${name}`, name })),
    effort: { mechanism: "meta", levels: ["low", "high"] },
    spawn: () => { throw new Error("No provider request in this test"); },
  })) as unknown as AgentProfile[];
  const catalog = fixtureModelCatalog(profiles);
  const maps = buildChannelPresetMaps(file);
  const config = { ...maps, ...visualConfig, DATA_DIR: dir, REPOS_ROOT: dir, CHANNEL_PRESETS_FILE: file,
    DEFAULT_AGENT: "claude", DEFAULT_MODEL: "claude-default", DISCORD_ALLOWED_USER_IDS: new Set([actor.id]),
    SEAM_CONFIG_ADMIN_USER_IDS: new Set([actor.id]), REPO_EMOJIS: new Map(), TURN_TIMEOUT_SECONDS: 60 } as Config;
  const router = new SessionRouter({ store, logger, profiles, modelCatalog: catalog, ...maps,
    defaultAgentId: "claude", defaultModel: "claude-default", defaultCwd: dir,
    seamMcp: localBridgeWiring(profiles) });
  const adapter = { sendMessage: vi.fn(async (channel, _text) => ({ channel, id: "notice" })),
    sendPanel: vi.fn(async (channel, _panel) => ({ channel, id: "hub" })), editPanel: vi.fn(async (_message: unknown, _panel: any) => {}),
    getThreadName: vi.fn(async (_channel: { id: string }): Promise<string | null> => null),
    getThreadLiveState: vi.fn(async () => ({ locked: false, archived: false })),
    renameThread: vi.fn(async (_channel: { id: string }, _name: string) => {}),
    sendChoicePicker: vi.fn(async (_channel: unknown, _options: any): Promise<{ value: string; userId: string } | null> => null), configParentChannels: async () => [{ id: PARENT, name: "project", guildId: "guild", guildName: "Guild" }] };
  const orchestrator = new Orchestrator({ config, logger, store, router, modelCatalog: catalog,
    adapter: adapter as never, renderer: { codeBlock: (value: string) => value } as never });
  orchestrator.setBridgeHub(localBridgeHub(profiles, dir));
  await orchestrator.loadPlugins();
  const ui = (orchestrator as any).configUi.ui;
  const plan = orchestrator.getConfigApplyPlan();
  cleanups.push(async () => { await (orchestrator as any).plugins.dispose(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const native = (sub: string, values: Record<string, string> = {}, isThread = false, category?: string) => {
    const i = { commandName: "seam", channelId: isThread ? THREAD : PARENT, channel: { isThread: () => isThread, parentId: isThread ? PARENT : category },
      user: { id: actor.id, username: actor.name, displayName: actor.name }, deferred: false, replied: false, ephemeral: true,
      options: { getSubcommand: () => sub, getSubcommandGroup: () => "config", getString: (name: string) => values[name] ?? null, getBoolean: () => null, getInteger: () => null },
      deferReply: vi.fn(async () => { i.deferred = true; }), reply: vi.fn(async () => {}), editReply: vi.fn(async () => {}),
    };
    return i;
  };
  const slash = async (...args: Parameters<typeof native>) => {
    const i = native(...args);
    await orchestrator.handleSlashInteraction(i as never);
    return i;
  };
  const row = () => router.ensureSessionRecord({ platform: "discord", channelRef: THREAD, parentRef: PARENT, cwd: dir });
  const cleanup = new ParentConfigCleanup({ config, store, plan: () => plan, parents: adapter.configParentChannels });
  return { dir, file, config, store, router, plan, adapter, orchestrator, ui, native, slash, row, cleanup, logger: (orchestrator as any).logger };
}

async function blockChannelRename(h: Awaited<ReturnType<typeof fixture>>) {
  let name = "proof thread";
  h.adapter.getThreadName.mockImplementation(async () => name);
  h.adapter.renameThread.mockImplementation(async (_channel, next) => { name = next; });
  const row = h.row();
  await h.orchestrator.flushIdentityEffects(row.id);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  h.adapter.renameThread.mockClear();
  h.adapter.renameThread.mockImplementationOnce(async (_channel, next) => {
    await gate;
    name = next;
    finished = true;
  });
  return { release, finished: () => finished };
}

describe("configuration scope through the real dispatcher", () => {
  it.each([false, true])("renders committed channel defaults after Inherit (thread editor = %s)", async isThread => {
    const h = await fixture();
    // #762 §3: Saved must describe the committed result, not fold the old draft.
    expect(h.plan.applyChannelOverlay({ channelId: PARENT,
      changes: { role: "qa", disableThreadPrefix: true }, actor }).ok).toBe(true);
    const channel = { platform: "discord", id: isThread ? THREAD : PARENT,
      ...(isThread ? { parentId: PARENT } : {}) };
    const draft = await h.ui.openConfigEditorCard(channel, actor.id, "channel") as ThreadConfigDraft;
    expect(draft.snapshot.channelPins).toMatchObject({ agent: "claude", model: "claude-channel", effort: "high", role: "qa", disableThreadPrefix: true });
    let next = applyPickerValue(draft, "agent", INHERIT_VALUE, () => undefined);
    next = applyPickerValue(next, "role", INHERIT_VALUE, () => undefined);
    next = applyPickerValue(next, "prefix", INHERIT_VALUE, () => undefined);
    h.ui.configEditor.put(next);
    await h.ui.handleConfigEditorComponent({ kind: "button", customId: `seam-cfg-edit:${draft.id}:save`,
      channel, messageId: draft.messageId, userId: actor.id, userName: actor.name,
      followUpEphemeral: vi.fn(async () => {}) });
    const committed = h.ui.ports.snapshot(channel);
    for (const field of ["agent", "model", "effort", "role", "disableThreadPrefix"] as const) {
      expect(committed.channelPins[field]).toBeUndefined();
    }
    expect(committed.withoutThread.role).toBeNull();
    expect(committed.withoutThread.disableThreadPrefix).toBe(false);
    const panel = h.adapter.editPanel.mock.calls.at(-1)![1];
    const fields = Object.fromEntries(panel.fields.map((field: { name: string; value: string }) => [field.name, field.value]));
    expect(fields.Agent).toBe("`channel default` · default");
    expect(fields.Model).toBe("`channel default` · default");
    expect(fields.Effort).toBe("`channel default` · default");
    expect(fields.Role).toBe("`not set` · default");
    expect(fields["Auto-name"]).toBe("`enabled` · default");
    expect(panel.footer).toContain("✅ Saved");
    expect(panel.actions).toEqual([]);
    expect(h.store.getByChannel("discord", PARENT)).toBeUndefined();
    expect(h.ui.configEditor.get(draft.id)).toBeUndefined();
  });

  it("renders the channel's committed values and sources after thread Inherit", async () => {
    const h = await fixture();
    h.row();
    expect(h.plan.applyThreadOverlay({ threadId: THREAD, parentRef: PARENT,
      changes: { model: "claude-pin", effort: "low" }, actor }).ok).toBe(true);
    const channel = { platform: "discord", id: THREAD, parentId: PARENT };
    const draft = await h.ui.openConfigEditorCard(channel, actor.id) as ThreadConfigDraft;
    h.ui.configEditor.put({ ...draft, overlay: { model: null, effort: null } });
    await h.ui.handleConfigEditorComponent({ kind: "button", customId: `seam-cfg-edit:${draft.id}:save`,
      channel, messageId: draft.messageId, userId: actor.id, userName: actor.name,
      followUpEphemeral: vi.fn(async () => {}) });
    const panel = h.adapter.editPanel.mock.calls.at(-1)![1];
    const fields = Object.fromEntries(panel.fields.map((field: { name: string; value: string }) => [field.name, field.value]));
    expect(fields.Model).toBe("`claude-channel` · channel");
    expect(fields.Effort).toBe("`high` · channel");
    expect(panel.footer).toContain("✅ Saved");
  });

  it.each([false, true])("renders a role command result before naming (thread scope:channel = %s)", async isThread => {
    const h = await fixture();
    const naming = await blockChannelRename(h);
    const i = h.native("role", { value: "qa", ...(isThread ? { scope: "channel" } : {}) }, isThread);
    const running = h.orchestrator.handleSlashInteraction(i as never);
    try {
      await vi.waitFor(() => {
        expect(h.adapter.renameThread).toHaveBeenCalled();
        expect(i.editReply).toHaveBeenCalled();
      }, { timeout: 500 });
      expect(naming.finished()).toBe(false);
      expect(h.config.channelPresets.get(PARENT)?.role?.value).toBe("qa");
      expect(JSON.stringify(i.editReply.mock.calls)).toContain("Channel default updated");
      expect(i.deferReply).toHaveBeenCalledTimes(1);
    } finally {
      naming.release();
      await running;
      await h.orchestrator.flushIdentityEffects(`discord:${THREAD}`);
    }
    expect(naming.finished()).toBe(true);
  });

  it("renders parent editor Save while a sibling rename is still pending", async () => {
    const h = await fixture();
    const naming = await blockChannelRename(h);
    const draft = await h.ui.openConfigEditorCard({ platform: "discord", id: PARENT }, actor.id) as ThreadConfigDraft;
    h.ui.configEditor.put(applyPickerValue(draft, "role", "qa", () => undefined));
    h.adapter.editPanel.mockClear();
    const evt = { kind: "button", customId: `seam-cfg-edit:${draft.id}:save`,
      channel: { platform: "discord", id: PARENT }, messageId: draft.messageId,
      userId: actor.id, userName: actor.name, followUpEphemeral: vi.fn(async () => {}) };
    const running = h.ui.handleConfigEditorComponent(evt as never);
    try {
      await vi.waitFor(() => {
        expect(h.adapter.renameThread).toHaveBeenCalled();
        expect(h.adapter.editPanel).toHaveBeenCalled();
        expect(h.ui.configEditor.get(draft.id)).toBeUndefined();
      }, { timeout: 500 });
      expect(naming.finished()).toBe(false);
      expect(h.config.channelPresets.get(PARENT)?.role?.value).toBe("qa");
      expect(JSON.stringify(h.adapter.editPanel.mock.calls)).toContain("✅ Saved");
      expect(JSON.stringify(evt.followUpEphemeral.mock.calls)).toContain("Channel default saved");
    } finally {
      naming.release();
      await running;
      await h.orchestrator.flushIdentityEffects(`discord:${THREAD}`);
    }
    expect(naming.finished()).toBe(true);
  });

  it("logs the real sibling rename error after committing a channel result", async () => {
    const h = await fixture();
    const naming = await blockChannelRename(h);
    naming.release();
    const err = new Error("Discord HTTP 502 Bad Gateway");
    h.adapter.renameThread.mockReset().mockRejectedValue(err);
    const warn = vi.spyOn(h.logger, "warn");
    const i = await h.slash("role", { value: "qa" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err, parentRef: PARENT, threadId: THREAD }), "thread name recompaction failed",
    ));
    expect(JSON.stringify(i.editReply.mock.calls)).toContain("Channel default updated");
    expect(h.config.channelPresets.get(PARENT)?.role?.value).toBe("qa");
    await h.orchestrator.flushIdentityEffects(`discord:${THREAD}`);
  });

  const direct = [
    ["agent", "id", "codex", "agent"], ["model", "id", "claude-pin", "model"],
    ["effort", "level", "low", "effort"], ["role", "value", "qa", "role"],
  ] as const;
  it.each(direct.flatMap(entry => [undefined, CATEGORY].map(category => [...entry, category] as const)))
    ("parent %s writes channels, including a categorized parent", async (sub, option, value, field, category) => {
      const h = await fixture();
      const i = await h.slash(sub, { [option]: value }, false, category);
      expect(i.deferReply).toHaveBeenCalledTimes(1);
      expect(h.config.channelPresets.get(PARENT)?.[field]?.value).toBe(value);
      expect(h.store.listSessionsUncapped()).toEqual([]);
      expect(h.config.threadPresets.size).toBe(0);
      expect(h.config.channelPresets.has(CATEGORY)).toBe(false);
      expect(JSON.stringify(i.editReply.mock.calls)).toContain("Channel default updated");
    });

  it.each(direct)("thread %s scope:channel writes its parent without binding a session", async (sub, option, value, field) => {
    const h = await fixture();
    await h.slash(sub, { [option]: value, scope: "channel" }, true);
    expect(h.config.channelPresets.get(PARENT)?.[field]?.value).toBe(value);
    expect(h.store.listSessionsUncapped()).toEqual([]);
    expect(h.config.threadPresets.size).toBe(0);
  });

  it("parent repo targets the channel rather than its category", async () => {
    const h = await fixture();
    await h.slash("repo", { path: h.dir }, false, CATEGORY);
    expect(h.config.channelPresets.get(PARENT)?.cwd?.value).toBe(h.dir);
    expect(h.config.channelPresets.has(CATEGORY)).toBe(false);
    expect(h.store.listSessionsUncapped()).toEqual([]);
  });

  it.each([["agent", "codex"], ["model", "claude-pin"], ["effort", "low"]] as const)
    ("parent %s picker commits channel defaults without a session", async (sub, selected) => {
      const h = await fixture();
      h.adapter.sendChoicePicker.mockImplementationOnce(async (_channel: unknown, options: any) => {
        const choice = options.choices.find((entry: any) => entry.value === selected);
        expect(choice).toBeDefined();
        expect(await options.commit(choice)).toMatchObject({ ok: true });
        return { value: selected, userId: actor.id } as never;
      });
      await h.slash(sub);
      expect(h.config.channelPresets.get(PARENT)?.[sub]?.value).toBe(selected);
      expect(h.store.listSessionsUncapped()).toEqual([]);
    });

  it("config set in a categorized parent uses channel defaults", async () => {
    const h = await fixture();
    await h.slash("set", { model: "claude-pin", effort: "low", role: "qa", repo: h.dir }, false, CATEGORY);
    expect(h.config.channelPresets.get(PARENT)).toMatchObject({ model: { value: "claude-pin" }, effort: { value: "low" }, role: { value: "qa" }, cwd: { value: h.dir } });
    expect(h.store.listSessionsUncapped()).toEqual([]);
    expect(h.config.threadPresets.size).toBe(0);
  });

  it("parent editor Save uses channel scope and cannot create a parent session", async () => {
    const h = await fixture();
    await h.slash("edit", {}, false, CATEGORY);
    const draft = h.ui.configEditor.getForUserThread(actor.id, PARENT) as ThreadConfigDraft;
    expect(draft).toMatchObject({ parentRef: PARENT, channelOnly: true, editScope: "channel" });
    let next = applyPickerValue(draft, "model", "claude-pin", () => undefined);
    next = applyPickerValue(next, "effort", "low", () => undefined);
    next = applyPickerValue(next, "role", "qa", () => undefined);
    expect(await h.plan.saveEditor(next, actor, () => true)).toMatchObject({ ok: true });
    expect(h.config.channelPresets.get(PARENT)).toMatchObject({ model: { value: "claude-pin" }, effort: { value: "low" }, role: { value: "qa" } });
    expect(h.store.listSessionsUncapped()).toEqual([]);
    expect(h.config.threadPresets.size).toBe(0);
  });

  it("parent editor agent-only changes drop the previous agent's model and effort", async () => {
    const h = await fixture();
    const draft = await h.ui.openConfigEditorCard({ platform: "discord", id: PARENT }, actor.id) as ThreadConfigDraft;
    const next = applyPickerValue(draft, "agent", "codex", () => undefined);
    expect(await h.plan.saveEditor(next, actor, () => true)).toMatchObject({ ok: true });
    expect(h.config.channelPresets.get(PARENT)?.agent?.value).toBe("codex");
    expect(h.config.channelPresets.get(PARENT)?.model).toBeUndefined();
    expect(h.config.channelPresets.get(PARENT)?.effort).toBeUndefined();
    expect(h.plan.describeTarget({ platform: "discord", id: PARENT }).model.value).toBe("codex-default");
    expect(h.store.listSessionsUncapped()).toEqual([]);
  });

  it.each(["agent", "model"] as const)("direct %s inherit clears the same identity pins as its picker", async field => {
    const h = await fixture();
    const row = h.row();
    h.plan.applyThreadOverlay({ threadId: THREAD, parentRef: PARENT, changes: { agent: "claude", model: "claude-pin", effort: "low" }, actor });
    h.store.upsert({ ...row, configJson: JSON.stringify({ model: "claude-pin", reasoningEffort: "low" }) });
    await h.slash(field, { id: "inherit" }, true);
    const saved = h.store.get(row.id)!;
    expect(h.config.threadPresets.get(THREAD)?.model).toBeUndefined();
    expect(h.config.threadPresets.get(THREAD)?.effort).toBeUndefined();
    expect(h.store.readConfig(saved).model).toBeUndefined();
    expect(h.store.readConfig(saved).reasoningEffort).toBeUndefined();
    if (field === "agent") expect(h.config.threadPresets.get(THREAD)?.agent).toBeUndefined();
  });

  it.each([["card", "style", "full", "statusCardStyle", "full"], ["gif", "state", "off", "simpleCardGif", false]] as const)
    ("parent %s applies the same scope contract", async (sub, option, value, field, expected) => {
      const h = await fixture();
      await h.slash(sub, { [option]: value }, false, CATEGORY);
      expect(h.config.channelPresets.get(PARENT)?.[field]?.value).toBe(expected);
      expect(h.store.listSessionsUncapped()).toEqual([]);
      expect(h.config.threadPresets.size).toBe(0);
    });

  it("reports override counts but changes no existing thread without confirmation", async () => {
    const h = await fixture();
    const row = h.row();
    h.plan.applyThreadOverlay({ threadId: THREAD, parentRef: PARENT, changes: { model: "claude-pin", role: "private" }, actor });
    const before = h.store.get(row.id);
    await h.slash("model", { id: "claude-default" });
    expect(JSON.stringify((h.adapter.sendChoicePicker as any).mock.calls)).toContain("model: 1");
    expect(h.config.threadPresets.get(THREAD)?.model?.value).toBe("claude-pin");
    expect(h.store.get(row.id)).toEqual(before);
  });

  it.each([["card", "style", "full", "statusCardStyle", "full"], ["gif", "state", "off", "simpleCardGif", false]] as const)
    ("parent %s with legacy session scope still writes only channel defaults", async (sub, option, value, field, expected) => {
      const h = await fixture();
      const i = await h.slash(sub, { [option]: value, scope: "session" }, false, CATEGORY);
      expect(i.deferReply).toHaveBeenCalledTimes(1);
      expect(h.config.channelPresets.get(PARENT)?.[field]?.value).toBe(expected);
      expect(h.config.channelPresets.has(CATEGORY)).toBe(false);
      expect(h.store.listSessionsUncapped()).toEqual([]);
      expect(h.config.threadPresets.size).toBe(0);
    });

  it("confirmed apply clears just the requested pins and legacy mirrors", async () => {
    const h = await fixture();
    const row = h.row();
    h.store.upsert({ ...row, configJson: JSON.stringify({ model: "claude-pin", role: "legacy" }) });
    h.plan.applyThreadOverlay({ threadId: THREAD, parentRef: PARENT, changes: { model: "claude-pin", role: "private" }, actor });
    h.adapter.sendChoicePicker.mockImplementationOnce(async (_channel: unknown, options: any) => {
      expect(options.authorizedUserIds).toEqual(new Set([actor.id]));
      await options.commit({ value: "apply", label: "Confirm" });
      return { value: "apply", userId: actor.id } as never;
    });
    await h.slash("model", { id: "claude-default" });
    expect(h.config.threadPresets.get(THREAD)?.model).toBeUndefined();
    expect(h.store.readConfig(h.store.get(row.id)!).model).toBeUndefined();
    expect(h.config.threadPresets.get(THREAD)?.role?.value).toBe("private");
    expect(h.router.describeConfig(h.store.get(row.id)!).model).toEqual({ value: "claude-default", source: "channel preset" });
  });

  it("editor inherit clears a legacy-only value even when the file has no pin", async () => {
    const h = await fixture();
    const row = h.row();
    h.store.upsert({ ...row, repoPath: h.dir, configJson: JSON.stringify({ model: "claude-pin", reasoningEffort: "low", role: "legacy", sessionCwdExplicit: true, statusCardStyle: "full", simpleCardGif: false }) });
    const draft = await h.ui.openConfigEditorCard({ platform: "discord", id: THREAD, parentId: PARENT }, actor.id) as ThreadConfigDraft;
    draft.overlay = { model: null, effort: null, role: null, cwd: null, statusCardStyle: null, simpleCardGif: null };
    expect(draft.snapshot.model.source).toBe("channel preset");
    expect(draft.snapshot.threadOverrides).toEqual(expect.arrayContaining(["model", "effort", "role", "cwd", "statusCardStyle", "simpleCardGif"]));
    expect(buildSavePlan(draft).threadPreset).toMatchObject({ model: null, effort: null, role: null, cwd: null });
    expect(await h.plan.saveEditor(draft, actor, () => true)).toMatchObject({ ok: true });
    const saved = h.store.get(row.id)!;
    expect(h.store.readConfig(saved)).not.toHaveProperty("role");
    expect(h.store.readConfig(saved)).not.toHaveProperty("model");
    expect(h.store.readConfig(saved)).not.toHaveProperty("reasoningEffort");
    expect(h.store.readConfig(saved)).not.toHaveProperty("statusCardStyle");
    expect(h.store.readConfig(saved)).not.toHaveProperty("simpleCardGif");
    expect(saved.repoPath).toBeNull();
    expect(h.router.describeConfig(saved)).toMatchObject({ role: { value: "worker", source: "channel preset" }, statusCardStyle: { value: "simple", source: "channel preset" }, simpleCardGif: { value: true, source: "channel preset" } });
  });

  it("bulk inherit removes both the thread pin and its legacy mirror", async () => {
    const h = await fixture();
    const row = h.row();
    h.plan.applyThreadOverlay({ threadId: THREAD, parentRef: PARENT, changes: { model: "claude-pin", effort: "low" }, actor });
    h.store.upsert({ ...row, configJson: JSON.stringify({ model: "claude-pin", reasoningEffort: "low" }) });
    await h.slash("set", { model: "inherit", effort: "default" }, true);
    const current = h.store.get(row.id)!;
    expect(h.config.threadPresets.get(THREAD)?.model).toBeUndefined();
    expect(h.store.readConfig(current).model).toBeUndefined();
    expect(h.store.readConfig(current).reasoningEffort).toBeUndefined();
    expect(h.router.describeConfig(current)).toMatchObject({ model: { value: "claude-channel" }, effort: { value: "high" } });
  });

  it("a thread card pin is part of the editor's inherit plan", async () => {
    const h = await fixture(); h.row();
    h.plan.applyThreadOverlay({ threadId: THREAD, parentRef: PARENT, changes: { statusCardStyle: "full", simpleCardGif: false }, actor });
    const draft = await h.ui.openConfigEditorCard({ platform: "discord", id: THREAD, parentId: PARENT }, actor.id) as ThreadConfigDraft;
    draft.overlay = { statusCardStyle: null, simpleCardGif: null };
    expect(buildSavePlan(draft).threadPreset).toMatchObject({ statusCardStyle: null, simpleCardGif: null });
    expect(await h.plan.saveEditor(draft, actor, () => true)).toMatchObject({ ok: true });
    expect(h.config.threadPresets.get(THREAD)?.statusCardStyle).toBeUndefined();
    expect(h.config.threadPresets.get(THREAD)?.simpleCardGif).toBeUndefined();
  });
});

describe("explicit parent configuration cleanup", () => {
  async function misfiled() {
    const h = await fixture();
    const parent = h.router.ensureSessionRecord({ platform: "discord", channelRef: PARENT, parentRef: CATEGORY, cwd: h.dir });
    h.store.upsert({ ...parent, configJson: JSON.stringify({ model: "claude-pin", role: "old", reasoningEffort: "low" }) });
    h.plan.applyThreadOverlay({ threadId: PARENT, parentRef: CATEGORY, changes: { cwd: h.dir }, actor });
    const row = h.row();
    h.plan.applyThreadOverlay({ threadId: THREAD, parentRef: PARENT, changes: { role: "private" }, actor });
    return { ...h, parent, row };
  }

  it("dry-run reports guild, moves, preserved fields and override counts without any write", async () => {
    const h = await misfiled();
    const file = fs.readFileSync(h.file, "utf8");
    const rows = h.store.listSessionsUncapped();
    const audits = h.store.listConfigMutations();
    const preview = await h.cleanup.preview();
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({ id: PARENT, guildId: "guild", sessionId: h.parent.id, threadEntry: true, changes: { cwd: h.dir }, overrides: { role: 1 } });
    expect(preview.entries[0].preserved).toEqual(expect.arrayContaining(["agent", "model", "effort", "role"]));
    expect(fs.readFileSync(h.file, "utf8")).toBe(file);
    expect(h.store.listSessionsUncapped()).toEqual(rows);
    expect(h.store.listConfigMutations()).toEqual(audits);
  });

  it("confirmed cleanup is idempotent and preserves channel defaults and real thread data", async () => {
    const h = await misfiled();
    const thread = h.store.get(h.row.id);
    const pins = h.config.threadPresets.get(THREAD);
    expect(await h.cleanup.apply(await h.cleanup.preview(), actor)).toBe(1);
    expect(h.store.get(h.parent.id)).toBeNull();
    expect(h.config.threadPresets.has(PARENT)).toBe(false);
    expect(h.config.channelPresets.get(PARENT)).toMatchObject({ model: { value: "claude-channel" }, role: { value: "worker" }, cwd: { value: h.dir } });
    expect(h.store.get(h.row.id)).toEqual(thread);
    expect(h.config.threadPresets.get(THREAD)).toEqual(pins);
    expect(await h.cleanup.preview()).toEqual({ entries: [] });
    expect(await h.cleanup.apply(await h.cleanup.preview(), actor)).toBe(0);
    expect(h.store.listConfigMutations()).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: actor.id, summary: "Confirmed cleanup of misfiled parent-channel configuration" })]));
  });

  it("a changed preview needs another explicit confirmation", async () => {
    const h = await misfiled();
    const preview = await h.cleanup.preview();
    h.plan.applyChannelOverlay({ channelId: PARENT, changes: { cwd: h.dir }, actor });
    await expect(h.cleanup.apply(preview, actor)).rejects.toThrow("Cleanup preview changed");
    expect(h.store.get(h.parent.id)).not.toBeNull();
  });

  it("a misfiled thread entry with no session still gets a cleanup before-image", async () => {
    const h = await fixture();
    h.plan.applyThreadOverlay({ threadId: PARENT, changes: { cwd: h.dir }, actor });
    const preview = await h.cleanup.preview();
    expect(preview.entries[0]).toMatchObject({ threadEntry: true, changes: { cwd: h.dir } });
    expect(preview.entries[0].sessionId).toBeUndefined();
    expect(await h.cleanup.apply(preview, actor)).toBe(1);
    expect(h.config.threadPresets.has(PARENT)).toBe(false);
    const audit = h.store.listConfigMutations().find(entry => entry.summary === "Confirmed cleanup of misfiled parent-channel configuration");
    expect(audit?.beforeJson).toBe(preview.entries[0].source);
    expect(await h.cleanup.preview()).toEqual({ entries: [] });
  });

  it("a transient Discord inventory error is not an empty successful preview", async () => {
    const h = await misfiled();
    const cleanup = new ParentConfigCleanup({ config: h.config, store: h.store, plan: () => h.plan, parents: async () => { throw new Error("Discord 503"); } });
    await expect(cleanup.preview()).rejects.toThrow("Discord 503");
    expect(h.store.get(h.parent.id)).not.toBeNull();
  });

  it("a presets read failure reports the cause and leaves every row intact", async () => {
    const h = await misfiled();
    fs.writeFileSync(h.file, "not JSON");
    await expect(h.cleanup.preview()).rejects.toThrow();
    expect(h.store.get(h.parent.id)).not.toBeNull();
    expect(h.store.get(h.row.id)).not.toBeNull();
  });

  it("the admin UI never applies before the explicit confirmation choice", async () => {
    const h = await misfiled();
    const reply = vi.fn(async () => {});
    await h.ui.cmdConfigCleanup({ threadId: PARENT, actor, reply });
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Dry-run only: 1"));
    expect(h.store.get(h.parent.id)).not.toBeNull();
    const options = (h.adapter.sendChoicePicker as any).mock.calls.at(-1)[1];
    await options.commit({ value: "keep" });
    expect(h.store.get(h.parent.id)).not.toBeNull();
    await options.commit({ value: "apply" });
    expect(h.store.get(h.parent.id)).toBeNull();
  });
});

it("uses one target rule for parent, thread and channel-default scope", () => {
  expect(configTarget({ platform: "discord", id: PARENT })).toEqual({ kind: "channel", id: PARENT });
  expect(configTarget({ platform: "discord", id: THREAD, parentId: PARENT })).toEqual({ kind: "thread", id: THREAD, parentRef: PARENT });
  expect(configTarget({ platform: "discord", id: THREAD, parentId: PARENT }, "channel")).toEqual({ kind: "channel", id: PARENT });
});
