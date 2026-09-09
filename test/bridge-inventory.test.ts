import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { loadHostAdapters } from "../packages/bridge/src/inventory.js";

describe("loadHostAdapters", () => {
  it("skips adapters whose CLI is not on PATH (agy must not spawn ENOENT)", () => {
    const adapters = loadHostAdapters("copilot", { exists: (bin) => bin === "copilot" });
    expect([...adapters.keys()]).toEqual(["copilot"]);
    expect(adapters.has("agy")).toBe(false);
  });

  it("forwards the bridge host's exact Grok executable, default, cwd, and subscription environment", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seam-bridge-grok-"));
    const executable = path.join(temporary, "configured-grok");
    const log = path.join(temporary, "spawn.json");
    fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.GROK_BRIDGE_LOG, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env.GROK_RUNTIME_MARKER,
  hasApiKey: Boolean(process.env.XAI_API_KEY),
}));
`, { mode: 0o755 });
    try {
      const env = {
        PATH: process.env.PATH,
        HOME: temporary,
        GROK_CLI_PATH: executable,
        GROK_DEFAULT_MODEL: "grok-configured-default",
        GROK_CATALOG_MODE: "subscription",
        GROK_RUNTIME_MARKER: "exact-environment",
        GROK_BRIDGE_LOG: log,
        XAI_API_KEY: "ambient-key-must-not-reach-subscription",
      };
      const adapters = loadHostAdapters("missing-copilot", {
        cwd: temporary,
        env,
        exists: (bin) => bin === executable,
      });
      const grok = adapters.get("grok");
      expect(grok?.defaultModel).toBe("grok-configured-default");
      const child = grok!.spawn(undefined, "xhigh");
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
      expect(JSON.parse(fs.readFileSync(log, "utf8"))).toEqual({
        argv: ["agent", "--model", "grok-configured-default", "--reasoning-effort", "xhigh", "stdio"],
        cwd: temporary,
        marker: "exact-environment",
        hasApiKey: false,
      });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
