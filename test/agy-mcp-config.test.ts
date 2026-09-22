import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  buildAgyMcpConfigJson,
  prepareAgyMcpHome,
  scrubStaleGlobalSeamStdio,
  sweepAgyMcpHomes,
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
  let root: string;
  let realGemini: string;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes an isolated mcp_config under a fake HOME and does not touch the real gemini config dir", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-real-gemini-"));
    realGemini = path.join(root, ".gemini");
    const stagingRoot = path.join(root, "staged-homes");
    fs.mkdirSync(path.join(realGemini, "antigravity-cli"), { recursive: true });
    fs.mkdirSync(path.join(realGemini, "config"), { recursive: true });
    fs.writeFileSync(path.join(realGemini, "config", "config.json"), JSON.stringify({ userSettings: {} }));
    fs.writeFileSync(
      path.join(realGemini, "config", "mcp_config.json"),
      JSON.stringify({ mcpServers: { seam: { command: "node", args: ["agy-mcp-server.mjs"] } } })
    );

    const home = await prepareAgyMcpHome("sess-1", [seamHttp], realGemini, stagingRoot);
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

  it("keeps concurrent session MCP configs isolated and cleanup of one cannot remove the other", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-isolation-"));
    realGemini = path.join(root, ".gemini");
    const stagingRoot = path.join(root, "staged-homes");
    fs.mkdirSync(path.join(realGemini, "antigravity-cli"), { recursive: true });
    const other: McpServer = {
      type: "http",
      name: "seam-mcp",
      url: "http://127.0.0.1:3001/mcp",
      headers: [{ name: "X-Seam-Session", value: "tok-b" }],
    };

    const first = await prepareAgyMcpHome("sess-a", [seamHttp], realGemini, stagingRoot);
    const second = await prepareAgyMcpHome("sess-b", [other], realGemini, stagingRoot);
    expect(first).not.toBe(second);

    const readConfig = (home: string) => JSON.parse(
      fs.readFileSync(path.join(home, ".gemini/config/mcp_config.json"), "utf8"),
    ) as { mcpServers: Record<string, { serverUrl?: string; headers?: Record<string, string> }> };
    expect(readConfig(first!).mcpServers["seam-mcp"]).toEqual({
      disabled: false,
      serverUrl: "http://127.0.0.1:3000/mcp",
      headers: { "X-Seam-Session": "tok-a" },
    });
    expect(readConfig(second!).mcpServers["seam-mcp"]).toEqual({
      disabled: false,
      serverUrl: "http://127.0.0.1:3001/mcp",
      headers: { "X-Seam-Session": "tok-b" },
    });

    fs.rmSync(first!, { recursive: true, force: true });
    expect(fs.existsSync(first!)).toBe(false);
    expect(readConfig(second!).mcpServers["seam-mcp"]?.serverUrl).toBe("http://127.0.0.1:3001/mcp");
  });
});

describe("sweepAgyMcpHomes", () => {
  let root: string;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes an orphan without following credential links and retains a live process owner", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-sweep-"));
    const realGemini = path.join(root, "real-gemini");
    const stagingRoot = path.join(root, "staged-homes");
    fs.mkdirSync(realGemini, { recursive: true });
    const credential = path.join(realGemini, "oauth_creds.json");
    fs.writeFileSync(credential, "fixture-credential");

    const live = await prepareAgyMcpHome("live", [seamHttp], realGemini, stagingRoot);
    const orphan = path.join(stagingRoot, "session-orphan");
    fs.mkdirSync(path.join(orphan, ".gemini"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(credential, path.join(orphan, ".gemini/oauth_creds.json"));

    const result = await sweepAgyMcpHomes({ root: stagingRoot, maxHomes: 10, maxEntries: 100, maxMs: 1_000 });
    expect(result).toEqual({
      examinedHomes: 2,
      removedHomes: 1,
      retainedActiveHomes: 1,
      failedHomes: 0,
      visitedEntries: expect.any(Number),
      bounded: false,
    });
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(live!)).toBe(true);
    expect(fs.readFileSync(credential, "utf8")).toBe("fixture-credential");
  });

  it("stops at the configured home ceiling and leaves the remainder for a later boot", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-sweep-bound-"));
    for (const name of ["session-a", "session-b", "session-c"]) {
      const home = path.join(root, name);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(home, "mcp_config.json"), "{}");
    }

    const result = await sweepAgyMcpHomes({ root, maxHomes: 1, maxEntries: 100, maxMs: 1_000 });
    expect(result.examinedHomes).toBe(1);
    expect(result.removedHomes).toBe(1);
    expect(result.bounded).toBe(true);
    expect(fs.readdirSync(root).filter((name) => name.startsWith("session-"))).toHaveLength(2);
  });

  it("stops within a pathological home at the configured tree-entry ceiling", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-sweep-tree-bound-"));
    const home = path.join(root, "session-pathological");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 20; index += 1) {
      fs.writeFileSync(path.join(home, `entry-${index}`), "fixture");
    }

    const result = await sweepAgyMcpHomes({ root, maxHomes: 10, maxEntries: 5, maxMs: 1_000 });
    expect(result.bounded).toBe(true);
    expect(result.visitedEntries).toBe(5);
    expect(fs.existsSync(home)).toBe(true);
  });
});

describe("AGY HOME startup sweep wiring", () => {
  it("awaits recovery before controller and both bridge startup paths can construct adapters", () => {
    const core = fs.readFileSync(path.resolve("packages/core/src/index.ts"), "utf8");
    const coreSweep = core.indexOf("const agyHomeSweep = await sweepAgyMcpHomes();");
    const coreAgyConstruction = core.indexOf("const agyRuntime =");
    expect(coreSweep).toBeGreaterThan(-1);
    expect(coreSweep).toBeLessThan(coreAgyConstruction);

    const bridge = fs.readFileSync(path.resolve("packages/bridge/src/index.ts"), "utf8");
    for (const start of ["async function runClientMode(", "async function runServerMode("]) {
      const body = bridge.slice(bridge.indexOf(start), bridge.indexOf(start) + 1_500);
      expect(body.indexOf("await sweepAgyHomesAtBridgeStartup();")).toBeGreaterThan(-1);
      expect(body.indexOf("await sweepAgyHomesAtBridgeStartup();")).toBeLessThan(
        body.indexOf("loadHostAdapterInventory("),
      );
    }
  });
});
