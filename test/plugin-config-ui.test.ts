import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import { classifyDiscordInteraction } from "../packages/core/src/platforms/discord/adapter.js";
import { parseCustomId } from "../packages/core/src/platforms/discord/config-editor.js";
import { namingFixture, NAMING_PARENT } from "./plugin-naming-fixture.js";

const THREAD = "100000000000000002";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: Parameters<typeof namingFixture>[0] = {}) {
  const h = await namingFixture(options);
  cleanups.push(h.close);
  await h.create(THREAD);
  fs.writeFileSync(h.config.CHANNEL_PRESETS_FILE!, JSON.stringify({ channels: { [NAMING_PARENT]: { role: { value: "worker" }, locked: options.locked ?? false } } }));
  (h.orchestrator as any).renderer = { codeBlock: (text: string, language: string) => `\`\`\`${language}\n${text}\n\`\`\`` };
  const panels: any[] = [];
  const ports = (h.orchestrator as any).configUi.ui.ports;
  ports.transport.sendPanel = vi.fn(async (_channel: unknown, panel: unknown) => { panels.push(panel); return { id: `panel-${panels.length}` }; });
  ports.transport.editPanel = vi.fn(async (_message: unknown, panel: unknown) => { panels.push(panel); });
  return { ...h, ports, panels };
}

function interaction(sub: string, values: Record<string, string | number | boolean> = {}, user = "admin") {
  const i = {
    commandName: "seam", channelId: THREAD, channel: { isThread: () => true, parentId: NAMING_PARENT }, user: { id: user, username: user, displayName: user },
    options: { getSubcommand: () => sub, getSubcommandGroup: () => "config", getString: (name: string) => typeof values[name] === "string" ? values[name] : null,
      getBoolean: (name: string) => typeof values[name] === "boolean" ? values[name] : null, getInteger: (name: string) => typeof values[name] === "number" ? values[name] : null },
    reply: vi.fn(async (_payload: unknown) => {}), deferReply: vi.fn(async () => {}), editReply: vi.fn(async (_payload: unknown) => {}),
  };
  return i;
}
function component(customId: string, user = "admin", fields?: Record<string, string>) {
  return {
    kind: fields ? "modal" as const : "button" as const, customId, userId: user, userName: user,
    channel: { platform: "discord", id: THREAD, parentId: NAMING_PARENT }, messageId: "panel-1", fields,
    replyEphemeral: vi.fn(async (_text: string) => {}), followUpEphemeral: vi.fn(async (_text: string) => {}), deferUpdate: vi.fn(async () => {}), showModal: vi.fn(async () => {}),
  };
}

describe("config UI built-in", () => {
  it("owns the four slash leaves and persistent button/select/modal namespace", async () => {
    const h = await fixture();
    const group = buildSlashRegistrationBody(h.host.slash).find(c => c.name === "seam")!.options!.find(g => g.name === "config")!;
    for (const name of ["show", "edit", "set", "audit"]) {
      expect((group as any).options.filter((leaf: any) => leaf.name === name)).toHaveLength(1);
      expect(h.host.slash.get("seam", "config", name)).toMatchObject({ authorization: "user", access: { kind: ["show", "audit"].includes(name) ? "read-only" : "mutating" } });
    }
    for (const kind of ["button", "select", "modal"] as const) {
      expect(h.host.components.classify("seam-cfg-edit:old:save", kind)).toBe("persistent");
      expect(classifyDiscordInteraction({ customId: "seam-cfg-edit:old:save", isChatInputCommand: () => false, isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isModalSubmit: () => kind === "modal" }, h.host.components)).toBe("plugin-component");
    }
    expect(h.host.slash.get("seam", "config", "set")!.autocomplete!.map(choice => choice.option)).toEqual(["agent", "model", "effort", "repo", "role", "permissions", "card", "gif"]);
  });

  it("saves the real modal draft once through the authenticated component path", async () => {
    const h = await fixture();
    await h.orchestrator.handleSlashInteraction(interaction("edit") as never);
    const draft = h.panels.at(-1);
    const id = parseCustomId(draft.actions.flat().find((action: any) => action.customId?.endsWith(":role")).customId)!.draftId;
    const stranger = component(`seam-cfg-edit:${id}:role-save`, "other", { role: "wrong" });
    await h.component(stranger);
    expect(stranger.replyEphemeral).toHaveBeenCalledWith("This editor isn't yours.");
    await h.component(component(`seam-cfg-edit:${id}:role-save`, "admin", { role: "qa" }));
    await h.component(component(`seam-cfg-edit:${id}:save`));
    expect(h.store.listConfigMutations()).toHaveLength(1);
    expect(h.store.listConfigMutations()[0]).toMatchObject({ actorId: "admin", actorName: "admin" });
    expect(h.config.threadPresets.get(THREAD)?.role?.value).toBe("qa");
    expect(h.panels.at(-1).footer).toMatch(/saved/i);
  });

  it("keeps show, set and audit output on the registry dispatch path", async () => {
    const h = await fixture();
    const set = interaction("set", { agent: "codex@local", role: "qa" });
    await h.orchestrator.handleSlashInteraction(set as never);
    expect(set.deferReply).toHaveBeenCalledTimes(1);
    expect(set.editReply.mock.calls.at(-1)?.[0]).toContain("Updated `agent`, `role`. Effective: agent `codex`, model `gpt-6.1-sol`");
    const show = interaction("show");
    await h.orchestrator.handleSlashInteraction(show as never);
    expect((show.reply.mock.calls[0]![0] as any).content).toContain('"role": "qa"');
    const audit = interaction("audit");
    await h.orchestrator.handleSlashInteraction(audit as never);
    expect((audit.reply.mock.calls[0]![0] as any).embeds[0].toJSON().title).toBe("📜 Config audit");
    const detail = interaction("audit", { entry: h.store.listConfigMutations()[0]!.id });
    await h.orchestrator.handleSlashInteraction(detail as never);
    expect((detail.reply.mock.calls[0]![0] as any).embeds[0].toJSON().title).toBe("📜 Config mutation");
  });

  it("keeps kernel lock/participant gates ahead of plugin commands", async () => {
    const h = await fixture({ admins: new Set(["admin"]), locked: true, participant: "other" });
    const edit = interaction("edit", {}, "other");
    await h.orchestrator.handleSlashInteraction(edit as never);
    expect(edit.reply).toHaveBeenCalledTimes(1);
    expect(h.ports.transport.sendPanel).not.toHaveBeenCalled();
    expect(h.store.listConfigMutations()).toEqual([]);
  });

  it("routes pre-restart draft cards to the unchanged expired view", async () => {
    const h = await fixture();
    await h.orchestrator.handleSlashInteraction(interaction("edit") as never);
    const customId = h.panels.at(-1).actions.flat().find((action: any) => action.customId?.endsWith(":save")).customId;
    const restarted = await fixture({ store: h.store, directory: h.directory });
    const click = component(customId);
    await restarted.component(click);
    expect(click.deferUpdate).toHaveBeenCalledTimes(1);
    expect(restarted.panels.at(-1)).toMatchObject({ footer: "draft expired", actions: [] });
    expect(h.store.listConfigMutations()).toEqual([]);
  });

  it("a failed UI contribution leaves sibling plugin and kernel work available", async () => {
    const h = await fixture();
    h.ports.readConfig = () => { throw new Error("real config read failure"); };
    const broken = interaction("show");
    await expect(h.orchestrator.handleSlashInteraction(broken as never)).rejects.toThrow("real config read failure");
    const naming = interaction("rename");
    naming.commandName = "seamadmin";
    naming.options.getSubcommandGroup = () => "naming";
    await h.orchestrator.handleSlashInteraction(naming as never);
    expect(naming.editReply).toHaveBeenCalled();
    const audit = interaction("audit");
    await h.orchestrator.handleSlashInteraction(audit as never);
    expect(audit.reply).toHaveBeenCalledTimes(1);
  });
});
