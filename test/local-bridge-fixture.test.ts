import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { localBridgeWiring } from "./local-bridge-fixture.js";
import { planSeamMcpInjection, spawnRemoteSlot, type RemoteSlotSpawnParams } from "../packages/core/src/core/remote-spawn.js";

describe("local bridge RPC spawn boundary", () => {
  it("launches from the actual spawn RPC and injects a callable MCP endpoint", async () => {
    const launches: RemoteSlotSpawnParams[] = [];
    const wiring = localBridgeWiring(params => {
      launches.push(params);
      return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill: () => true, killed: false,
      }) as never;
    });
    const sessionId = "discord:645-rpc";
    const injection = planSeamMcpInjection({ sessionId, globalMcpServers: [], seamMcp: wiring });
    await spawnRemoteSlot(wiring.muxForSession!(sessionId)!, {
      agentId: "copilot", model: "rpc-selected-model", effort: "high", cwd: process.cwd(),
      mcpServers: injection.mcpServers,
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      agentId: "copilot", model: "rpc-selected-model", effort: "high", cwd: process.cwd(),
      mcpServers: injection.mcpServers,
    });
    const seam = injection.mcpServers[0] as { url: string; headers: Array<{ name: string; value: string }> };
    expect(Number(new URL(seam.url).port)).toBe(wiring.getPort());
    expect(wiring.registry.resolve(seam.headers[0]!.value)).toBe(sessionId);
    const response = await fetch(seam.url, {
      method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(seam.headers.map(h => [h.name, h.value])) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 1, result: { serverInfo: { name: "seam-mcp" } } });
  });

  it("reuses the live session token for an isolated bridge spawn", () => {
    const wiring = localBridgeWiring();
    const first = wiring.registry.mint("discord:645-reuse");
    const injection = planSeamMcpInjection({
      sessionId: "discord:645-reuse", globalMcpServers: [], seamMcp: wiring, reuseToken: true,
    });
    expect((injection.mcpServers[0] as { headers: Array<{ value: string }> }).headers[0]!.value).toBe(first);
  });
});
