/**
 * #622 — copilot catalog refreshes on fhr-server timed out at the 30s RPC
 * default for 7 days (a probe takes 79-101s), and each probe started the
 * user's MCP servers, leaking xvfb-run's Xvfb on hosts with a browser MCP.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCopilotProfile, type CopilotCatalogLaunch } from "../packages/adapters/src/profiles/copilot.js";
import { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import type { Config } from "../packages/core/src/config.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const dirs: string[] = [];
let server: Server | undefined;
let hub: BridgeHub | undefined;

afterEach(async () => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  hub?.close();
  hub = undefined;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function probeArgs(mcpConfig?: unknown): Promise<string[]> {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-probe-"));
  dirs.push(configDir);
  if (mcpConfig) fs.writeFileSync(path.join(configDir, "mcp-config.json"), JSON.stringify(mcpConfig));
  let launch: CopilotCatalogLaunch | undefined;
  const profile = makeCopilotProfile({
    cliPath: process.execPath,
    configDir,
    defaultModel: "gpt-5",
    catalogProbe: async (l) => {
      launch = l;
      return { defaultModel: "gpt-5", models: [{ modelId: "gpt-5", displayName: "GPT-5", priceCategory: null, effortChoices: [], effortDefault: "default" }] } as never;
    },
  });
  await profile.catalog.fetch();
  return launch!.args ?? [];
}

describe("copilot catalog probe launch", () => {
  it("disables built-in and every user MCP server", async () => {
    const args = await probeArgs({ mcpServers: { playwright: {}, github: {} } });
    expect(args).toContain("--disable-builtin-mcps");
    expect(args.join(" ")).toContain("--disable-mcp-server playwright --disable-mcp-server github");
  });

  it("still probes when the user has no MCP config", async () => {
    const args = await probeArgs();
    expect(args).toContain("--disable-builtin-mcps");
    expect(args).not.toContain("--disable-mcp-server");
  });
});

describe("controller catalog fetch", () => {
  it("waits long enough for a copilot probe", async () => {
    const logger = { child: () => logger, warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() } as unknown as Logger;
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    hub = new BridgeHub({
      logger,
      config: { bridgePresets: new Map() } as Config,
      httpServer: server,
      mutation: {} as never,
      healthPort: 3000,
      dataDir: "/tmp",
      localBridgeTokenHash: "a".repeat(64),
    });
    const rpc = vi.fn(async () => ({}));
    (hub as unknown as { connections: Map<string, unknown> }).connections.set("fhr-server", { mux: { rpc } });
    await hub.fetchModelCatalog("fhr-server", "copilot");
    expect(rpc).toHaveBeenCalledWith("fetchModelCatalog", {}, expect.objectContaining({ agentId: "copilot" }));
    const timeoutMs = (rpc.mock.calls[0] as unknown[])[2] as { timeoutMs?: number };
    // Measured probe: 79s without MCP servers, 101s with them.
    expect(timeoutMs.timeoutMs).toBeGreaterThanOrEqual(120_000);
  });
});
