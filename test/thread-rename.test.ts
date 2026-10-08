import { describe, expect, it, vi } from "vitest";
import { validateSlashSpec } from "../packages/core/src/platforms/discord/synthetic-interaction.js";
import type { IdentityEvent } from "../packages/core/src/plugins/identity-registry.js";
import { NAMING_PARENT, namingCommands, namingFixture } from "./plugin-naming-fixture.js";

describe("thread naming contributions", () => {
  it("registers the existing admin leaves and option contract", () => {
    const naming = namingCommands().find(command => command.name === "seamadmin")?.options?.find(option => option.name === "naming") as any;
    expect(naming.options.map((leaf: any) => leaf.name)).toEqual(["rename", "namer"]);
    expect(naming.options[0].options.map((option: any) => option.name)).toEqual(["scope", "migrate-legacy", "role-name"]);
    expect(naming.options[0].description).toBe("Refresh/migrate names");
    expect(validateSlashSpec({ kind: "slash", channel: NAMING_PARENT, command: "seamadmin", subcommandGroup: "naming", subcommand: "namer" }, namingCommands())).toEqual(new Map());
  });

  it("committed creation and role/model changes preserve the human base", async () => {
    const h = await namingFixture();
    try {
      const record = await h.create();
      expect(h.names.get("thread")).toBe("🧬🌞🛠️1️⃣ my task");
      h.renameThread.mockClear();
      h.store.upsert({ ...record, configJson: JSON.stringify({ role: "analyst", model: "gpt-6-luna" }) });
      await h.orchestrator.flushIdentityEffects();
      expect(h.names.get("thread")).toBe("🧬🌑🔬1️⃣ my task");
      expect(h.renameThread).toHaveBeenCalledOnce();
      expect(h.store.get(record.id)?.namePrefix).toBe("🧬🌑🔬1️⃣");
    } finally { await h.close(); }
  });

  it("awaits the rename effect and acknowledges only once", async () => {
    const h = await namingFixture({ admins: new Set(["admin"]) });
    try {
      await h.create();
      h.events.length = 0;
      const result = await h.slash("rename", { "role-name": true });
      expect(h.events).toEqual(["defer", "rename", "edit"]);
      expect(result.reply).not.toHaveBeenCalled();
      expect(result.editReply).toHaveBeenCalledWith({ content: "Rebuilt as 🧬🌞🛠️1️⃣ worker." });
    } finally { await h.close(); }
  });

  it("a blocked rename does not hold another thread's identity effect", async () => {
    const h = await namingFixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    h.renameThread.mockImplementationOnce(async () => { entered(); await gate; });
    h.names.set("blocked", "my task");
    h.router.ensureSessionRecord({ platform: "discord", channelRef: "blocked", parentRef: NAMING_PARENT, cwd: h.directory });
    const first = h.orchestrator.flushIdentityEffects("discord:blocked");
    await blocked;
    try {
      await h.create("other");
      expect(h.names.get("other")).toContain("my task");
      expect(h.names.get("other")).not.toBe("my task");
    } finally { release(); await first; await h.close(); }
  });

  it("publishes one final identity after coalesced writes and none after a rollback", async () => {
    const h = await namingFixture();
    const facts: IdentityEvent[] = [];
    h.host.identity.register("observer", [{ event: "thread-created", handle: async fact => { facts.push(fact); } }, { event: "identity-changed", handle: async fact => { facts.push(fact); } }], { logger: {} as never, config: undefined });
    try {
      const original = await h.create();
      h.store.upsert({ ...original, configJson: JSON.stringify({ role: "analyst" }) });
      h.store.upsert({ ...original, configJson: JSON.stringify({ role: "analyst", model: "gpt-6-luna" }) });
      await h.orchestrator.flushIdentityEffects();
      expect(facts.map(fact => fact.type)).toEqual(["thread-created", "identity-changed"]);
      const changed = facts[1]!;
      expect(changed.type === "identity-changed" && changed.before.role).toBe("worker");
      expect(changed.thread.identity).toMatchObject({ agent: "codex", model: "gpt-6-luna", role: "analyst" });
      expect(Object.isFrozen(changed.thread.identity)).toBe(true);
      const snapshot = h.store.get(original.id)!;
      h.store.upsert({ ...snapshot, configJson: JSON.stringify({ role: "worker" }) });
      await Promise.resolve();
      h.store.upsert(snapshot);
      await h.orchestrator.flushIdentityEffects();
      expect(facts).toHaveLength(2);
    } finally { await h.close(); }
  });

  it("keeps the exact prefix when a later session write carries an older snapshot", async () => {
    const h = await namingFixture();
    try {
      const original = await h.create();
      const next = { ...original, configJson: JSON.stringify({ role: "analyst" }) };
      h.store.upsert(next);
      await h.orchestrator.flushIdentityEffects();
      h.store.upsert({ ...next, acpSessionId: "new-session" }, { source: "fixture", cause: "set provider binding for test" });
      await h.orchestrator.flushIdentityEffects();
      expect(h.store.get(original.id)?.namePrefix).toBe("🧬🌞🔬1️⃣");
      expect(h.names.get("thread")).toBe("🧬🌞🔬1️⃣ my task");
    } finally { await h.close(); }
  });

  it("routes an old rule-editor custom id after the plugin host is recreated", async () => {
    const first = await namingFixture();
    const editor = await first.slash("namer");
    const customId = editor.editReply.mock.calls[0]![0].components[0].toJSON().components[0].custom_id;
    await first.close();
    const next = await namingFixture();
    try {
      const showModal = vi.fn(async () => {});
      const replyEphemeral = vi.fn(async () => {});
      await next.component({ customId, kind: "button", userId: "admin", channel: { id: "thread", parentId: "parent" }, showModal, replyEphemeral });
      expect(showModal).toHaveBeenCalledOnce();
      expect(showModal.mock.calls[0]![0].customId).toContain("seam-namer:save:admin:");
      expect(replyEphemeral).not.toHaveBeenCalled();
      await next.component({ customId, kind: "button", userId: "other", channel: { id: "thread", parentId: "parent" }, showModal, replyEphemeral });
      expect(replyEphemeral).toHaveBeenCalledWith("This editor belongs to another user.");
      await next.component({ customId: "seam-namer:edit:admin:0", kind: "button", userId: "admin", channel: { id: "thread", parentId: "parent" }, showModal, replyEphemeral });
      expect(replyEphemeral).toHaveBeenLastCalledWith(expect.stringContaining("expired"));
    } finally { await next.close(); }
  });

  it("channel recompaction uses creation order and counts deleted threads", async () => {
    const h = await namingFixture();
    try {
      await h.create(); await h.create("second");
      h.names.delete("second");
      h.events.length = 0;
      const result = await h.slash("rename", { scope: "channel", "role-name": true });
      expect(h.events[0]).toBe("defer");
      expect(result.editReply.mock.calls[0]![0].content).toContain("Recomputed 2 channel thread(s)");
      expect(h.names.get("thread")).toBe("🧬🌞🛠️1️⃣ worker");
    } finally { await h.close(); }
  });

  it("a channel preset commit compacts each role group in creation order", async () => {
    const h = await namingFixture();
    try {
      await h.create(); await h.create("second"); await h.create("third");
      h.names.delete("second");
      const reply = vi.fn(async () => {});
      const native = { deferred: false, replied: false, ephemeral: true, deferReply: async () => { native.deferred = true; }, editReply: reply,
        commandName: "seam", channelId: "thread", channel: { isThread: () => true, parentId: NAMING_PARENT }, user: { id: "admin", username: "Admin" },
        options: { getSubcommand: () => "role", getSubcommandGroup: () => "config", getString: (name: string) => name === "value" ? "analyst" : name === "scope" ? "channel" : null }, reply };
      await h.orchestrator.handleSlashInteraction(native as never);
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Role set to `analyst`") }));
      await h.host.identity.drain();
      expect(h.names.get("thread")).toBe("🧬🌞🔬1️⃣ my task");
      expect(h.names.get("third")).toBe("🧬🌞🔬2️⃣ my task");
    } finally { await h.close(); }
  });

  it("allows a read-only plugin leaf through participant and lock gates", async () => {
    const h = await namingFixture({ locked: true, participant: "other" });
    try {
      const existing = h.host.slash.get("seamadmin", "naming", "rename")!;
      await h.host.loadBuiltins([{ id: "read-only", load: async () => ({ id: "read-only", apiVersion: 1, builtin: true, contributions: { slash: [{
        command: "seamadmin", acknowledgement: "ephemeral", group: existing.group, leaf: { type: 1, name: "inspect", description: "Inspect naming" }, access: { kind: "read-only" }, authorization: "user", help: "Inspect naming", handle: async invocation => invocation.reply("read without mutation"),
      }] } }) }]);
      const result = await h.slash("inspect", {}, "other");
      expect(result.editReply).toHaveBeenCalledWith({ content: "read without mutation" });
    } finally { await h.close(); }
  });

  it.each(["thread", "channel"])("refuses non-admin %s work before invoking the plugin", async scope => {
    const h = await namingFixture({ admins: new Set(["admin"]) });
    try {
      await h.create(); h.renameThread.mockClear();
      const result = await h.slash("rename", { scope, "role-name": true }, "other");
      expect(result.editReply).toHaveBeenCalledWith({ content: "This command requires a config admin." });
      expect(result.deferReply).toHaveBeenCalledOnce();
      expect(h.renameThread).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it.each([{ locked: true }, { participant: "other" }])("applies kernel mutation gates before naming", async options => {
    const h = await namingFixture(options);
    try {
      await h.create(); h.renameThread.mockClear();
      const result = await h.slash("rename", { "role-name": true }, "other");
      expect(result.editReply).toHaveBeenCalledOnce();
      expect(result.deferReply).toHaveBeenCalledOnce();
      expect(h.renameThread).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("works without MCP and keeps explicit rename self-scoped", async () => {
    const h = await namingFixture();
    try {
      await h.create(); await h.create("second");
      const result = await h.slash("rename", { "role-name": true });
      expect(result.editReply).toHaveBeenCalledOnce();
      await h.host.mcp.dispatch("rename_thread", { threadId: "thread", args: { name: "new base", thread: "second" } });
      expect(h.names.get("thread")).toBe("🧬🌞🛠️1️⃣ new base");
      expect(h.names.get("second")).toBe("🧬🌞🛠️2️⃣ my task");
    } finally { await h.close(); }
  });
});
