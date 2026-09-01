import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGlobalMcpServers } from "../packages/core/src/mcp.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const originalEnabled = process.env.MCP_PLAYWRIGHT_ENABLED;
const originalUrl = process.env.MCP_PLAYWRIGHT_URL;
const originalAaKey = process.env.AA_API_KEY;
const originalAaUrl = process.env.AA_MCP_URL;
const logger = { info() {} } as unknown as Logger;

// buildGlobalMcpServers reads process.env directly, so isolate EVERY var it
// consults — otherwise the host's real .env (which sets AA_API_KEY) leaks the
// artificial-analysis server into the exact-list assertions below.
beforeEach(() => {
  delete process.env.AA_API_KEY;
  delete process.env.AA_MCP_URL;
});

afterEach(() => {
  if (originalEnabled === undefined) delete process.env.MCP_PLAYWRIGHT_ENABLED;
  else process.env.MCP_PLAYWRIGHT_ENABLED = originalEnabled;
  if (originalUrl === undefined) delete process.env.MCP_PLAYWRIGHT_URL;
  else process.env.MCP_PLAYWRIGHT_URL = originalUrl;
  if (originalAaKey === undefined) delete process.env.AA_API_KEY;
  else process.env.AA_API_KEY = originalAaKey;
  if (originalAaUrl === undefined) delete process.env.AA_MCP_URL;
  else process.env.AA_MCP_URL = originalAaUrl;
});

describe("global MCP servers", () => {
  it("does not advertise Playwright when disabled", () => {
    process.env.MCP_PLAYWRIGHT_ENABLED = "false";
    expect(buildGlobalMcpServers(logger, { dataDir: "/unused" }).servers).toEqual([]);
  });

  it("advertises the shared loopback Playwright endpoint", () => {
    process.env.MCP_PLAYWRIGHT_ENABLED = "true";
    delete process.env.MCP_PLAYWRIGHT_URL;
    expect(buildGlobalMcpServers(logger, { dataDir: "/unused" }).servers).toEqual([
      {
        name: "playwright",
        type: "http",
        url: "http://localhost:8766/mcp",
        headers: [],
      },
    ]);
  });

  it("honors an explicit shared endpoint", () => {
    process.env.MCP_PLAYWRIGHT_ENABLED = "1";
    process.env.MCP_PLAYWRIGHT_URL = "http://localhost:9999/mcp";
    expect(buildGlobalMcpServers(logger, { dataDir: "/unused" }).servers[0]).toMatchObject({
      name: "playwright",
      type: "http",
      url: "http://localhost:9999/mcp",
    });
  });

  it("injects the shared artificial-analysis server when AA_API_KEY is set", () => {
    process.env.MCP_PLAYWRIGHT_ENABLED = "false";
    process.env.AA_API_KEY = "test-key";
    expect(buildGlobalMcpServers(logger, { dataDir: "/unused" }).servers).toEqual([
      {
        name: "artificial-analysis",
        type: "http",
        url: "http://127.0.0.1:8767/mcp",
        headers: [],
      },
    ]);
  });
});
