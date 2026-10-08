import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { parseCustomId } from "../packages/core/src/platforms/discord/config-editor.js";
import { SyntheticInteraction } from "../packages/core/src/platforms/discord/synthetic-interaction.js";
import { namingFixture, NAMING_PARENT } from "./plugin-naming-fixture.js";

const THREAD = "100000000000000002";
const CAUSE = "provider retirement failed: connection reset by peer";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(agent: "claude" | "codex") {
  const h = await namingFixture();
  cleanups.push(h.close);
  Object.assign(h.router.getProfile(agent)!, {
    effort: agent === "claude"
      ? { mechanism: "meta", levels: ["low", "high"] }
      : { mechanism: "configOption", configId: "effort", levels: ["low", "high"] },
  });
  const row = await h.create(THREAD);
  h.store.upsert({ ...row, agentId: agent, acpSessionId: "existing-context",
    configJson: JSON.stringify({ model: h.router.getProfile(agent)!.defaultModel, reasoningEffort: "low" }) }, { source: "fixture", cause: "set provider binding for test" });
  fs.writeFileSync(h.config.CHANNEL_PRESETS_FILE!, JSON.stringify({ channels: { [NAMING_PARENT]: { role: { value: "worker" } } } }));
  const clock = { t: 0 };
  const message = { id: "reply", edit: vi.fn(async () => message) };
  const ctx = {
    client: {} as never, user: { id: "admin", username: "admin", displayName: "admin" } as never, member: null,
    channel: { id: THREAD, parentId: NAMING_PARENT, isThread: () => true, send: vi.fn(async () => message) } as never,
    now: () => clock.t,
  };
  const slash = (subcommand: string, options: Record<string, string> = {}) => new SyntheticInteraction({
    kind: "slash", channelId: THREAD, command: "seam", subcommandGroup: "config", subcommand, options,
  }, ctx);
  const panels: any[] = [];
  const ports = (h.orchestrator as any).configUi.ui.ports;
  ports.transport.sendPanel = vi.fn(async (_channel: unknown, panel: unknown) => { panels.push(panel); return { id: "editor" }; });
  ports.transport.editPanel = vi.fn(async (_message: unknown, panel: unknown) => { panels.push(panel); });
  const installPicker = () => {
    let click!: SyntheticInteraction;
    let customId: string;
    const pickerMessage = { id: "picker", edit: vi.fn(async (_payload: unknown) => pickerMessage), awaitMessageComponent: vi.fn(async () => {
      click = new SyntheticInteraction({ kind: "button", channelId: THREAD, messageId: "picker", customId }, ctx);
      return click;
    }) };
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    (adapter as any).fetchSendableChannel = async () => ({ send: async (payload: any) => {
      customId = payload.components.flatMap((row: any) => row.toJSON().components).find((button: any) => button.label === "High").custom_id;
      return pickerMessage;
    } });
    const pick = adapter.sendChoicePicker.bind(adapter);
    (h.orchestrator as any).adapter.sendChoicePicker = pick;
    ports.transport.sendChoicePicker = pick;
    return { get click() { return click; }, pickerMessage };
  };
  return { ...h, clock, ctx, slash, ports, panels, installPicker };
}

describe.each(["claude", "codex"] as const)("%s effort interaction acknowledgement", agent => {
  it.each(["direct", "picker", "set", "editor"] as const)("acknowledges %s before a slow transition and reports success afterwards", async entry => {
    const h = await fixture(agent);
    const entered = gate();
    const release = gate();
    let picker: ReturnType<typeof h.installPicker> | undefined;
    let acknowledgement: SyntheticInteraction;
    let operation: Promise<void>;
    if (entry === "editor") {
      h.installPicker();
      await h.orchestrator.handleSlashInteraction(h.slash("edit") as never);
      const id = parseCustomId(h.panels.at(-1).actions.flat().find((a: any) => a.customId.endsWith(":effort")).customId)!.draftId;
      const component = (action: string) => ({
        kind: "button", customId: `seam-cfg-edit:${id}:${action}`, userId: "admin", userName: "admin",
        channel: { platform: "discord", id: THREAD, parentId: NAMING_PARENT }, messageId: "editor",
        deferUpdate: async () => {}, replyEphemeral: async () => {}, followUpEphemeral: async () => {},
      });
      await h.component(component("effort"));
      const save = h.ports.saveEditor;
      h.ports.saveEditor = vi.fn(async (...args: unknown[]) => { entered.resolve(); await release.promise; return save(...args); });
      acknowledgement = new SyntheticInteraction({ kind: "button", channelId: THREAD, messageId: "editor", customId: `seam-cfg-edit:${id}:save` }, h.ctx);
      operation = h.nativeComponent(acknowledgement);
    } else {
      if (entry === "picker") picker = h.installPicker();
      h.router.hasRuntime = () => true;
      h.router.invalidate = vi.fn(async () => { entered.resolve(); await release.promise; });
      acknowledgement = h.slash(entry === "set" ? "set" : "effort", entry === "picker" ? {} : { [entry === "set" ? "effort" : "level"]: "high" });
      operation = h.orchestrator.handleSlashInteraction(acknowledgement as never);
    }
    cleanups.push(async () => { release.resolve(); await operation.catch(() => {}); });
    await Promise.race([entered.promise, operation.then(() => { throw new Error("Transition was not reached"); })]);
    expect(acknowledgement.transcript[0]).toMatchObject({ op: entry === "editor" ? "deferUpdate" : "deferReply", atMs: 0 });
    expect(acknowledgement.transcript.some(e => e.content?.includes("Reasoning effort set"))).toBe(false);
    if (picker) {
      expect(picker.click.transcript[0]).toMatchObject({ op: "deferUpdate", atMs: 0 });
      expect(picker.pickerMessage.edit).not.toHaveBeenCalled();
    }
    h.clock.t = 4_000;
    release.resolve();
    await operation;
    expect(acknowledgement.transcript.every(e => !e.error)).toBe(true);
    if (entry === "editor") expect(h.panels.at(-1).footer).toMatch(/saved/i);
    else expect(acknowledgement.transcript.at(-1)).toMatchObject({ op: "editReply", atMs: 4_000, ephemeral: true, content: expect.stringContaining(entry === "set" ? "effort `high`" : "Reasoning effort set to `high`") });
    if (picker) expect((picker.pickerMessage.edit.mock.calls.at(-1) as any)[0].embeds[0].toJSON().title).toBe("✅ Effort changed");
    expect(h.router.describeConfig(h.store.getByChannel("discord", THREAD)!).effort.value).toBe("high");
    expect(h.store.getByChannel("discord", THREAD)!.acpSessionId).toBe("existing-context");
  });

  it.each(["direct", "picker", "set"] as const)("reports the real %s transition error after acknowledging", async entry => {
    const h = await fixture(agent);
    const picker = entry === "picker" ? h.installPicker() : undefined;
    h.router.hasRuntime = () => true;
    h.router.invalidate = vi.fn(async () => { h.clock.t = 4_000; throw new Error(CAUSE); });
    const interaction = h.slash(entry === "set" ? "set" : "effort", entry === "picker" ? {} : { [entry === "set" ? "effort" : "level"]: "high" });
    await h.orchestrator.handleSlashInteraction(interaction as never);
    expect(interaction.transcript[0]).toMatchObject({ op: "deferReply", atMs: 0 });
    expect(interaction.transcript.at(-1)).toMatchObject({ op: "editReply", atMs: 4_000, content: expect.stringContaining(CAUSE) });
    expect(interaction.transcript.some(e => e.content?.includes("Reasoning effort set"))).toBe(false);
    if (picker) {
      const failedPanel = (picker.pickerMessage.edit.mock.calls.at(-1) as any)[0].embeds[0].toJSON();
      expect(failedPanel.description).toContain(CAUSE);
      expect(failedPanel.title).not.toBe("✅ Effort changed");
    }
  });

  it("reports an editor Save transition exception through the acknowledged click", async () => {
    const h = await fixture(agent);
    h.installPicker();
    await h.orchestrator.handleSlashInteraction(h.slash("edit") as never);
    const id = parseCustomId(h.panels.at(-1).actions.flat().find((a: any) => a.customId.endsWith(":effort")).customId)!.draftId;
    const click = new SyntheticInteraction({ kind: "button", channelId: THREAD, messageId: "editor", customId: `seam-cfg-edit:${id}:save` }, h.ctx);
    const component = (action: string) => ({
      kind: "button", customId: `seam-cfg-edit:${id}:${action}`, userId: "admin", userName: "admin",
      channel: { platform: "discord", id: THREAD, parentId: NAMING_PARENT }, messageId: "editor",
      deferUpdate: () => click.deferUpdate(), replyEphemeral: async () => {}, followUpEphemeral: (content: string) => click.followUp({ content, flags: 64 }),
    });
    await h.component({ ...component("effort"), deferUpdate: async () => {} });
    h.ports.saveEditor = vi.fn(async () => { h.clock.t = 4_000; throw new Error(CAUSE); });
    await h.nativeComponent(click);
    expect(click.transcript[0]).toMatchObject({ op: "deferUpdate", atMs: 0 });
    expect(click.transcript.at(-1)).toMatchObject({ op: "followUp", atMs: 4_000, content: `Could not save: ${CAUSE}` });
    expect(h.panels.at(-1).footer).not.toMatch(/saved/i);
  });
});
