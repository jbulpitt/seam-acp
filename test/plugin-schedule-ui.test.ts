import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import { buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import { classifyDiscordInteraction } from "../packages/core/src/platforms/discord/adapter.js";
import { namingFixture, NAMING_PARENT } from "./plugin-naming-fixture.js";

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

function command(sub: string, id?: string) {
  const paints: any[] = [];
  const collector = Object.assign(new EventEmitter(), { stop: vi.fn((reason?: string) => collector.emit("end", undefined, reason)) });
  const native = {
    commandName: "seamadmin", channelId: "thread", channel: { isThread: () => true, parentId: NAMING_PARENT },
    user: { id: "admin", username: "admin" }, deferred: false, replied: false,
    options: { getSubcommandGroup: () => "schedule", getSubcommand: () => sub, getString: () => id ?? null, getBoolean: () => null, data: [] },
    reply: vi.fn(async (view: any) => { native.replied = true; paints.push(view); }),
    editReply: vi.fn(async (view: any) => { paints.push(view); }),
    deferReply: vi.fn(async () => { native.deferred = true; }),
    fetchReply: async () => ({ id: "message", createMessageComponentCollector: () => collector }),
  };
  const click = async (customId: string, values?: string[], fields: Record<string, string> = {}) => {
    let shown: any;
    const replies: any[] = [];
    const c = {
      ...native, customId, values: values ?? [], deferred: false, replied: false,
      isButton: () => !values, isStringSelectMenu: () => Boolean(values),
      reply: vi.fn(async (view: any) => { c.replied = true; replies.push(view); }),
      editReply: vi.fn(async (view: any) => { replies.push(view); }),
      deferReply: vi.fn(async () => { c.deferred = true; }),
      deferUpdate: vi.fn(async () => { c.deferred = true; }),
      update: vi.fn(async (view: any) => { paints.push(view); }),
      followUp: vi.fn(async (view: any) => { replies.push(view); }),
      showModal: vi.fn(async (view: any) => { shown = view.toJSON(); }),
      awaitModalSubmit: async (options: any) => {
        const m = { customId: shown.custom_id, user: native.user, fields: { getTextInputValue: (name: string) => fields[name] ?? "" },
          reply: async (view: any) => { replies.push(view); }, followUp: async (view: any) => { replies.push(view); }, deferUpdate: async () => {} };
        expect(options.filter(m)).toBe(true);
        return m;
      },
    };
    for (const listener of collector.listeners("collect")) await listener(c);
    return { c, replies, shown };
  };
  return { native, paints, collector, click };
}

describe("schedule UI built-in", () => {
  it("registers the unchanged slash leaves and collector component routes", async () => {
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
      expect(h.host.components.classify(customId, modal ? "modal" : "button")).toBe("collector");
      expect(classifyDiscordInteraction({ isChatInputCommand: () => false, isButton: () => !modal, isModalSubmit: () => modal, customId }, h.host.components)).toBe("none");
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
      const list = command("list");
      await h.orchestrator.handleSlashInteraction(list.native as never);
      await list.click(`sl:run:${row.id}`);
      expect(h.manager.runNow).toHaveBeenCalledWith(row.id);
    }
    h.orchestrator.setScheduledManager(undefined as never);
    const run = vi.spyOn(h.orchestrator, "runScheduledPrompt").mockResolvedValue(undefined);
    const list = command("list");
    await h.orchestrator.handleSlashInteraction(list.native as never);
    await list.click("sl:run:sch_live");
    expect(run).toHaveBeenCalledWith("sch_live");
    run.mockRestore();
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
