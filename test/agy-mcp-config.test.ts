import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  buildAgyMcpConfigJson,
  prepareAgyMcpHome,
  scrubStaleGlobalSeamStdio,
} from "../packages/adapters/src/profiles/agy.js";

const seamHttp: McpServer = {
  type: "http",
  name: "seam-mcp",
  url: "http://127.0.0.1:3000/mcp",
  headers: [{ name: "X-Seam-Session", value: "tok-a" }],
};

describe("buildAgyMcpConfigJson", () => {
  it("maps ACP HTTP servers to agy serverUrl + headers and overwrites stale stdio", () => {
    const json = JSON.parse(
      buildAgyMcpConfigJson([
        seamHttp,
        {
          name: "playwright",
          command: "npx",
          args: ["-y", "@playwright/mcp"],
        } as McpServer,
      ])
    ) as { mcpServers: Record<string, { serverUrl?: string; headers?: Record<string, string>; command?: string }> };
    expect(json.mcpServers["seam-mcp"]).toEqual({
      disabled: false,
      serverUrl: "http://127.0.0.1:3000/mcp",
      headers: { "X-Seam-Session": "tok-a" },
    });
    expect(json.mcpServers.playwright?.command).toBe("npx");
    expect(JSON.stringify(json)).not.toContain("agy-mcp-server.mjs");
  });
});

describe("scrubStaleGlobalSeamStdio", () => {
  let dir: string;
  let cfg: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-scrub-"));
    cfg = path.join(dir, "mcp_config.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes the missing-script stdio seam entry and keeps others", () => {
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        mcpServers: {
          seam: {
            command: "node",
            args: ["/home/ubuntu/Projects/seam-acp/scripts/agy-mcp-server.mjs"],
            env: {},
          },
          other: { command: "echo", args: ["ok"] },
        },
      })
    );
    expect(scrubStaleGlobalSeamStdio(cfg)).toBe(true);
    const out = JSON.parse(fs.readFileSync(cfg, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(out.mcpServers.seam).toBeUndefined();
    expect(out.mcpServers.other).toBeTruthy();
  });
});

describe("prepareAgyMcpHome", () => {
  let realGemini: string;
  afterEach(() => {
    if (realGemini) fs.rmSync(path.dirname(realGemini), { recursive: true, force: true });
  });

  it("writes an isolated mcp_config under a fake HOME and does not touch the real gemini config dir", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-real-gemini-"));
    realGemini = path.join(root, ".gemini");
    fs.mkdirSync(path.join(realGemini, "antigravity-cli"), { recursive: true });
    fs.mkdirSync(path.join(realGemini, "config"), { recursive: true });
    fs.writeFileSync(path.join(realGemini, "config", "config.json"), JSON.stringify({ userSettings: {} }));
    fs.writeFileSync(
      path.join(realGemini, "config", "mcp_config.json"),
      JSON.stringify({ mcpServers: { seam: { command: "node", args: ["agy-mcp-server.mjs"] } } })
    );

    const home = await prepareAgyMcpHome("sess-1", [seamHttp], realGemini);
    expect(home).toBeTruthy();
    const isolated = JSON.parse(
      fs.readFileSync(path.join(home!, ".gemini/config/mcp_config.json"), "utf8")
    ) as { mcpServers: Record<string, { serverUrl?: string }> };
    expect(isolated.mcpServers["seam-mcp"]?.serverUrl).toBe("http://127.0.0.1:3000/mcp");
    expect(isolated.mcpServers.seam).toBeUndefined();

    const stillGlobal = JSON.parse(fs.readFileSync(path.join(realGemini, "config/mcp_config.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(stillGlobal.mcpServers.seam).toBeTruthy();

    const cliLink = fs.lstatSync(path.join(home!, ".gemini/antigravity-cli"));
    expect(cliLink.isSymbolicLink()).toBe(true);
  });
});
