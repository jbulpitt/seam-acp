import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  inventoryFromAdapters,
  loadHostAdapters,
  resolveCopilotHostLaunch,
} from "../packages/bridge/src/inventory.js";
import { agyAcpReleaseArtifact } from "@seam/adapters";
import { createManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";

describe("loadHostAdapters", () => {
  it("skips adapters whose CLI is not on PATH (agy must not spawn ENOENT)", () => {
    const adapters = loadHostAdapters("copilot", { exists: (bin) => bin === "copilot" });
    expect([...adapters.keys()]).toEqual(["copilot"]);
    expect(adapters.has("agy")).toBe(false);
  });

  it("binds remote catalog fetches to the configured Copilot launch tuple", async () => {
    const priorArgs = process.env.COPILOT_ARGS;
    const priorToken = process.env.GH_TOKEN;
    process.env.COPILOT_ARGS = "--acp --remote-mode";
    process.env.GH_TOKEN = "remote-credential-token";
    let launch: {
      cliPath: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    } | undefined;
    try {
      const command = "/configured/bin/copilot --tenant enterprise";
      const adapters = loadHostAdapters(command, {
        cwd: "/remote/workspace",
        exists: (bin) => bin === command,
        copilotCatalogProbe: async (value) => {
          launch = value;
          return {
            defaultModel: "remote-model",
            models: [{
              modelId: "remote-model",
              displayName: "Remote Model",
              effortChoices: ["low", "high"],
              effortDefault: "high",
              priceCategory: "premium",
            }],
          };
        },
      });
      const candidate = await adapters.get("copilot")!.catalog.fetch();
      expect(candidate.models.map((model) => model.id)).toEqual(["remote-model"]);
      expect(candidate.scope.credentialProfile).toMatch(/^github-token-sha256:[a-f0-9]{64}$/);
      expect(candidate.scope.credentialProfile).not.toContain("remote-credential-token");
      const runtimeLaunch = resolveCopilotHostLaunch(command, "/remote/workspace");
      expect(launch).toEqual(runtimeLaunch);
      expect(runtimeLaunch).toMatchObject({
          cliPath: "/configured/bin/copilot",
          args: ["--tenant", "enterprise", "--acp", "--remote-mode"],
          cwd: "/remote/workspace",
        });
      expect(runtimeLaunch.env.GH_TOKEN).toBe("remote-credential-token");

      const slotLaunch = resolveCopilotHostLaunch(command, "/remote/repository", {
        GH_TOKEN: "slot-credential-token",
      });
      expect(slotLaunch.cliPath).toBe(runtimeLaunch.cliPath);
      expect(slotLaunch.args).toEqual(runtimeLaunch.args);
      expect(slotLaunch.cwd).toBe("/remote/repository");
      expect(slotLaunch.env.GH_TOKEN).toBe("slot-credential-token");
    } finally {
      if (priorArgs === undefined) delete process.env.COPILOT_ARGS;
      else process.env.COPILOT_ARGS = priorArgs;
      if (priorToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = priorToken;
    }
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

  it("advertises the package runtime under agy-package only when explicitly acknowledged", () => {
    const managed = createManagedAgyFixture({ version: "1.1.28" });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGY_ENABLED: "false",
      AGY_PACKAGE_ENABLED: "true",
      AGY_ACP_BIN: "/opt/agy/antigravity-acp",
      AGY_BIN: "/opt/agy/agy",
      AGY_VERSION: "1.1.28",
      AGY_SHA256: "a".repeat(64),
      AGY_RUNTIME_ROOT: "/opt/agy/runtime",
      AGY_DEFAULT_MODEL: "gemini-high",
      AGY_ACP_VERSION: "1.1.0",
      AGY_ACP_SHA256: agyAcpReleaseArtifact().sha256,
      AGY_CONVERSATIONS_DIR: "/srv/agy/conversations",
      AGY_ACP_CWD: "/srv/workspaces",
      AGY_CREDENTIAL_SCOPE: "antigravity-oauth:test",
      AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED: "true",
      AGY_OLD_ROLLBACK_ENABLED: "false",
    };
    const adapters = loadHostAdapters("copilot", { env, exists: () => true });
    expect(adapters.has("agy-package")).toBe(true);
    expect(adapters.has("agy")).toBe(false);
    expect(adapters.has("agy-old")).toBe(false);
    const row = inventoryFromAdapters(adapters, "copilot", env)
      .find((item) => item.agentId === "agy-package");
    expect(row?.runtime).toMatchObject({
      executable: "/opt/agy/antigravity-acp",
      cwd: "/srv/workspaces",
      environment: {
        AGY_BIN: "/opt/agy/agy",
        AGY_SKIP_DOWNLOAD: "1",
        AGY_CONVERSATIONS_DIR: "/srv/agy/conversations",
      },
      credentialScope: "antigravity-oauth:test",
    });

    const both = loadHostAdapters("copilot", {
      env: {
        ...env,
        AGY_ENABLED: "true",
        AGY_CLI_PATH: managed.executable,
        AGY_VERSION: "1.1.28",
        AGY_SHA256: managed.sha256,
        AGY_RUNTIME_ROOT: managed.runtimeRoot,
      },
      exists: () => true,
    });
    expect(both.get("agy")?.id).toBe("agy");
    expect(both.get("agy-package")?.id).toBe("agy-package");
    expect(both.has("agy-old")).toBe(false);

    const neither = loadHostAdapters("copilot", {
      env: { ...env, AGY_PACKAGE_ENABLED: "false" }, exists: () => true,
    });
    expect(neither.has("agy")).toBe(false);
    expect(neither.has("agy-package")).toBe(false);
    managed.cleanup();
  });

  it("the deprecated rollback flag registers native agy, never agy-old", () => {
    const managed = createManagedAgyFixture({ version: "1.1.28" });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGY_ENABLED: "false",
      AGY_PACKAGE_ENABLED: "false",
      AGY_OLD_ROLLBACK_ENABLED: "true",
      AGY_CLI_PATH: undefined,
      AGY_BIN: undefined,
      AGY_OLD_CLI_PATH: managed.executable,
      AGY_VERSION: "1.1.28",
      AGY_SHA256: managed.sha256,
      AGY_RUNTIME_ROOT: managed.runtimeRoot,
      AGY_DEFAULT_MODEL: "gemini-high",
    };
    const adapters = loadHostAdapters("copilot", { env, exists: () => true });
    expect(adapters.has("agy-old")).toBe(false);
    expect(adapters.has("agy-package")).toBe(false);
    expect(adapters.get("agy")?.id).toBe("agy");
    const missing = loadHostAdapters("copilot", {
      env: { ...env, AGY_CLI_PATH: "agy", AGY_OLD_CLI_PATH: undefined, AGY_BIN: undefined },
      exists: () => true,
    });
    expect(missing.has("agy")).toBe(false);
    managed.cleanup();
  });
});
