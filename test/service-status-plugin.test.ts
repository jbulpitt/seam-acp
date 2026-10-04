import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { createServiceStatusPlugin } from "../packages/core/src/plugins/service-status/index.js";
import { ServiceStatusStore } from "../packages/core/src/core/service-status/store.js";
import { SERVICE_STATUS_REFRESH_CUSTOM_ID } from "../packages/core/src/core/service-status-card.js";
import * as sources from "../packages/core/src/core/service-status/sources/registry.js";
import type { ServiceStatusAdapterContext, ServiceStatusAdapterResult } from "../packages/core/src/core/service-status/types.js";
import { classifyDiscordInteraction } from "../packages/core/src/platforms/discord/adapter.js";
import { harnessPreamble } from "../packages/core/src/core/agent-conventions.js";

const logger = pino({ level: "silent" });
const dirs: string[] = []; const hosts: PluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const result = (): ServiceStatusAdapterResult => ({ sourceId: "alpha", fetchedAt: new Date().toISOString(), baseline: { status: "operational", description: "All good", derived: false }, components: [], incidents: [], notes: [] });
function fixture(fetchSource: (context: ServiceStatusAdapterContext) => Promise<ServiceStatusAdapterResult> = async () => result()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-plugin-")); dirs.push(root);
  const source = { id: "alpha", label: "Alpha", homepage: "https://alpha.test", provenance: "official" as const, scopeNote: "Fixture", fetch: vi.fn(fetchSource) };
  vi.spyOn(sources, "createDefaultServiceStatusSources").mockReturnValue([source]);
  const file = path.join(root, "service-status.sqlite"); const state = path.join(root, "service-status-card.json");
  const host = new PluginHost(logger, { storageRoot: root, storageAliases: { "service-status": { "service-status.sqlite": file, "service-status-card.json": state } } }); hosts.push(host);
  const transport = { sendLayout: vi.fn(async (channel: { platform: string; id: string }) => ({ channel, id: "card" })), editLayout: vi.fn(async () => {}), pinMessage: vi.fn(async () => {}) };
  const service = createServiceStatusPlugin(transport as never);
  const load = () => host.loadBuiltins([{ id: "service-status", load: async () => service.plugin }], { "service-status": { OLLAMA_CLOUD_ENABLED: false, DISCORD_SERVICE_STATUS_THREAD_ID: "thread" } });
  return { host, service, file, state, root, source, transport, load };
}
const invocation = { threadId: "thread", args: {} };

describe("service-status built-in", () => {
  it("retains the existing database history and pinned message", async () => {
    const f = fixture(); const old = new ServiceStatusStore(f.file);
    old.registerSources([f.source]);
    old.recordSuccess({ source: f.source, result: result(), durationMs: 10, observedAt: new Date() });
    const history = old.listEvents(); old.close();
    fs.writeFileSync(f.state, JSON.stringify({ threadId: "thread", messageId: "existing", lastBumpAt: Date.now() }));
    await f.load();
    expect(f.source.fetch).not.toHaveBeenCalled();
    const read = await f.host.mcp.dispatch("service_status", { ...invocation, args: { includeHistory: true } });
    expect(JSON.parse(read.content[0]!.text).sources[0].history).toHaveLength(history.length);
    expect(JSON.parse(read.content[0]!.text).sources[0].reportedStatus).toBe("operational");
    await f.host.jobs.startAfterAdmission(Promise.resolve());
    expect(f.transport.editLayout).toHaveBeenCalledWith({ channel: { platform: "discord", id: "thread" }, id: "existing" }, expect.anything());
    expect(f.transport.sendLayout).not.toHaveBeenCalled();
    f.host.jobs.stop(); await f.host.jobs.drain();
    const reopened = new ServiceStatusStore(f.file); expect(reopened.listEvents().slice(-history.length)).toEqual(history); reopened.close();
  });

  it("registers Refresh and both MCP tools together, with shared cooldown", async () => {
    const f = fixture(); await f.load();
    expect(f.host.mcp.list(invocation).map(tool => tool.descriptor.name)).toEqual(["service_status", "service_status_refresh"]);
    const instructions = f.host.mcp.list(invocation).map(tool => tool.instruction);
    expect(harnessPreamble([], undefined, { seamMcp: true, pluginToolInstructions: instructions })).toContain("service_status_refresh");
    expect(harnessPreamble([], undefined, { seamMcp: false, pluginToolInstructions: instructions })).not.toContain("service_status_refresh");
    expect(classifyDiscordInteraction({ isChatInputCommand: () => false, isButton: () => true, isModalSubmit: () => false, customId: SERVICE_STATUS_REFRESH_CUSTOM_ID }, f.host.components)).toBe("plugin-component");
    await expect(f.host.mcp.dispatch("service_status_refresh", invocation)).rejects.toThrow("startup or shutdown");
    await f.host.jobs.startAfterAdmission(Promise.resolve()); await f.host.jobs.drain();
    const replies: string[] = [];
    await f.host.components.dispatch({ kind: "button", customId: SERVICE_STATUS_REFRESH_CUSTOM_ID, channel: { platform: "discord", id: "thread" }, replyEphemeral: async (text: string) => { replies.push(text); }, editReplyEphemeral: async (text: string) => { replies.push(text); } } as never);
    expect(replies[0]).toBe("Refreshing upstream service status…"); expect(replies[1]).toMatch(/Service status refreshed/);
    const refreshed = await f.host.mcp.dispatch("service_status_refresh", invocation);
    expect(JSON.parse(refreshed.content[0]!.text).sources[0].disposition).toBe("rate_limited");
    const read = await f.host.mcp.dispatch("service_status", invocation);
    expect(read.structuredContent).toEqual(JSON.parse(read.content[0]!.text));
  });

  it("aborts and drains outstanding HTTP work; no cadence or manual fetch follows quiesce", async () => {
    vi.useFakeTimers(); let signal!: AbortSignal; let finish!: (value: ServiceStatusAdapterResult) => void;
    const f = fixture(async context => { signal = context.signal!; return new Promise(resolve => { finish = resolve; }); });
    await f.load(); await f.host.jobs.startAfterAdmission(Promise.resolve());
    expect(f.source.fetch).toHaveBeenCalledOnce();
    f.host.jobs.stop(); expect(signal.aborted).toBe(true);
    let drained = false; const drain = f.host.jobs.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    await expect(f.host.mcp.dispatch("service_status_refresh", invocation)).rejects.toThrow("startup or shutdown");
    finish(result()); await drain;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.source.fetch).toHaveBeenCalledOnce();
    expect(f.service.read().sources[0]!.observation.health).toBe("never_fetched");
  });

  it("isolates an activation failure and preserves another built-in", async () => {
    const f = fixture(); fs.mkdirSync(f.file);
    await f.host.loadBuiltins([{ id: "service-status", load: async () => f.service.plugin }, { id: "healthy", load: async () => ({ id: "healthy", builtin: true, apiVersion: 1, contributions: { fences: [{ tag: "healthy", instruction: "healthy", handle: async () => {} }] } }) }], { "service-status": { OLLAMA_CLOUD_ENABLED: false } });
    expect(f.host.mcp.list(invocation)).toEqual([]); expect(f.host.components.get(SERVICE_STATUS_REFRESH_CUSTOM_ID, "button")).toBeUndefined();
    expect(f.host.fences.instructions).toEqual(["healthy"]);
    await f.host.jobs.startAfterAdmission(Promise.resolve()); expect(f.source.fetch).not.toHaveBeenCalled();
  });
});
