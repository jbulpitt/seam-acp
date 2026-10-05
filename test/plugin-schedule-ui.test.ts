import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import { buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import { classifyDiscordInteraction } from "../packages/core/src/platforms/discord/adapter.js";
import { namingFixture, NAMING_PARENT } from "./plugin-naming-fixture.js";
import { discordComponentInteractions } from "../packages/core/src/platforms/discord/component-interactions.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function existing(id = "sch_11a221c3"): ScheduledPrompt {
  return { id, platform: "discord", channelRef: "thread", parentRef: NAMING_PARENT,
    name: "existing", promptText: "unchanged", cron: "0 9 * * *", timezone: "America/Chicago",
    sessionMode: "live", model: null, cwd: null, targetChannel: null, outputType: "card",
    catchupSeconds: 7200, enabled: false, legacyAttachmentCount: 0, createdBy: "owner",
    createdUtc: "2026-10-01T00:00:00Z", updatedUtc: "2026-10-01T00:00:00Z",
    lastRunUtc: "2026-10-02T14:00:00Z", lastStatus: "ok", nextRunUtc: null, pinnedSessionId: "existing-acp" };
}

async function fixture() {
  const h = await namingFixture();
  cleanups.push(h.close);
  await h.create();
  const manager = { armFromRow: vi.fn(), disarm: vi.fn(), reschedule: vi.fn(), runNow: vi.fn(async () => {}) };
  h.orchestrator.setScheduledManager(manager as never);
  h.store.upsertScheduled(existing());
  return { ...h, manager };
}

function command(sub: string, id?: string, persistent?: (event: unknown) => Promise<void>) {
  const paints: any[] = [];
  const collector = Object.assign(new EventEmitter(), { stop: vi.fn((reason?: string) => collector.emit("end", undefined, reason)) });
  const native = {
    commandName: "seamadmin", channelId: "thread", channel: { isThread: () => true, parentId: NAMING_PARENT },
    user: { id: "admin", username: "admin" }, deferred: false, replied: false, ephemeral: true,
    options: { getSubcommandGroup: () => "schedule", getSubcommand: () => sub, getString: () => id ?? null, getBoolean: () => null, data: [] },
    reply: vi.fn(async (view: any) => { native.replied = true; paints.push(view); }),
    editReply: vi.fn(async (view: any) => { paints.push(view); return { id: "message", createMessageComponentCollector: () => collector }; }),
    deferReply: vi.fn(async () => { native.deferred = true; }),
    fetchReply: async () => ({ id: "message", createMessageComponentCollector: () => collector }),
  };
  const click = async (customId: string, values?: string[], fields: Record<string, string> = {}) => {
    let shown: any;
    const replies: any[] = [];
    const c = {
      ...native, customId, values: values ?? [], deferred: false, replied: false, ephemeral: null,
      message: { id: "message", components: (paints.at(-1)?.components ?? []).map((row: any) => ({
        components: row.components.map((button: any) => ({ customId: button.data.custom_id, disabled: button.data.disabled ?? false })),
      })) },
      isButton: () => !values, isStringSelectMenu: () => Boolean(values), isModalSubmit: () => false,
      reply: vi.fn(async (view: any) => { c.replied = true; replies.push(view); }),
      editReply: vi.fn(async (view: any) => { replies.push(view); paints.push(view); return { id: "message" }; }),
      deferReply: vi.fn(async () => { c.deferred = true; }),
      deferUpdate: vi.fn(async () => { c.deferred = true; }),
      update: vi.fn(async (view: any) => { paints.push(view); }),
      followUp: vi.fn(async (view: any) => { replies.push(view); return { id: "editor", createMessageComponentCollector: () => collector }; }),
      showModal: vi.fn(async (view: any) => { shown = view.toJSON(); }),
      awaitModalSubmit: async (options: any) => {
        const m = { customId: shown.custom_id, user: native.user, fields: { getTextInputValue: (name: string) => fields[name] ?? "" },
          deferred: false, replied: false, ephemeral: null, isModalSubmit: () => true, isStringSelectMenu: () => false,
          reply: async (view: any) => { replies.push(view); }, followUp: async (view: any) => { replies.push(view); },
          editReply: async (view: any) => { replies.push(view); }, deferUpdate: async () => { m.deferred = true; } };
        expect(options.filter(m)).toBe(true);
        return m;
      },
    };
    if (customId.startsWith("sl:") && persistent) {
      const event = { interactionId: "click", customId, userId: "admin", userName: "admin", kind: "button",
        channel: { platform: "discord", id: "thread", parentId: NAMING_PARENT }, messageId: "message",
        replyEphemeral: async (text: string) => c.reply({ content: text }),
      };
      discordComponentInteractions.set(event as never, c as never);
      await persistent(event);
    } else for (const listener of collector.listeners("collect")) await listener(c);
    return { c, replies, shown };
  };
  return { native, paints, collector, click };
}

describe("schedule UI built-in", () => {
  it("registers the unchanged slash leaves, persistent list and collector builder routes", async () => {
    const h = await fixture();
    const group = buildSlashRegistrationBody(h.host.slash).find(c => c.name === "seamadmin")!.options!.find(g => g.name === "schedule")!;
    expect((group as any).options.map((leaf: any) => leaf.name)).toEqual(["add", "list", "remove", "toggle", "edit"]);
    for (const name of ["add", "list", "remove", "toggle", "edit"]) {
      expect(h.host.slash.get("seamadmin", "schedule", name)).toMatchObject({
        authorization: "user", access: { kind: name === "list" ? "read-only" : "mutating" },
      });
    }
    for (const customId of ["sl:run:test", "sched:prompt", "sched:promptmodal:message"]) {
      const modal = customId.includes("modal");
      const list = customId.startsWith("sl:");
      expect(h.host.components.classify(customId, modal ? "modal" : "button")).toBe(list ? "persistent" : "collector");
      expect(classifyDiscordInteraction({ isChatInputCommand: () => false, isButton: () => !modal, isModalSubmit: () => modal, customId }, h.host.components)).toBe(list ? "plugin-component" : "none");
    }
  });

  it("creates, edits, toggles and removes only the selected row through the real slash and modal paths", async () => {
    const h = await fixture();
    const untouched = h.store.getScheduled("sch_11a221c3");
    const create = command("add");
    await h.orchestrator.handleSlashInteraction(create.native as never);
    await create.click("sched:prompt", undefined, { name: "probe", prompt: "initial" });
    await create.click("sched:cadence", ["__custom__"], { cron: "0 10 * * *" });
    await create.click("sched:mode");
    await create.click("sched:create");
    const row = h.store.listScheduledByChannel("discord", "thread").find(r => r.name === "probe")!;
    expect(row).toMatchObject({ promptText: "initial", cron: "0 10 * * *", sessionMode: "live", model: null, cwd: null, targetChannel: null });
    expect(h.manager.armFromRow).toHaveBeenCalledWith(row);
    const edit = command("edit", row.id);
    await h.orchestrator.handleSlashInteraction(edit.native as never);
    await edit.click("sched:prompt", undefined, { name: "edited", prompt: "updated" });
    await edit.click("sched:create");
    const updated = h.store.getScheduled(row.id)!;
    expect(updated).toMatchObject({ name: "edited", promptText: "updated", createdUtc: row.createdUtc, createdBy: row.createdBy, enabled: row.enabled, pinnedSessionId: row.pinnedSessionId });
    expect(h.manager.reschedule).toHaveBeenCalledWith(row.id);
    await h.orchestrator.handleSlashInteraction(command("toggle", row.id).native as never);
    expect(h.store.getScheduled(row.id)!.enabled).toBe(false);
    expect(h.manager.disarm).toHaveBeenCalledWith(row.id);
    await h.orchestrator.handleSlashInteraction(command("remove", row.id).native as never);
    expect(h.store.getScheduled(row.id)).toBeNull();
    expect(h.store.getScheduled("sch_11a221c3")).toEqual(untouched);
  });

  it("run-now stays on the kernel manager for both live and isolated schedules", async () => {
    const h = await fixture();
    for (const mode of ["live", "isolated"] as const) {
      const row = { ...existing(`sch_${mode}`), sessionMode: mode, enabled: true };
      h.store.upsertScheduled(row);
      const list = command("list", undefined, h.component);
      await h.orchestrator.handleSlashInteraction(list.native as never);
      await list.click(`sl:run:${row.id}`);
      expect(h.manager.runNow).toHaveBeenCalledWith(row.id);
    }
    h.orchestrator.setScheduledManager(undefined as never);
    const run = vi.spyOn(h.orchestrator, "runScheduledPrompt").mockResolvedValue(undefined);
    const list = command("list", undefined, h.component);
    await h.orchestrator.handleSlashInteraction(list.native as never);
    await list.click("sl:run:sch_live");
    expect(run).toHaveBeenCalledWith("sch_live");
    run.mockRestore();
  });

  it("runs a pre-restart list button through the new host without its original collector", async () => {
    const before = await fixture();
    const rows = before.store.listScheduledByChannel("discord", "thread");
    const old = command("list");
    await before.orchestrator.handleSlashInteraction(old.native as never);
    expect(old.collector.listenerCount("collect")).toBe(0);
    await before.host.dispose();
    const after = await namingFixture({ store: before.store, directory: before.directory });
    cleanups.push(after.close);
    after.orchestrator.setScheduledManager(before.manager as never);
    const click = command("list", undefined, after.component);
    click.paints.push(old.paints[0]);
    const { c, replies } = await click.click("sl:run:sch_11a221c3");
    expect(c.deferUpdate).toHaveBeenCalledOnce();
    expect(before.manager.runNow).toHaveBeenCalledExactlyOnceWith("sch_11a221c3");
    expect(replies.some(view => view.content?.includes("existing"))).toBe(true);
    expect(before.store.listScheduledByChannel("discord", "thread")).toEqual(rows);
  });

  it("freezes a persistent listing before opening its separate builder and saving its modal", async () => {
    const h = await fixture();
    const list = command("list", undefined, h.component);
    await h.orchestrator.handleSlashInteraction(list.native as never);
    const opened = await list.click("sl:edit:sch_11a221c3");
    expect(opened.c.deferUpdate).toHaveBeenCalledOnce();
    expect(opened.c.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    expect(opened.c.followUp).toHaveBeenCalledWith(expect.objectContaining({ flags: 64 }));
    await list.click("sched:prompt", undefined, { name: "changed", prompt: "edited via button" });
    await list.click("sched:create");
    expect(h.store.getScheduled("sch_11a221c3")).toMatchObject({ name: "changed", promptText: "edited via button", enabled: false });
  });

  it("keeps the existing one-editor claim for two concurrent persistent Edit clicks", async () => {
    const h = await fixture();
    const list = command("list", undefined, h.component);
    await h.orchestrator.handleSlashInteraction(list.native as never);
    const clicks = await Promise.all([list.click("sl:edit:sch_11a221c3"), list.click("sl:edit:sch_11a221c3")]);
    expect(clicks.reduce((n, click) => n + click.c.followUp.mock.calls.length, 0)).toBe(1);
    expect(list.collector.listenerCount("collect")).toBe(1);
  });

  it("plugin load and disposal do not alter existing schedules or stop the kernel manager", async () => {
    const h = await fixture();
    const rows = h.store.listScheduledByChannel("discord", "thread");
    const restarted = await namingFixture({ store: h.store, directory: h.directory });
    cleanups.push(restarted.close);
    expect(h.store.listScheduledByChannel("discord", "thread")).toEqual(rows);
    await restarted.host.dispose();
    expect(h.store.listScheduledByChannel("discord", "thread")).toEqual(rows);
    expect(h.manager.disarm).not.toHaveBeenCalled();
  });
});
