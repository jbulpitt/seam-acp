/**
 * #453 — copilot's process cwd, env overlay, and MCP argv are slot data.
 *
 * The bridge used to apply them in a copilot-only launcher. They now arrive
 * as the arguments every adapter spawn already takes. A spawn that ignores
 * the slot still starts a process, so this test reads the process itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@agentclientprotocol/sdk";
import { makeCopilotProfile } from "../packages/adapters/src/profiles/copilot.js";

const seamMcp = (token: string): McpServer => ({
  type: "http",
  name: "seam-mcp",
  url: "http://127.0.0.1:3000/mcp",
  headers: [{ name: "X-Seam-Session", value: token }],
});

describe("copilot spawn applies slot cwd, env, and mcp servers", () => {
  it("starts in the slot repo, overlays GH_TOKEN, and puts seam-MCP on the argv", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-copilot-slot-"));
    const bridgeCwd = path.join(root, "bridge");
    const repoCwd = path.join(root, "repository");
    fs.mkdirSync(bridgeCwd);
    fs.mkdirSync(repoCwd);
    const executable = path.join(root, "copilot");
    const log = path.join(root, "spawn.json");
    fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.COPILOT_SPAWN_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  gh: process.env.GH_TOKEN ?? null,
  marker: process.env.PROFILE_MARKER ?? null,
  slot: process.env.SLOT_MARKER ?? null,
}));
process.stderr.write("slot-stderr\\n");
`, { mode: 0o755 });
    try {
      const profile = makeCopilotProfile({
        cliPath: executable,
        acpArgs: ["--acp", "--remote-mode"],
        cwd: bridgeCwd,
        environment: {
          PATH: process.env.PATH,
          HOME: root,
          GH_TOKEN: "profile-token",
          PROFILE_MARKER: "from-profile",
          COPILOT_SPAWN_LOG: log,
        },
        defaultModel: "gpt-5.4",
      });
      const child = profile.spawn("gpt-5.4", "high", [seamMcp("current-token")], {
        cwd: repoCwd,
        env: { GH_TOKEN: "slot-credential-token", SLOT_MARKER: "from-slot" },
      });
      expect(child.stderr).not.toBeNull();
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("copilot slot spawn did not exit"));
        }, 5000);
        child.once("error", (err) => { clearTimeout(timer); reject(err); });
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      const recorded = JSON.parse(fs.readFileSync(log, "utf8")) as {
        argv: string[];
        cwd: string;
        gh: string | null;
        marker: string | null;
        slot: string | null;
      };
      expect(recorded.cwd).toBe(repoCwd);
      expect(recorded.gh).toBe("slot-credential-token");
      expect(recorded.marker).toBe("from-profile");
      expect(recorded.slot).toBe("from-slot");
      expect(recorded.argv.slice(0, 2)).toEqual(["--acp", "--remote-mode"]);
      expect(recorded.argv).not.toContain("gpt-5.4");
      expect(recorded.argv).not.toContain("high");
      const mcpFlag = recorded.argv.indexOf("--additional-mcp-config");
      expect(mcpFlag).toBeGreaterThan(1);
      const mcp = JSON.parse(recorded.argv[mcpFlag + 1]!) as {
        mcpServers: Record<string, { headers?: Record<string, string> }>;
      };
      expect(mcp.mcpServers["seam-mcp"]?.headers).toEqual({ "X-Seam-Session": "current-token" });
      // Piped stderr is what the bridge drain reads. Inherit would leave it null.
      expect(stderr).toContain("slot-stderr");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the profile cwd and token when the slot supplies neither", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-copilot-slot-"));
    const bridgeCwd = path.join(root, "bridge");
    fs.mkdirSync(bridgeCwd);
    const executable = path.join(root, "copilot");
    const log = path.join(root, "spawn.json");
    fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.COPILOT_SPAWN_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  gh: process.env.GH_TOKEN ?? null,
}));
`, { mode: 0o755 });
    try {
      const profile = makeCopilotProfile({
        cliPath: executable,
        acpArgs: ["--acp"],
        cwd: bridgeCwd,
        environment: {
          PATH: process.env.PATH,
          HOME: root,
          GH_TOKEN: "profile-token",
          COPILOT_SPAWN_LOG: log,
        },
        defaultModel: "gpt-5.4",
      });
      const child = profile.spawn();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("copilot profile spawn did not exit"));
        }, 5000);
        child.once("error", (err) => { clearTimeout(timer); reject(err); });
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      expect(JSON.parse(fs.readFileSync(log, "utf8"))).toEqual({
        argv: ["--acp"],
        cwd: bridgeCwd,
        gh: "profile-token",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
