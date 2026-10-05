import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { pino } from "pino";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { sessionBrowserPlugin, browserAccess } from "../packages/core/src/plugins/session-browser/index.js";
import { classifyDiscordInteraction } from "../packages/core/src/platforms/discord/adapter.js";
import { buildSeamCommand, buildSeamAdminCommand } from "../packages/core/src/platforms/discord/commands.js";
import type { BrowserClick, SessionBrowserFacade } from "../packages/core/src/core/session-browser.js";
import type { SessionActions } from "../packages/core/src/core/session-actions.js";
import type { ComponentEvent } from "../packages/core/src/platforms/chat-adapter.js";
import type { SlashInvocation } from "../packages/core/src/plugins/slash-registry.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); vi.useRealTimers(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-session-browser-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const logger = pino({ level: "silent" });
  const views: any[] = [];
  const modals: any[] = [];
  const jobs = new Set<Promise<void>>();
  let summarizer = "admitted-model";
  let active = "first";
  const list = vi.fn(async () => ["first", "second"].map(sessionId => ({ sessionId, createdAt: 1, lastActivityAt: 2, previewLines: [] })));
  const attach = vi.fn(async (sessionId: string) => { active = sessionId; });
  const imported = vi.fn(async (_sessionId: string, _cwd: string, _model: string, complete: (id: string) => Promise<void>) => complete("imported"));
  const migrated = vi.fn(async (_sessionId: string, _actor: { id: string; name: string }, complete: (id: string) => Promise<void>) => complete("migrated"));
  const actions = {
    info: { id: "discord:thread", platform: "discord", channelRef: "thread", parentRef: "parent",
      agentId: "source", displayName: "Source", cwd: "/srv/repos/project", acpSessionId: "first" },
    snapshot: () => "original-host-and-cwd",
    list, attach, activeSessionId: () => active,
    capabilities: () => ({ canCompact: true, canRepair: false, canPremiumSession: false, canPremiumDiscord: false,
      migrationTargets: [{ id: "target", displayName: "Target" }] }),
    migrationTarget: () => ({ id: "target", displayName: "Target", migrate: migrated }),
    compactionModel: () => summarizer,
    resolveImportCwd: (cwd: string) => cwd,
    import: imported,
  } as unknown as SessionActions;
  const reply = { target: "private-reply", user: { id: "owner" }, channelId: "thread",
    editReply: vi.fn(async (view: unknown) => { views.push(view); }), deleteReply: vi.fn(async () => {}), followUp: vi.fn(async () => {}) };
  const track = (work: Promise<void>) => {
    jobs.add(work);
    void work.then(() => jobs.delete(work), () => jobs.delete(work));
    return work;
  };
  const ports: SessionBrowserFacade = {
    open: async invocation => { await invocation.defer(); return { actions, reply }; },
    resume: vi.fn(() => actions), reply: vi.fn(() => reply),
    collectParked: vi.fn(async () => 0), repoDisplay: cwd => cwd,
    track, runJob: work => { track(Promise.resolve().then(work)); },
    settle: async input => { await input.lifecycle.refresh(input.view); return "live"; },
    click: event => ({ customId: event.customId, user: { id: event.userId, name: event.userName }, values: event.values ?? [],
      fields: { getTextInputValue: name => event.fields?.[name] ?? "" },
      isStringSelectMenu: () => event.kind === "select", isModalSubmit: () => event.kind === "modal",
      deferUpdate: event.deferUpdate, editReply: reply.editReply, deleteReply: reply.deleteReply,
      reply: async () => {}, followUp: async () => {}, showModal: async modal => { modals.push(modal.toJSON()); },
    }) as BrowserClick,
  };
  const boot = async () => {
    const host = new PluginHost(logger, { storageRoot: root,
      slash: [buildSeamCommand().toJSON(), buildSeamAdminCommand().toJSON()] });
    await host.loadBuiltins([{ id: "session-browser", load: async () => sessionBrowserPlugin(ports) }]);
    await host.jobs.startAfterAdmission(Promise.resolve());
    cleanup.push(() => host.dispose());
    return host;
  };
  const invocation = { threadId: "thread", parentId: "parent", actor: { id: "owner", name: "Owner" },
    defer: vi.fn(async () => {}), reply: vi.fn(async () => {}) } as unknown as SlashInvocation;
  const event = (customId: string, kind: ComponentEvent["kind"] = "button", userId = "owner"): ComponentEvent => ({
    interactionId: "interaction", customId, userId, userName: "Owner", channel: { platform: "discord", id: "thread", parentId: "parent" },
    messageId: "message", kind, deferUpdate: vi.fn(async () => {}), replyEphemeral: vi.fn(async () => {}),
  } as unknown as ComponentEvent);
  const ids = () => (views.at(-1).components ?? []).flatMap((row: any) => row.components.map((button: any) => button.custom_id)) as string[];
  const control = (action: string) => ids().find(id => id.startsWith(`sessions:${action}:`))!;
  return { boot, invocation, event, ports, views, modals, list, attach, imported, migrated, control, reply,
    changeSummarizer: () => { summarizer = "updated-model"; },
    drain: async () => { while (jobs.size) await Promise.all([...jobs]); } };
}

describe("session browser contribution", () => {
  it("passes the selecting actor to the migration facade", async () => {
    const h = fixture(), host = await h.boot();
    await host.slash.dispatch("seam", "info", "sessions", h.invocation);
    await host.components.dispatch(h.event(h.control("migrate")));
    const event = h.event(h.control("migrate_target"), "select");
    event.values = ["target"];
    await host.components.dispatch(event);
    await h.drain();
    expect(h.migrated).toHaveBeenCalledWith("first", { id: "owner", name: "Owner" }, expect.any(Function), expect.any(Function));
    expect(h.views.at(-1).embeds[0].data.title).toContain("Migrated Successfully");
  });

  it("registers once and classifies buttons, selects and modals through the adapter", async () => {
    const h = fixture(), host = await h.boot();
    const assembled = host.slash.assemble([buildSeamCommand().toJSON(), buildSeamAdminCommand().toJSON()]);
    const info = (assembled[0]!.options as any[]).find(group => group.name === "info");
    expect(info.options.filter((leaf: any) => leaf.name === "sessions")).toHaveLength(1);
    for (const kind of ["button", "select", "modal"] as const) {
      expect(classifyDiscordInteraction({ isChatInputCommand: () => false, isButton: () => kind === "button",
        isModalSubmit: () => kind === "modal", isStringSelectMenu: () => kind === "select",
        customId: "sessions:next:card" }, host.components)).toBe("plugin-component");
    }
    expect(browserAccess("sessions:next:card")).toBe("read-only");
    expect(browserAccess("sessions:attach:card")).toBe("mutating");
    expect(browserAccess("sessions:import_cwd_modal:modal:card")).toBe("read-only");
  });

  it("keeps a posted browser, its selection and original scope across restart", async () => {
    const h = fixture(), first = await h.boot();
    await first.slash.dispatch("seam", "info", "sessions", h.invocation);
    await first.components.dispatch(h.event(h.control("next")));
    const attach = h.control("attach");
    await first.dispose();
    const restarted = await h.boot();
    expect(classifyDiscordInteraction({ isChatInputCommand: () => false, isButton: () => true,
      isModalSubmit: () => false, customId: attach }, restarted.components)).toBe("plugin-component");
    await restarted.components.dispatch(h.event(attach));
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.ports.resume).toHaveBeenCalledWith("original-host-and-cwd");
    expect(h.ports.reply).toHaveBeenCalledWith("private-reply", "owner", "thread");
    expect(h.attach).toHaveBeenCalledWith("second");
    expect(h.views.at(-1).components).toEqual([]);
  });

  it("retains owner and browser expiry without making another backend call", async () => {
    vi.useFakeTimers();
    const h = fixture(), host = await h.boot();
    await host.slash.dispatch("seam", "info", "sessions", h.invocation);
    const attach = h.control("attach");
    await host.components.dispatch(h.event(attach, "button", "someone-else"));
    expect(h.attach).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000); await h.drain();
    expect(h.views.at(-1).components).toEqual([]);
    await host.components.dispatch(h.event(attach));
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("retains an admitted import modal's source and model across restart", async () => {
    const h = fixture(), first = await h.boot();
    await first.slash.dispatch("seam", "info", "sessions", h.invocation);
    await first.components.dispatch(h.event(h.control("import_to_cwd")));
    const modal = h.modals.at(-1).custom_id;
    expect(modal.length).toBeLessThanOrEqual(100);
    await first.components.dispatch(h.event(h.control("next")));
    await first.dispose(); h.changeSummarizer();
    const restarted = await h.boot();
    await restarted.components.dispatch({ ...h.event(modal, "modal"), fields: { target_cwd: "/srv/repos/imported" } });
    await h.drain();
    expect(h.imported).toHaveBeenCalledWith("first", "/srv/repos/imported", "admitted-model", expect.any(Function), expect.any(Function));
  });
});
