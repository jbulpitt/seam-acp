import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { namingFixture, NAMING_PARENT } from "./plugin-naming-fixture.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import { buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { ThreadReconfiguration } from "../packages/core/src/core/thread-reconfigure.js";
import fs from "node:fs";

const THREAD = "100000000000000002";
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
async function fixture(options: Parameters<typeof namingFixture>[0] = {}) {
  const h = await namingFixture(options); close.push(h.close); await h.create(THREAD);
  Object.assign((h.orchestrator as any).adapter, {
    configParentChannels: async () => [{ id: NAMING_PARENT, name: "Test", guildId: "guild", guildName: "Test" }],
    configurationThread: async ({ id }: { id: string }) => h.names.has(id) ? { name: h.names.get(id), parentId: NAMING_PARENT, guildId: "guild" } : undefined,
  });
  return h;
}
function slash(leaf: string, values: Record<string, string> = {}, user = "admin") {
  const i = { commandName: "seamadmin", channelId: THREAD, channel: { isThread: () => true, parentId: NAMING_PARENT }, user: { id: user, username: user },
    options: { getSubcommand: () => leaf, getSubcommandGroup: () => "threads", getString: (k: string) => values[k] ?? null, getBoolean: () => null },
    deferred: false, replied: false, ephemeral: true, reply: vi.fn(),
    deferReply: vi.fn(async () => { i.deferred = true; }), editReply: vi.fn(async () => { i.replied = true; }) };
  return i;
}
describe("thread reconfiguration contributions through kernel gates", () => {
  it.each([false, true])("reports started/unconfirmed through MCP and components when restored=$0, without replaying Apply", async restored => {
    const h = await fixture({ admins: new Set(["admin"]) });
    fs.writeFileSync(h.config.CHANNEL_PRESETS_FILE!, JSON.stringify({ channels: { [NAMING_PARENT]: { role: { value: "worker" } } } }));
    let release!: () => void; let committed!: () => void;
    const held = new Promise<void>(done => { release = done; });
    const saved = new Promise<void>(done => { committed = done; });
    let committedRows: unknown;
    const original = ThreadReconfiguration.prototype.apply;
    const apply = vi.spyOn(ThreadReconfiguration.prototype, "apply").mockImplementation(async function (...args) {
      const result = await original.apply(this, args);
      committedRows = result;
      committed(); await held; return result;
    });
    const connect = async (reader: typeof h) => {
      const server = new SeamMcpServer({ logger: pino({ level: "silent" }),
        resolveSession: token => token === "valid" ? reader.store.getByChannel("discord", THREAD)! : undefined,
        enqueueDispatch: async () => {}, pluginTools: reader.host.mcp, currentSpeakerId: () => "admin",
        configAdminUserIds: new Set(["admin"]) });
      await server.start(); close.push(() => server.stop());
      return async (name: string, args: object) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST",
          headers: { "content-type": "application/json", "x-seam-session": "valid" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        return response.json() as Promise<any>;
      };
    };
    const call = await connect(h);
    const preview = await call("preview_thread_reconfiguration", { scope: "all", targetModel: "new" });
    const id = preview.result.structuredContent.id;
    const running = call("apply_thread_reconfiguration", { id });
    try {
      await saved;
      expect(h.store.listConfigMutations(), JSON.stringify(committedRows)).toHaveLength(1);
      const reader = restored ? await fixture({ store: h.store, directory: h.directory }) : h;
      const page = slash("page", { id }); await reader.orchestrator.handleSlashInteraction(page as never);
      const view = vi.fn(async () => {}); const refused = vi.fn(async () => {});
      await reader.component({ kind: "button", customId: `seam-thread-reconfigure:next:${id}:-1`, userId: "admin", userName: "Admin",
        channel: { platform: "discord", id: THREAD, parentId: NAMING_PARENT }, messageId: "preview",
        updateEphemeralView: view, replyEphemeral: refused });
      const read = restored ? await connect(reader) : call;
      const mcp = await read("thread_reconfiguration_page", { id });
      expect(JSON.stringify(await read("apply_thread_reconfiguration", { id }))).toContain("has started");
      expect(apply).toHaveBeenCalledTimes(1); expect(h.store.listConfigMutations()).toHaveLength(1);
      for (const rendered of [JSON.stringify(page.editReply.mock.calls), JSON.stringify(view.mock.calls), JSON.stringify(mcp)]) {
        expect(rendered).toContain("Started/unconfirmed");
        expect(rendered).toContain("PLANNED only");
        expect(rendered).toContain("saved UNKNOWN; runtime UNKNOWN");
        expect(rendered).not.toContain("not attempted");
        expect(rendered).not.toContain("not applied");
      }
    } finally { release(); await running; }
  });
  it("mounts without MCP, fits the actual command budget and previews/applies through the real slash handler", async () => {
    const h = await fixture();
    expect(buildSlashRegistrationBody(h.host.slash).find(c => c.name === "seamadmin")!.options!.some(o => o.name === "threads")).toBe(true);
    const preview = slash("preview", { scope: "channel", "scope-id": NAMING_PARENT, "target-model": "gpt-6.1-sol" });
    await h.orchestrator.handleSlashInteraction(preview as never);
    const content = preview.editReply.mock.calls[0][0].embeds[0].description as string;
    expect(content).toContain("unchanged"); expect(h.store.listConfigMutations()).toEqual([]);
    const id = /Preview ([a-f0-9-]+)/.exec(content)![1];
    const apply = slash("apply", { id }); await h.orchestrator.handleSlashInteraction(apply as never);
    expect(apply.editReply.mock.calls[0][0].embeds[0].description).toContain("Result");
  });
  it("preserves participant/admin/lock gates and resolves the same per-target policy", async () => {
    const h = await fixture({ admins: new Set(["admin"]), participant: "other", locked: true });
    const denied = slash("preview", { scope: "all", "target-model": "new" }, "other");
    await h.orchestrator.handleSlashInteraction(denied as never);
    expect(JSON.stringify(denied.editReply.mock.calls)).toContain("config admin");
    const apply = slash("apply", { id: "not-a-plan" }, "other");
    await h.orchestrator.handleSlashInteraction(apply as never);
    expect(JSON.stringify(apply.editReply.mock.calls)).toContain("admin setting");
    expect(Orchestrator.canEditChannelPreset(h.config, "other", NAMING_PARENT)).toBe(false);
    expect(Orchestrator.canEditChannelPreset(h.config, "admin", NAMING_PARENT)).toBe(true);
    expect(h.store.listConfigMutations()).toEqual([]);
  });
  it("skips real admitted dispatch ownership through the installed facade", async () => {
    const h = await fixture();
    h.store.turnAttempts.registerOwner("bulk-test");
    const spec = { id: "assigned", target: THREAD, session: "isolated" as const, prompt: "fixture" };
    h.store.turnAttempts.admit(spec); h.store.turnAttempts.claim(spec, "fixture identity", "bulk-test");
    const preview = slash("preview", { scope: "all", "target-model": "new" });
    await h.orchestrator.handleSlashInteraction(preview as never);
    expect(JSON.stringify(preview.editReply.mock.calls)).toContain("busy/admitted/recovering work");
    expect(h.store.listConfigMutations()).toEqual([]);
  });
  it("skips an isolated renderer tail until its existing FIFO completes", async () => {
    const h = await fixture();
    let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    const queued = (h.orchestrator as any).queueOnChannel(THREAD, () => held);
    try {
      const tail = slash("preview", { scope: "all", "target-model": "new" });
      await h.orchestrator.handleSlashInteraction(tail as never);
      expect(JSON.stringify(tail.editReply.mock.calls)).toContain("busy/admitted/recovering work");
      expect(h.store.listConfigMutations()).toEqual([]);
    } finally { release(); await queued; }
    const idle = slash("preview", { scope: "all", "target-model": "new" });
    await h.orchestrator.handleSlashInteraction(idle as never);
    expect(JSON.stringify(idle.editReply.mock.calls)).toContain("1 eligible");
  });
  it("keeps a durable bridge-owned retry untouched without claiming its physical liveness", async () => {
    const h = await fixture(); const owner = "bridge-fixture";
    h.store.turnAttempts.registerOwner(owner);
    const spec = { id: "remote", target: THREAD, session: "isolated" as const, prompt: "fixture" };
    h.store.turnAttempts.admit(spec); const attempt = h.store.turnAttempts.claim(spec, "fixture identity", owner);
    h.store.turnAttempts.bind(attempt, "fixture-acp"); h.store.turnAttempts.startPrompt(attempt);
    h.store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "fixture-host", slot: 1,
      submissionId: "fixture-submission", acpSessionId: "fixture-acp", delegatedUtc: new Date().toISOString() });
    h.store.turnAttempts.suspendBoot(owner);
    const before = h.store.turnAttempts.get(spec.id);
    const preview = slash("preview", { scope: "all", "target-model": "new" });
    await h.orchestrator.handleSlashInteraction(preview as never);
    expect(JSON.stringify(preview.editReply.mock.calls)).toContain("busy/admitted/recovering work");
    expect(h.store.turnAttempts.get(spec.id)).toEqual(before); expect(h.store.listConfigMutations()).toEqual([]);
  });
  it("restores persistent preview pages and owner-bound Apply after plugin restart", async () => {
    const h = await fixture();
    const preview = slash("preview", { scope: "all", "target-model": "gpt-6.1-sol" });
    await h.orchestrator.handleSlashInteraction(preview as never);
    const id = /Preview ([a-f0-9-]+)/.exec(preview.editReply.mock.calls[0][0].embeds[0].description)![1];
    const tool = h.host.mcp.get("apply_thread_reconfiguration", { threadId: THREAD })!;
    await expect(tool.handle({ threadId: THREAD, actor: { id: "other", name: "Other" }, args: { id } }, {} as never)).rejects.toThrow("another caller");
    const restarted = await fixture({ store: h.store, directory: h.directory });
    const view = vi.fn(async () => {}); const refused = vi.fn(async () => {});
    const event = { kind: "button", customId: `seam-thread-reconfigure:apply:${id}:0`, userId: "other", userName: "Other",
      channel: { platform: "discord", id: THREAD, parentId: NAMING_PARENT }, messageId: "preview",
      updateEphemeralView: view, replyEphemeral: refused };
    await restarted.component(event);
    expect(JSON.stringify(refused.mock.calls)).toContain("another caller"); expect(view).not.toHaveBeenCalled();
    await restarted.component({ ...event, userId: "admin", userName: "Admin" });
    expect(JSON.stringify(view.mock.calls)).toContain("Result");

  });
  it("authenticates MCP, supplies the actual speaker (not args), and leaves configure_thread scope intact", async () => {
    const h = await fixture({ admins: new Set(["admin"]) }); let speaker = "admin";
    const server = new SeamMcpServer({ logger: pino({ level: "silent" }), resolveSession: token => token === "valid" ? h.store.getByChannel("discord", THREAD)! : undefined,
      enqueueDispatch: async () => {}, pluginTools: h.host.mcp, currentSpeakerId: () => speaker,
      configAdminUserIds: new Set(["admin"]), configParticipantUserIds: new Set(["other"]),
      resolveThread: id => h.store.getByChannel("discord", id), configureThread: vi.fn() });
    await server.start(); close.push(() => server.stop());
    const call = async (name: string, args: object, token = "valid") => {
      const r = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-seam-session": token },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }); return r.json() as Promise<any>;
    };
    expect((await call("preview_thread_reconfiguration", { scope: "all", targetModel: "gpt-6.1-sol" }, "bad")).error.message).toContain("unauthorized");
    const preview = await call("preview_thread_reconfiguration", { scope: "all", targetModel: "gpt-6.1-sol", actor: { id: "other" } });
    expect(preview.result.structuredContent.id).toBeTruthy();
    speaker = "other";
    expect(JSON.stringify(await call("apply_thread_reconfiguration", { id: preview.result.structuredContent.id, actor: { id: "admin" } }))).toContain("admin setting");
    speaker = "admin";
    expect(JSON.stringify(await call("apply_thread_reconfiguration", { id: preview.result.structuredContent.id }))).toContain("Result");
    expect(JSON.stringify(await call("configure_thread", { thread: "outside", model: "new" }))).toContain("not a session in your channel");
  });
});
