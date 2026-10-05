import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { MessageFlags } from "discord.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { getSlashAcknowledgement } from "../packages/core/src/platforms/discord/commands.js";

function fixture(values: Record<string, string> = {}) {
  const orch = Object.create(Orchestrator.prototype) as any;
  orch.logger = pino({ level: "silent" });
  orch.config = { SEAM_CONFIG_ADMIN_USER_IDS: new Set(["admin"]), channelPresets: new Map() };
  orch.plugins = new PluginHost(orch.logger);
  orch.loadPlugins = async () => {};
  orch.runInbound = (_kind: string, handle: () => Promise<void>) => handle();
  const order: string[] = [];
  const interaction = {
    commandName: "seam", channelId: "thread", user: { id: "admin" },
    options: { getString: (name: string) => values[name] ?? null, getInteger: () => null,
      getSubcommand: () => "workflows", getSubcommandGroup: () => null },
    deferred: false, replied: false, ephemeral: true,
    deferReply: vi.fn(async () => { order.push("defer"); interaction.deferred = true; }),
    editReply: vi.fn(async () => { order.push("edit"); }),
    reply: vi.fn(),
  };
  return { orch, interaction, order };
}

describe("workflow acknowledgement", () => {
  it("declares an ephemeral response for inventory and cancellation leaves", () => {
    expect(getSlashAcknowledgement("seam", null, "workflows")).toBe("ephemeral");
  });

  it("starts inventory reads before the ACK round trip, but waits to send the result", async () => {
    const { orch, interaction, order } = fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    interaction.deferReply.mockImplementation(async () => {
      order.push("defer");
      await pending;
      interaction.deferred = true;
    });
    orch.renderWorkflowInventory = vi.fn(async () => {
      order.push("inventory");
      return { embeds: [], components: [], page: 0 };
    });
    const result = orch.handleSlashInteraction(interaction);
    await Promise.resolve();
    expect(order).toEqual(["defer", "inventory"]);
    expect(interaction.editReply).not.toHaveBeenCalled();
    release();
    await result;
    expect(order).toEqual(["defer", "inventory", "edit"]);
    expect(interaction.deferReply).toHaveBeenCalledOnce();
  });

  it("acknowledges before awaiting a slow inventory and edits the deferred response", async () => {
    const { orch, interaction, order } = fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    orch.renderWorkflowInventory = vi.fn(async () => {
      order.push("inventory");
      await pending;
      return { embeds: [], components: [], page: 0 };
    });
    const result = orch.handleSlashInteraction(interaction);
    await Promise.resolve();
    expect(order).toEqual(["defer", "inventory"]);
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).not.toHaveBeenCalled();
    release();
    await result;
    expect(order).toEqual(["defer", "inventory", "edit"]);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it.each(["cancel-wake", "cancel-watch", "cancel-choice", "cancel-ingest", "cancel-live"])(
    "acknowledges before %s normalization and retains its real error", async option => {
      const { orch, interaction, order } = fixture({ [option]: "id" });
      orch.normalizeAutocompleteSubmission = vi.fn(async () => {
        order.push("normalize");
        throw new Error("workflow lookup unavailable");
      });
      await orch.handleSlashInteraction(interaction);
      expect(order).toEqual(["defer", "normalize", "edit"]);
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: "workflow lookup unavailable", embeds: [], components: [],
      });
      expect(interaction.reply).not.toHaveBeenCalled();
    },
  );

  it("edits the acknowledgement with a real inventory failure", async () => {
    const { orch, interaction } = fixture();
    orch.renderWorkflowInventory = vi.fn(async () => { throw new Error("SQLITE_BUSY: database is locked"); });
    await orch.handleSlashInteraction(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "SQLITE_BUSY: database is locked" }));
  });

  it("requires the existing admin identity for explicit all-thread scope", async () => {
    const { orch, interaction } = fixture({ scope: "all" });
    interaction.user.id = "not-admin";
    orch.renderWorkflowInventory = vi.fn();
    await orch.handleSlashInteraction(interaction);
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "The all-threads workflows view is admin-only." });
    expect(orch.renderWorkflowInventory).not.toHaveBeenCalled();
  });

  it("defers before explicit admin bulk abandonment and uses the selected scope", async () => {
    const { orch, interaction, order } = fixture({ "abandon-older-than": "7", scope: "all" });
    orch.abandonOldWorkflows = vi.fn(async () => { order.push("abandon"); return "Abandoned 2; records kept"; });
    await orch.handleSlashInteraction(interaction);
    expect(order).toEqual(["defer", "abandon", "edit"]);
    expect(orch.abandonOldWorkflows).toHaveBeenCalledWith(7, undefined);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Abandoned 2; records kept" });
  });

  it("defaults bulk abandonment to this thread", async () => {
    const { orch, interaction } = fixture({ "abandon-older-than": "14" });
    orch.abandonOldWorkflows = vi.fn(async () => "kept");
    await orch.handleSlashInteraction(interaction);
    expect(orch.abandonOldWorkflows).toHaveBeenCalledWith(14, "thread");
  });

  it("keeps bulk abandonment admin-only", async () => {
    const { orch, interaction } = fixture({ "abandon-older-than": "7" });
    interaction.user.id = "not-admin";
    orch.abandonOldWorkflows = vi.fn();
    await orch.handleSlashInteraction(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Bulk workflow abandonment is admin-only." });
    expect(orch.abandonOldWorkflows).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "not-days"])("rejects invalid day input %s without mutating", async days => {
    const { orch, interaction } = fixture({ "abandon-older-than": days });
    orch.abandonOldWorkflows = vi.fn();
    await orch.handleSlashInteraction(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Pass a positive whole number of days for `abandon-older-than`." });
    expect(orch.abandonOldWorkflows).not.toHaveBeenCalled();
  });
});
