import { presetUiFixture } from "./plugin-presets-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSlashRegistrationBody, getSlashCommandAccess } from "../packages/core/src/platforms/discord/commands.js";
import { scheduleUiFixture } from "./plugin-schedule-fixture.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { createConfigUiPlugin, type ConfigUi } from "../packages/core/src/plugins/config-ui/index.js";
import { CONFIG_UI_LEAVES } from "../packages/core/src/plugins/config-ui/commands.js";
import { createQuotaPlugin } from "../packages/core/src/plugins/quota/index.js";
import { createCardVisualsPlugin } from "../packages/core/src/plugins/card-visuals/index.js";
import { sessionBrowserPlugin } from "../packages/core/src/plugins/session-browser/index.js";
import type { SessionBrowserFacade } from "../packages/core/src/core/session-browser.js";
import { acknowledgeComponentInteraction } from "../packages/core/src/platforms/discord/interaction-response.js";

const ADMIN = "101";
const PARTICIPANT = "102";
const OPERATOR = "103";

function fixture({ locked = false, participant = false, user = PARTICIPANT, identity = true } = {}) {
  const orch = Object.create(Orchestrator.prototype) as any;
  orch.config = {
    SEAM_PARTICIPANT_USER_IDS: participant ? new Set([PARTICIPANT]) : undefined,
    SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    SPEAKER_IDENTITY_ENABLED: identity,
    channelPresets: new Map(locked ? [["parent", { locked: true }]] : []),
  };
  orch.logger = pino({ level: "silent" });
  orch.plugins = new PluginHost(orch.logger);
  orch.identityEffects = { ready: Promise.resolve(), flush: async () => {} };
  orch.scheduleUi = { ready: Promise.resolve() };
  orch.presetsUi = { ready: Promise.resolve() };
  const configInteractions = new WeakMap<object, unknown>();
  orch.configUi = { ready: Promise.resolve(), bind: (invocation: object, native: unknown) => configInteractions.set(invocation, native) };
  const configPlugin = createConfigUiPlugin({
    ports: { autocomplete: [], interaction: (invocation: object) => configInteractions.get(invocation) },
    ...Object.fromEntries(CONFIG_UI_LEAVES.map(leaf => [leaf.method, (native: unknown) => orch[leaf.method](native)])),
  } as unknown as ConfigUi);
  orch.plugins.slash.register(configPlugin.id, configPlugin.contributions.slash!, { logger: orch.logger, config: undefined });
  function interaction(commandName: string, group: string | null, sub: string, values: Record<string, string> = {}) {
    const i = {
      commandName,
      channelId: "thread",
      channel: { isThread: () => true, parentId: "parent" },
      user: { id: user },
      options: {
        getSubcommand: () => sub,
        getSubcommandGroup: () => group,
        getString: (name: string) => values[name] ?? null,
        getInteger: () => null,
      },
      reply: vi.fn(async () => {}),
      deferred: false, replied: false, ephemeral: true,
      deferReply: vi.fn(async () => { i.deferred = true; }),
      editReply: vi.fn(async () => {}),
    };
    return i;
  }
  return { orch, interaction };
}

describe("slash leaf access", () => {
  it("declares access for every registered leaf, without changing Discord JSON", () => {
    for (const command of buildSlashRegistrationBody()) {
      for (const entry of command.options ?? []) {
        const group = entry.type === 2 ? entry.name : null;
        const leaves = entry.type === 2 ? entry.options ?? [] : [entry];
        for (const leaf of leaves) {
          expect(getSlashCommandAccess(command.name, group, leaf.name)?.kind, `${command.name}/${group}/${leaf.name}`)
            .toMatch(/^(read-only|mutating)$/);
          expect(leaf).not.toHaveProperty("access");
        }
      }
    }
  });

  it("uses the full path, not a leaf-name allowlist", () => {
    expect(getSlashCommandAccess("seam", "preset", "show")?.kind).toBe("read-only");
    expect(getSlashCommandAccess("seam", "preset", "edit")?.kind).toBe("mutating");
    expect(getSlashCommandAccess("seam", "info", "avatar")?.kind).toBe("mutating");
    expect(getSlashCommandAccess("seam", "config", "help")).toBeUndefined();
  });

  it("classifies read/write options and local versus global cancellation", () => {
    for (const [sub, option] of [["role", "value"]]) {
      expect(getSlashCommandAccess("seam", "config", sub)?.kind).toBe("read-only");
      expect(getSlashCommandAccess("seam", "config", sub, (name) => name === option ? "new" : null)?.kind).toBe("mutating");
    }
    const visuals = createCardVisualsPlugin({ read: () => undefined, write: () => ({ ok: true }) });
    for (const contribution of visuals.contributions.slash!) {
      const access = contribution.access as (get: (name: string) => string | null) => { kind: string };
      expect(access(() => null).kind).toBe("read-only");
      expect(access(name => name === (contribution.leaf.name === "card" ? "style" : "state") ? "new" : null).kind).toBe("mutating");
    }
    expect(getSlashCommandAccess("seam", null, "cancel")).toMatchObject({ participantAllowed: true, lockExempt: true });
    expect(getSlashCommandAccess("seam", null, "cancel", () => "all")).toMatchObject({ participantAllowed: false, lockExempt: false });
    expect(getSlashCommandAccess("seam", null, "workflows")?.kind).toBe("read-only");
    for (const option of ["resume", "cancel-wake", "cancel-watch", "cancel-choice", "cancel-ingest", "cancel-live"]) {
      expect(getSlashCommandAccess("seam", null, "workflows", (name) => name === option ? "id" : null)?.kind).toBe("mutating");
    }
  });
});

describe.each([
  { participant: true, locked: false, user: PARTICIPANT },
  { participant: false, locked: true, user: OPERATOR },
])("read-only versus mutation dispatch $participant/$locked", (config) => {
  it.each([
    ["info", "whoami", "cmdWhoami"],
    ["info", "help", "cmdHelp"],
    ["config", "show", "cmdConfig"],
    ["config", "audit", "cmdConfigAudit"],
  ])("allows %s %s through the real slash handler", async (group, sub, handler) => {
    const { orch, interaction } = fixture(config);
    orch[handler] = vi.fn(async () => {});
    const i = interaction("seam", group, sub);
    await orch.handleSlashInteractionInner(i);
    expect(orch[handler]).toHaveBeenCalledWith(i);
    expect(i.reply).not.toHaveBeenCalled();
  });

  it("allows plugin-owned sessions through the real slash gate", async () => {
    const { orch, interaction } = fixture(config);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-sessions-gate-"));
    orch.plugins = new PluginHost(orch.logger, { storageRoot: root });
    const open = vi.fn(async () => undefined);
    try {
      await orch.plugins.loadBuiltins([{ id: "session-browser", load: async () =>
        sessionBrowserPlugin({ open } as unknown as SessionBrowserFacade) }]);
      const i = interaction("seam", "info", "sessions");
      await orch.handleSlashInteractionInner(i);
      expect(open).toHaveBeenCalledWith(expect.objectContaining({
        threadId: "thread", parentId: "parent", actor: expect.objectContaining({ id: config.user }),
      }));
      expect(i.reply).not.toHaveBeenCalled();
    } finally {
      await orch.plugins.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows plugin-owned usage through the real slash gate", async () => {
    const { orch, interaction } = fixture(config);
    const binding = { agentId: "grok", displayName: "Grok", location: "local", account: "grok", provider: "grok" as const, quotaAvailable: true };
    const readUsage = vi.fn(async () => ({ provider: "grok" as const, data: { subscriptionTier: "Free", creditUsagePercent: null, periodType: null, periodEnd: null } }));
    await orch.plugins.loadBuiltins([{ id: "quota", load: async () => createQuotaPlugin({
      usage: { readUsage }, bindings: () => [binding], resolve: () => binding, card: {},
    }) }], { quota: { QUOTA_STALE_RETENTION_MS: 0, OLLAMA_CLOUD_ENABLED: false } });
    const i = Object.assign(interaction("seam", "info", "usage"), {
      editReply: vi.fn(async () => {}),
    });
    await orch.handleSlashInteractionInner(i);
    expect(readUsage).toHaveBeenCalledWith(binding);
    expect(i.editReply).toHaveBeenCalledWith({ content: "**Grok usage** — Free\nNo billing data available." });
    expect(i.reply).not.toHaveBeenCalled();
    await orch.plugins.dispose();
  });

  it("refuses mutation before invoking its handler", async () => {
    const { orch, interaction } = fixture(config);
    orch.cmdRole = vi.fn();
    const i = interaction("seam", "config", "role", { value: "changed" });
    await orch.handleSlashInteractionInner(i);
    expect(orch.cmdRole).not.toHaveBeenCalled();
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringMatching(config.participant ? /admin setting/ : /channel is locked/),
    }));
  });

  it.each([
    ["cmdPresetList", "pr:page:0", "pr:del:p1"],
    ["cmdScheduleList", "sl:page:0", "sl:del:p1"],
    ["cmdWorkflows", "wf:page:0", "wf:abandon:p1"],
  ])("keeps %s navigation read-only and its buttons mutation-gated", async (handler, pageId, mutationId) => {
    const { orch, interaction } = fixture(config);
    let collect!: (click: any) => Promise<void>;
    const collector = { on: (_event: string, callback: typeof collect) => { collect = callback; } };
    const i = Object.assign(interaction("seam", null, "workflows"), {
      fetchReply: async () => ({ id: "list", createMessageComponentCollector: () => collector }),
      editReply: vi.fn(async () => {}),
    });
    const row = { id: "p1", channelRef: "thread", name: "fixture" };
    const del = vi.fn();
    orch.store = {
      listPresetsForProject: () => [row], getPreset: () => row, deletePreset: del,
      listScheduledByChannel: () => [row], getScheduled: () => row, deleteScheduled: del,
    };
    orch.projectScopeId = () => "parent";
    orch.channelRefFromInteraction = () => ({ platform: "discord", id: "thread", parentId: "parent" });
    const view = { embeds: [], components: [], page: 0 };
    orch.buildPresetListMessage = vi.fn(() => view);
    orch.renderWorkflowInventory = vi.fn(async () => ({ ...view, components: [{}] }));
    const refresh = vi.fn(async () => true);
    orch.attachListLifecycle = () => ({ refresh, terminal: vi.fn() });
    orch.resumeTurnManually = vi.fn();
    orch.abandonTurnManually = vi.fn();
    if (handler === "cmdScheduleList") {
      const fixture = scheduleUiFixture(orch);
      fixture.ui.buildScheduleListMessage = () => view;
      await fixture.ui.cmdScheduleList(fixture.interaction(i));
      collect = async click => {
        await acknowledgeComponentInteraction(click, "update");
        await fixture.ui.handleListClick({
          ...fixture.interaction(click), channelRef: { platform: "discord", id: "thread", parentId: "parent" },
          messageId: "list", messageButtons: [], mutationRefusal: () => orch.slashAccessRefusal(click, { kind: "mutating" }),
          editReply: async () => refresh(),
        } as never);
      };
    } else if (handler === "cmdPresetList") {
      const fixture = presetUiFixture(orch);
      (fixture.ui as any).buildPresetListMessage = () => view;
      await fixture.ui.cmdPresetList(fixture.interaction(i));
      const card = [...fixture.ui.cards.states.values()][0]!;
      collect = async click => {
        await acknowledgeComponentInteraction(click, "update");
        click.customId = `${click.customId}:${card.id}`;
        await fixture.ui.cards.handle(fixture.interaction(click));
      };
    } else await orch[handler](i);
    const click = (customId: string) => {
      const native = Object.assign(interaction("seam", null, "workflows"), {
        customId, isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
        message: { id: "list", components: [] }, deferred: false, replied: false, ephemeral: null,
        deferUpdate: vi.fn(async () => { native.deferred = true; }), update: vi.fn(async () => {}),
        editReply: vi.fn(async () => {}), followUp: vi.fn(async () => {}),
      });
      return native;
    };
    const page = click(pageId);
    await collect(page);
    expect(page.reply).not.toHaveBeenCalled();
    expect(page.deferUpdate.mock.calls.length + page.update.mock.calls.length).toBeGreaterThan(0);
    const mutation = click(mutationId);
    await collect(mutation);
    expect(mutation.followUp).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringMatching(config.participant ? /admin setting/ : /channel is locked/),
    }));
    expect(del).not.toHaveBeenCalled();
    expect(orch.abandonTurnManually).not.toHaveBeenCalled();
  });
});

describe("Discord-authenticated admin", () => {
  it.each([true, false])("allows listed admin with prompt stamping %s", async (identity) => {
    const { orch, interaction } = fixture({ identity, user: ADMIN, locked: true });
    orch.cmdScheduledWork = vi.fn(async () => {});
    const i = interaction("seamadmin", "debug", "work");
    await orch.handleSlashInteractionInner(i);
    expect(orch.cmdScheduledWork).toHaveBeenCalledWith(i);
    expect(i.reply).not.toHaveBeenCalled();
  });

  it("does not grant admin access merely because the command is read-only", async () => {
    const { orch, interaction } = fixture({ identity: false, user: OPERATOR, locked: true });
    orch.cmdScheduledWork = vi.fn();
    const i = interaction("seamadmin", "debug", "work");
    await orch.handleSlashInteractionInner(i);
    expect(orch.cmdScheduledWork).not.toHaveBeenCalled();
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/admin-only/) }));
  });
});
