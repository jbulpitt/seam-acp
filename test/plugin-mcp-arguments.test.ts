import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { createServiceStatusPlugin } from "../packages/core/src/plugins/service-status/index.js";
import { invalidArgumentError } from "../packages/core/src/lib/invalid-argument.js";

type Log = { level: number; msg: string; plugin?: string; tool?: string; err?: { message: string } };
const hosts: PluginHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const logs: Log[] = [];
  const logger = pino({ level: "info" }, new Writable({
    write(chunk, _encoding, done) { logs.push(JSON.parse(String(chunk))); done(); },
  }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-mcp-args-"));
  dirs.push(root);
  const host = new PluginHost(logger, { storageRoot: root });
  hosts.push(host);
  return { host, logs };
}

async function statusFixture(includeOllama = false) {
  const f = fixture();
  const service = createServiceStatusPlugin({} as never);
  await f.host.loadBuiltins([{ id: "service-status", load: async () => service.plugin }], {
    "service-status": { OLLAMA_CLOUD_ENABLED: includeOllama },
  });
  return { ...f, service };
}
const invocation = { threadId: "thread", args: {} };

async function rejectingFixture(error: Error) {
  const f = fixture();
  await f.host.loadBuiltins([{ id: "broken", load: async () => ({
    id: "broken", builtin: true, apiVersion: 1, contributions: { mcp: [{
      descriptor: { name: "fault", description: "Fault", inputSchema: {} },
      instruction: "", access: "read-only", authorization: "user", available: () => true,
      handle: async () => { throw error; },
    }] },
  }) }]);
  return f;
}

describe("plugin MCP argument help and logging", () => {
  it.each([false, true])("advertises the configured registry in both schemas (ollama=%s)", async includeOllama => {
    const f = await statusFixture(includeOllama);
    const ids = f.service.read().sources.map(source => source.sourceId).sort();
    expect(ids).toContain("anthropic");
    expect(ids.includes("linkworks-ollama")).toBe(includeOllama);
    expect(ids).not.toContain("claude");
    const tools = f.host.mcp.list(invocation);
    expect(tools.map(tool => tool.descriptor.name)).toEqual(["service_status", "service_status_refresh"]);
    for (const tool of tools) {
      const schema = tool.descriptor.inputSchema as { properties: { sourceIds: { items: { enum?: string[] } } } };
      expect(schema.properties.sourceIds.items.enum).toEqual(ids);
      for (const id of ids) expect(tool.descriptor.description).toContain(id);
    }
  });

  it("names the registered ids in the agent instructions, not just provider labels", async () => {
    const f = await statusFixture();
    const instructions = f.host.mcp.list(invocation).map(tool => tool.instruction).join("\n");
    for (const source of f.service.read().sources) expect(instructions).toContain(source.sourceId);
    expect(instructions).not.toContain("GitHub, Claude, OpenAI");
  });

  it("returns the real unknown-id RangeError and logs it at warn, without an alias", async () => {
    const f = await statusFixture();
    const ids = f.service.read().sources.map(source => source.sourceId).sort();
    const error = await f.host.mcp.dispatch("service_status", { ...invocation, args: { sourceIds: ["claude"] } })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RangeError);
    const cause = `unknown service status source id(s): "claude". Registered ids: ${ids.join(", ")}`;
    expect((error as Error).message).toBe(cause);
    const logs = f.logs.filter(log => log.tool === "service_status");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 40, plugin: "service-status", err: { message: cause } });
    expect(f.logs.some(log => log.level >= 50)).toBe(false);
  });

  it.each([
    [{ sourceIds: "anthropic" }, '"sourceIds" must be an array of strings'],
    [{ sourceIds: [""] }, '"sourceIds" must contain only non-empty strings'],
    [{ componentLimit: "many" }, '"componentLimit" must be a finite number'],
    [{ componentLimit: 0 }, "components limit: query limit must be greater than zero, received 0"],
  ])("logs existing argument validation at warn for %j", async (args, cause) => {
    const f = await statusFixture();
    await expect(f.host.mcp.dispatch("service_status", { ...invocation, args })).rejects.toThrow(cause);
    expect(f.logs.filter(log => log.tool === "service_status")).toEqual([
      expect.objectContaining({ level: 40, err: expect.objectContaining({ message: cause }) }),
    ]);
    expect(f.logs.some(log => log.level >= 50)).toBe(false);
  });

  it.each([
    new Error("status database unavailable"),
    new TypeError("cannot read properties of undefined"),
    new RangeError("maximum call stack size exceeded"),
  ])("keeps a real handler fault at error and rethrows the same object: %s", async error => {
    const f = await rejectingFixture(error);
    await expect(f.host.mcp.dispatch("fault", invocation)).rejects.toBe(error);
    expect(f.logs.filter(log => log.tool === "fault")).toEqual([
      expect.objectContaining({ level: 50, msg: "plugin MCP handler failed", err: expect.objectContaining({ message: error.message }) }),
    ]);
  });

  it("logs an explicitly classified argument rejection at warn and rethrows the same object", async () => {
    const original = new RangeError("unknown option");
    expect(invalidArgumentError(original)).toBe(original);
    const f = await rejectingFixture(original);
    await expect(f.host.mcp.dispatch("fault", invocation)).rejects.toBe(original);
    expect(f.logs.filter(log => log.tool === "fault")).toEqual([
      expect.objectContaining({ level: 40, msg: "plugin MCP arguments rejected", err: expect.objectContaining({ message: original.message }) }),
    ]);
  });
});
