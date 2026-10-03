import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { buildSlashRegistrationBody, getSlashCommandAccess } from "../packages/core/src/platforms/discord/commands.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

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
  function interaction(commandName: string, group: string | null, sub: string, values: Record<string, string> = {}) {
    return {
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
    };
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
    for (const [sub, option] of [["role", "value"], ["card", "style"], ["gif", "state"]]) {
      expect(getSlashCommandAccess("seam", "config", sub)?.kind).toBe("read-only");
      expect(getSlashCommandAccess("seam", "config", sub, (name) => name === option ? "new" : null)?.kind).toBe("mutating");
    }
    expect(getSlashCommandAccess("seam", null, "cancel")).toMatchObject({ participantAllowed: true, lockExempt: true });
    expect(getSlashCommandAccess("seam", null, "cancel", () => "all")).toMatchObject({ participantAllowed: false, lockExempt: false });
    expect(getSlashCommandAccess("seam", null, "workflows")?.kind).toBe("read-only");
    for (const option of ["cancel-wake", "cancel-watch", "cancel-choice", "cancel-ingest", "cancel-live"]) {
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
    ["info", "usage", "cmdUsage"],
    ["info", "help", "cmdHelp"],
    ["info", "sessions", "cmdSessions"],
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
      fetchReply: async () => ({ createMessageComponentCollector: () => collector }),
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
    orch.buildScheduleListMessage = vi.fn(() => view);
    orch.renderWorkflowInventory = vi.fn(async () => ({ ...view, components: [{}] }));
    const refresh = vi.fn(async () => true);
    orch.attachListLifecycle = () => ({ refresh, terminal: vi.fn() });
    orch.resumeTurnManually = vi.fn();
    orch.abandonTurnManually = vi.fn();
    await orch[handler](i);
    const click = (customId: string) => Object.assign(interaction("seam", null, "workflows"), {
      customId, isButton: () => true, deferUpdate: vi.fn(async () => {}), update: vi.fn(async () => {}),
    });
    const page = click(pageId);
    await collect(page);
    expect(page.reply).not.toHaveBeenCalled();
    expect(page.deferUpdate.mock.calls.length + page.update.mock.calls.length).toBeGreaterThan(0);
    const mutation = click(mutationId);
    await collect(mutation);
    expect(mutation.reply).toHaveBeenCalledWith(expect.objectContaining({
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
