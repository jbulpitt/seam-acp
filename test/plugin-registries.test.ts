import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { validateSlashCommands, type SlashContribution } from "../packages/core/src/plugins/slash-registry.js";
import type { Plugin } from "../packages/core/src/plugins/types.js";
import { classifyDiscordInteraction } from "../packages/core/src/platforms/discord/adapter.js";
import { AutocompleteRegistry } from "../packages/core/src/platforms/discord/autocomplete.js";
import { buildSeamCommand, buildSeamAdminCommand, buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import { buildSeamHelpPages } from "../packages/core/src/platforms/discord/help-text.js";
import { harnessPreamble } from "../packages/core/src/core/agent-conventions.js";
import { namingRegistry } from "./plugin-naming-fixture.js";
import { installThreadNaming } from "../packages/core/src/core/thread-identity.js";

function fixture() {
  const logs: any[] = [];
  const logger = pino({ level: "info" }, new Writable({ write(chunk, _encoding, done) { logs.push(JSON.parse(String(chunk))); done(); } }));
  const base = [buildSeamCommand().toJSON(), buildSeamAdminCommand().toJSON()];
  return { logger, logs, host: new PluginHost(logger, { slash: base, mcp: ["handoff"] }), base };
}
function leaf(name: string, command: "seam" | "seamadmin" = "seam"): SlashContribution {
  return { command, leaf: { type: 1, name, description: "Test leaf" }, access: { kind: "read-only" }, authorization: "user", help: `/${command} ${name}`, handle: vi.fn(async () => {}) };
}
function plugin(id: string, slash: SlashContribution[]): Plugin {
  return { id, apiVersion: 1, builtin: true, contributions: { slash } };
}

describe("plugin registry registration and dispatch", () => {
  it("isolates a kernel-path collision before activation and registers a later healthy plugin", async () => {
    const h = fixture();
    const activate = vi.fn();
    await h.host.loadBuiltins([
      { id: "collision", load: async () => ({ ...plugin("collision", [leaf("new")]), activate }) },
      { id: "healthy", load: async () => plugin("healthy", [leaf("hello")]) },
    ]);
    expect(activate).not.toHaveBeenCalled();
    expect(h.logs.find(log => log.msg === "plugin disabled").err.message).toContain("duplicate slash path seam/new");
    expect(buildSlashRegistrationBody(h.host.slash)[0]!.options?.some(option => option.name === "hello")).toBe(true);
    await h.host.dispose();
  });

  it("keeps naming capability setup inside the isolated plugin loader", async () => {
    const h = fixture();
    await h.host.loadBuiltins([{ id: "healthy", load: async () => plugin("healthy", [leaf("hello")]) }]);
    const effects = installThreadNaming({ plugins: h.host, logger: h.logger, config: {} as never, adapter: {} as never, router: {} as never,
      store: { countSessions: () => { throw new Error("identity capability unavailable"); } } as never });
    await effects.ready;
    await effects.flush();
    expect(h.logs.find(log => log.msg === "plugin disabled").err.message).toBe("identity capability unavailable");
    expect(h.host.slash.get("seam", null, "hello")).toBeDefined();
    await h.host.dispose();
  });

  it("rejects required option order, slot exhaustion and the real string budget", () => {
    expect(() => validateSlashCommands([{ name: "seam", description: "Test", options: [{ type: 1, name: "wrong", description: "Test", options: [{ type: 3, name: "optional", description: "Test" }, { type: 3, name: "required", description: "Test", required: true }] }] }])).toThrow("required option follows optional");
    expect(() => validateSlashCommands([{ name: "seam", description: "Test", options: Array.from({ length: 26 }, (_, index) => ({ type: 1, name: `leaf-${index}`, description: "Test" })) }])).toThrow("25 slots");
    expect(() => validateSlashCommands([{ name: "seam", description: "Test", options: Array.from({ length: 25 }, (_, index) => ({ type: 1, name: `leaf-${index}`, description: "x".repeat(100), options: [{ type: 3, name: "choice", description: "x".repeat(100), choices: [{ name: "a".repeat(100), value: "b".repeat(100) }] }] })) }])).toThrow("8000 characters");
  });

  it("uses full command paths and retains a throwing handler's cause", async () => {
    const h = fixture();
    const a = leaf("hello"); const b = leaf("hello", "seamadmin");
    b.handle = async () => { throw new Error("rename service unavailable"); };
    await h.host.loadBuiltins([{ id: "paths", load: async () => plugin("paths", [a, b]) }]);
    const invocation = { threadId: "thread", actor: { id: "admin", name: "Admin" }, string: () => null, boolean: () => null, reply: vi.fn(), defer: vi.fn(), edit: vi.fn(), view: vi.fn() };
    expect(await h.host.slash.dispatch("seam", null, "hello", invocation)).toBe(true);
    expect(a.handle).toHaveBeenCalledOnce();
    await expect(h.host.slash.dispatch("seamadmin", null, "hello", invocation)).rejects.toThrow("rename service unavailable");
    expect(h.logs.find(log => log.msg === "plugin slash handler failed").err.message).toBe("rename service unavailable");
    await h.host.dispose();
  });

  it("rejects autocomplete replacement rather than silently changing its responder", () => {
    const registry = new AutocompleteRegistry();
    registry.register("config", "model", "id", "canonical", () => [{ name: "old", value: "old" }]);
    expect(() => registry.register("config", "model", "id", "canonical", () => [])).toThrow("duplicate autocomplete config/model/id");
  });

  it("feeds help from the active contribution list", () => {
    const registry = namingRegistry();
    const pages = buildSeamHelpPages(undefined, registry.help());
    expect(pages.join("\n")).toContain("/seamadmin naming rename");
    expect(buildSeamHelpPages().join("\n")).not.toContain("/seamadmin naming rename");
  });

  it("projects plugin autocomplete by its declared round-trip policy", async () => {
    const h = fixture(); const contribution = leaf("complete");
    contribution.leaf.options = [{ type: 3, name: "model", description: "Model", autocomplete: true }];
    contribution.autocomplete = [{ option: "model", policy: "canonical", respond: () => [{ name: "Friendly label", value: "canonical-id" }, { name: "Too long", value: "x".repeat(101) }] }];
    await h.host.loadBuiltins([{ id: "complete", load: async () => plugin("complete", [contribution]) }]);
    const ctx = { group: null, subcommand: "complete", optionName: "model", focusedValue: "", projectScopeId: "parent" };
    expect(await h.host.slash.autocomplete("seam", ctx)!(ctx)).toEqual([{ name: "canonical-id", value: "canonical-id" }]);
    await h.host.dispose();
  });

  it("isolates a throwing identity handler and preserves event order", async () => {
    const h = fixture(); const seen: string[] = [];
    await h.host.loadBuiltins([{ id: "listener", load: async () => ({ id: "listener", builtin: true, apiVersion: 1, contributions: { identity: [
      { event: "thread-created", handle: async () => { throw new Error("rename permission denied"); } },
      { event: "thread-created", handle: async event => { seen.push(event.thread.id); } },
    ] } }) }]);
    const thread = { id: "one", platform: "discord", parentId: "parent", createdUtc: "2026-01-01", identity: { agent: "codex", model: "gpt-6.1-sol", role: "worker", prefix: null, disableThreadPrefix: false } };
    await Promise.all([h.host.identity.emit({ type: "thread-created", thread, reason: "created" }), h.host.identity.emit({ type: "thread-created", thread: { ...thread, id: "two" }, reason: "created" })]);
    expect(seen).toEqual(["one", "two"]);
    expect(h.logs.filter(log => log.msg === "plugin identity handler failed").map(log => log.err.message)).toEqual(["rename permission denied", "rename permission denied"]);
    await h.host.dispose();
  });

  it("drives persistent classification and dispatch from the same namespace, leaving collectors alone", async () => {
    const h = fixture(); const handle = vi.fn(async () => {});
    await h.host.loadBuiltins([{ id: "cards", load: async () => ({ id: "cards", apiVersion: 1, builtin: true, contributions: { components: [
      { namespace: "durable:", types: ["button", "modal"], lifetime: "persistent", access: "read-only", authorization: "user", handle },
      { namespace: "local:", types: ["select"], lifetime: "collector", access: "read-only", authorization: "user", handle },
    ] } }) }]);
    const interaction = { isChatInputCommand: () => false, isButton: () => true, isModalSubmit: () => false, customId: "durable:record-before-restart" };
    expect(classifyDiscordInteraction(interaction, h.host.components)).toBe("plugin-component");
    expect(await h.host.components.dispatch({ customId: interaction.customId, kind: "button", replyEphemeral: vi.fn() } as never)).toBe(true);
    expect(handle).toHaveBeenCalledOnce();
    expect(classifyDiscordInteraction({ ...interaction, isButton: () => false, isStringSelectMenu: () => true, customId: "local:collector" }, h.host.components)).toBe("none");
    expect(await h.host.components.dispatch({ customId: "local:collector", kind: "select" } as never)).toBe(false);
    await h.host.dispose();
  });

  it("keeps MCP listing, calls and instructions on the same availability predicate", async () => {
    const h = fixture(); const handle = vi.fn(async () => ({ content: [{ type: "text" as const, text: "renamed" }] }));
    const contribution = { descriptor: { name: "rename_thread", description: "Rename", inputSchema: {} }, instruction: "rename_thread(name)", access: "mutating" as const, authorization: "user" as const, available: (caller: { threadId: string }) => caller.threadId === "owned", handle };
    await h.host.loadBuiltins([{ id: "mcp", load: async () => ({ id: "mcp", apiVersion: 1, builtin: true, contributions: { mcp: [contribution] } }) }]);
    expect(h.host.mcp.list({ threadId: "other" })).toEqual([]);
    await expect(h.host.mcp.dispatch("rename_thread", { threadId: "other", args: {} })).rejects.toThrow("unknown tool");
    expect(handle).not.toHaveBeenCalled();
    const tools = h.host.mcp.list({ threadId: "owned" });
    expect(tools.map(tool => tool.descriptor.name)).toEqual(["rename_thread"]);
    expect(harnessPreamble([], undefined, { seamMcp: true, pluginToolInstructions: tools.map(tool => tool.instruction) })).toContain("rename_thread(name)");
    expect(harnessPreamble([], undefined, { seamMcp: false, pluginToolInstructions: tools.map(tool => tool.instruction) })).not.toContain("rename_thread");
    await h.host.mcp.dispatch("rename_thread", { threadId: "owned", args: {} });
    expect(handle).toHaveBeenCalledOnce();
    await h.host.dispose();
  });
});
