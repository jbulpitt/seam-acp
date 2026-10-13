import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
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

const realPlatform = process.platform;
function forcePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

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
            args: ["/home/operator/Projects/seam-acp/scripts/agy-mcp-server.mjs"],
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
    forcePlatform(realPlatform);
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("maps the existing Darwin Keychains directory by symlink, not by copying it", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-keychains-"));
    realGemini = path.join(root, ".gemini");
    const keychains = path.join(root, "Library", "Keychains");
    fs.mkdirSync(keychains, { recursive: true });
    fs.writeFileSync(path.join(keychains, "login.keychain-db"), "dummy keychain bytes");
    forcePlatform("darwin");

    const home = (await prepareAgyMcpHome("darwin", [seamHttp], realGemini, path.join(root, "homes")))!;
    const mapped = path.join(home, "Library", "Keychains");
    expect(fs.lstatSync(mapped).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(mapped)).toBe(keychains);
    expect(fs.realpathSync(path.join(mapped, "login.keychain-db")))
      .toBe(fs.realpathSync(path.join(keychains, "login.keychain-db")));
    expect(fs.readdirSync(path.join(home, "Library"))).toEqual(["Keychains"]);

    fs.rmSync(home, { recursive: true, force: true });
    expect(fs.readFileSync(path.join(keychains, "login.keychain-db"), "utf8")).toBe("dummy keychain bytes");
  });

  it("keeps Darwin MCP configs isolated while orphan cleanup leaves the shared Keychains tree intact", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-keychains-isolation-"));
    realGemini = path.join(root, ".gemini");
    const stagingRoot = path.join(root, "homes");
    const keychains = path.join(root, "Library", "Keychains");
    fs.mkdirSync(keychains, { recursive: true });
    fs.mkdirSync(path.join(realGemini, "config"), { recursive: true });
    const globalConfig = '{"mcpServers":{"global":{"command":"echo"}}}\n';
    fs.writeFileSync(path.join(realGemini, "config", "mcp_config.json"), globalConfig);
    fs.writeFileSync(path.join(keychains, "login.keychain-db"), "dummy keychain bytes");
    forcePlatform("darwin");
    const other: McpServer = { ...seamHttp, headers: [{ name: "X-Seam-Session", value: "tok-b" }] };
    const [first, second] = await Promise.all([
      prepareAgyMcpHome("a", [seamHttp], realGemini, stagingRoot),
      prepareAgyMcpHome("b", [other], realGemini, stagingRoot),
    ]);
    expect(first).not.toBe(second);
    for (const [home, token] of [[first!, "tok-a"], [second!, "tok-b"]]) {
      expect(fs.readlinkSync(path.join(home, "Library", "Keychains"))).toBe(keychains);
      const config = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8"));
      expect(config.mcpServers["seam-mcp"].headers["X-Seam-Session"]).toBe(token);
      expect(config.mcpServers.global).toBeUndefined();
    }
    // Removing the marker makes only the first fixture an orphan.
    fs.unlinkSync(path.join(first!, ".seam-owner-pid"));
    const swept = await sweepAgyMcpHomes({ root: stagingRoot });
    expect(swept.removedHomes).toBe(1);
    expect(swept.retainedActiveHomes).toBe(1);
    expect(fs.existsSync(first!)).toBe(false);
    expect(fs.realpathSync(path.join(second!, "Library", "Keychains"))).toBe(fs.realpathSync(keychains));
    expect(fs.readFileSync(path.join(keychains, "login.keychain-db"), "utf8")).toBe("dummy keychain bytes");
    expect(fs.readFileSync(path.join(realGemini, "config", "mcp_config.json"), "utf8")).toBe(globalConfig);
  });

  it.each(["absent", "file"])("keeps today's Darwin HOME layout when Keychains is %s", async (kind) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-keychains-missing-"));
    realGemini = path.join(root, ".gemini");
    if (kind === "file") {
      fs.mkdirSync(path.join(root, "Library"));
      fs.writeFileSync(path.join(root, "Library", "Keychains"), "not a directory");
    }
    forcePlatform("darwin");
    const home = (await prepareAgyMcpHome("missing", [], realGemini, path.join(root, "homes")))!;
    expect(fs.existsSync(path.join(home, "Library"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8"))
      .toBe('{\n  "mcpServers": {}\n}\n');
  });

  it("keeps Linux HOME files byte-identical to the pre-mapping layout even when real Keychains exists", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-keychains-linux-"));
    realGemini = path.join(root, ".gemini");
    fs.mkdirSync(path.join(root, "Library", "Keychains"), { recursive: true });
    fs.mkdirSync(path.join(realGemini, "antigravity-cli"), { recursive: true });
    fs.mkdirSync(path.join(realGemini, "config"), { recursive: true });
    const settings = Buffer.from('{"userSettings":{"theme":"dark"}}\n');
    fs.writeFileSync(path.join(realGemini, "config", "config.json"), settings);
    forcePlatform("linux");
    const home = (await prepareAgyMcpHome("linux", [seamHttp], realGemini, path.join(root, "homes")))!;
    expect(fs.readdirSync(home).sort()).toEqual([".gemini", ".seam-owner-pid"]);
    expect(fs.readdirSync(path.join(home, ".gemini")).sort()).toEqual(["antigravity-cli", "config"]);
    expect(fs.readdirSync(path.join(home, ".gemini", "config")).sort()).toEqual(["config.json", "mcp_config.json"]);
    expect(fs.readFileSync(path.join(home, ".seam-owner-pid"))).toEqual(Buffer.from(`${process.pid}\n`));
    expect(fs.readlinkSync(path.join(home, ".gemini", "antigravity-cli"))).toBe(path.join(realGemini, "antigravity-cli"));
    expect(fs.readFileSync(path.join(home, ".gemini", "config", "config.json"))).toEqual(settings);
    const configBytes = `{
  "mcpServers": {
    "seam-mcp": {
      "disabled": false,
      "serverUrl": "http://127.0.0.1:3000/mcp",
      "headers": {
        "X-Seam-Session": "tok-a"
      }
    }
  }
}
`;
    expect(fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"))).toEqual(Buffer.from(configBytes));
    for (const entry of [home, path.join(home, ".gemini"), path.join(home, ".gemini", "config")]) {
      expect(fs.statSync(entry).mode & 0o777).toBe(0o700);
    }
    for (const entry of [".seam-owner-pid", ".gemini/config/mcp_config.json"]) {
      expect(fs.statSync(path.join(home, entry)).mode & 0o777).toBe(0o600);
    }
  });

  it("passes the real Keychains symlink failure through and removes the failed session HOME", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-keychains-error-"));
    realGemini = path.join(root, ".gemini");
    const stagingRoot = path.join(root, "homes");
    const keychains = path.join(root, "Library", "Keychains");
    fs.mkdirSync(keychains, { recursive: true });
    forcePlatform("darwin");
    const cause = Object.assign(new Error(`EACCES: symlink '${keychains}'`), { code: "EACCES" });
    vi.spyOn(fsPromises, "symlink").mockRejectedValue(cause);
    await expect(prepareAgyMcpHome("error", [], realGemini, stagingRoot)).rejects.toBe(cause);
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
    expect(fs.statSync(keychains).isDirectory()).toBe(true);
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

  it("removes current and legacy UUID orphans without following credential links", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-sweep-"));
    const realGemini = path.join(root, "real-gemini");
    const stagingRoot = path.join(root, "staged-homes");
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(realGemini, { recursive: true });
    const credential = path.join(realGemini, "oauth_creds.json");
    fs.writeFileSync(credential, "fixture-credential");

    const orphans = [
      path.join(stagingRoot, "session-orphan"),
      path.join(stagingRoot, "03553f25-27f0-4bac-8f6d-f123918b285d"),
    ];
    for (const orphan of orphans) {
      fs.mkdirSync(path.join(orphan, ".gemini"), { recursive: true, mode: 0o700 });
      fs.symlinkSync(credential, path.join(orphan, ".gemini/oauth_creds.json"));
    }

    const result = await sweepAgyMcpHomes({ root: stagingRoot, maxHomes: 10, maxEntries: 100, maxMs: 1_000 });
    expect(result).toEqual({
      examinedHomes: 2,
      removedHomes: 2,
      retainedActiveHomes: 0,
      failedHomes: 0,
      visitedEntries: expect.any(Number),
      bounded: false,
    });
    expect(orphans.every((orphan) => !fs.existsSync(orphan))).toBe(true);
    expect(fs.readFileSync(credential, "utf8")).toBe("fixture-credential");
  });

  it("retains live-owned current and legacy UUID homes through the owner check", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-sweep-live-"));
    const realGemini = path.join(root, "real-gemini");
    const stagingRoot = path.join(root, "staged-homes");
    fs.mkdirSync(realGemini, { recursive: true });

    const current = await prepareAgyMcpHome("live-current", [seamHttp], realGemini, stagingRoot);
    const generated = await prepareAgyMcpHome("live-legacy", [seamHttp], realGemini, stagingRoot);
    const legacy = path.join(stagingRoot, "8e21ecc2-35d4-4cc5-b4f5-59f6ea882350");
    fs.renameSync(generated!, legacy);

    const result = await sweepAgyMcpHomes({ root: stagingRoot, maxHomes: 10, maxEntries: 100, maxMs: 1_000 });
    expect(result).toEqual({
      examinedHomes: 2,
      removedHomes: 0,
      retainedActiveHomes: 2,
      failedHomes: 0,
      visitedEntries: 2,
      bounded: false,
    });
    expect(fs.existsSync(current!)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
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
    expect(coreSweep).toBeGreaterThan(-1);
    const quotaConstruction = core.indexOf("const quotaProfiles = controllerQuotaProfiles(config, logger);");
    expect(quotaConstruction).toBeGreaterThan(coreSweep);
    const quota = fs.readFileSync(path.resolve("packages/core/src/core/quota/controller-profiles.ts"), "utf8");
    for (const factory of ["makeAgyUnpinnedRuntime({", "makeAgyNativeRuntime({"]) {
      expect(quota.indexOf(factory)).toBeGreaterThan(-1);
    }

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
