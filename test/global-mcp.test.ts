import { afterEach, describe, expect, it } from "vitest";
import { buildGlobalMcpServers } from "../packages/core/src/mcp.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const originalEnabled = process.env.MCP_PLAYWRIGHT_ENABLED;
const originalUrl = process.env.MCP_PLAYWRIGHT_URL;
const logger = { info() {} } as unknown as Logger;

afterEach(() => {
  if (originalEnabled === undefined) delete process.env.MCP_PLAYWRIGHT_ENABLED;
  else process.env.MCP_PLAYWRIGHT_ENABLED = originalEnabled;
  if (originalUrl === undefined) delete process.env.MCP_PLAYWRIGHT_URL;
  else process.env.MCP_PLAYWRIGHT_URL = originalUrl;
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
});
