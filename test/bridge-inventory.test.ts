import { describe, it, expect } from "vitest";
import {
  loadHostAdapters,
  resolveCopilotHostLaunch,
} from "../packages/bridge/src/inventory.js";

describe("loadHostAdapters", () => {
  it("skips adapters whose CLI is not on PATH (agy must not spawn ENOENT)", () => {
    const adapters = loadHostAdapters("copilot", process.cwd(), (bin) => bin === "copilot");
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
      const adapters = loadHostAdapters(
        command,
        "/remote/workspace",
        (bin) => bin === command,
        async (value) => {
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
        }
      );
      const candidate = await adapters.get("copilot")!.catalog.fetch();
      expect(candidate.models.map((model) => model.id)).toEqual(["remote-model"]);
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
});
