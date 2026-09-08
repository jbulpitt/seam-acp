import { describe, expect, it, vi } from "vitest";
import {
  makeAgyProfile,
  makeClaudeProfile,
  makeCodexProfile,
  makeCopilotProfile,
  makeGrokProfile,
} from "@seam/adapters";
import { validateCandidate } from "../packages/core/src/core/model-catalog/service.js";

describe("production adapter catalog sources", () => {
  it("collects Copilot's model-specific effort choices and defaults", async () => {
    const profile = makeCopilotProfile({
      cliPath: "false",
      defaultModel: "auto",
      catalogProbe: async () => ({
        defaultModel: "auto",
        models: [
          {
            modelId: "auto",
            displayName: "Auto",
            effortChoices: [],
            effortDefault: "default",
            priceCategory: null,
          },
          {
            modelId: "gpt-odd",
            displayName: "GPT Odd",
            effortChoices: ["low", "astronomical"],
            effortDefault: "astronomical",
            priceCategory: "premium",
          },
        ],
      }),
    });
    const catalog = await profile.catalog.fetch();
    validateCandidate(catalog);
    expect(catalog.source).toBe("copilot-acp-config-options");
    expect(catalog.models.find((model) => model.id === "gpt-odd")?.effort).toMatchObject({
      selectionDefault: "astronomical",
      choices: [{ id: "low", raw: "low" }, { id: "astronomical", raw: "astronomical" }],
    });
  });

  it("gives direct, alternate, Vertex, and Z.ai Claude profiles distinct semantic scopes", async () => {
    const direct = makeClaudeProfile({
      cliPath: "false",
      directAnthropic: true,
      defaultModel: "claude-opus-5",
      staticModels: [{ modelId: "claude-opus-5", name: "Opus 5" }],
    });
    const alternate = makeClaudeProfile({
      id: "claude-work",
      cliPath: "false",
      directAnthropic: true,
      configDir: "/credentials/work",
      defaultModel: "claude-opus-5",
      staticModels: [{ modelId: "claude-opus-5", name: "Opus 5" }],
    });
    const vertex = makeClaudeProfile({
      id: "claude-vertex",
      brand: "vertex",
      cliPath: "false",
      defaultModel: "claude-opus-5",
      staticModels: [{ modelId: "claude-opus-5", name: "Opus 5" }],
      extraEnv: {
        CLAUDE_CODE_USE_VERTEX: "1",
        ANTHROPIC_VERTEX_PROJECT_ID: "project-7",
        CLOUD_ML_REGION: "us-east5",
      },
    });
    const zai = makeClaudeProfile({
      id: "zai",
      brand: "z-ai",
      cliPath: "false",
      defaultModel: "glm-5.2",
      staticModels: [{ modelId: "glm-5.2", name: "GLM 5.2", contextLimit: 1_000_000 }],
      effort: { mechanism: "none", levels: [] },
      extraEnv: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
    });
    const catalogs = await Promise.all([direct, alternate, vertex, zai].map((profile) => profile.catalog.fetch()));
    catalogs.forEach(validateCandidate);
    expect(new Set(catalogs.map((catalog) => catalog.scope.fingerprint)).size).toBe(4);
    expect(catalogs[0]?.scope.provider).toBe("anthropic");
    expect(catalogs[1]?.scope.credentialProfile).toBe("/credentials/work");
    expect(catalogs[2]?.scope).toMatchObject({ backend: "vertex", project: "project-7", region: "us-east5" });
    expect(catalogs[3]?.scope).toMatchObject({ provider: "z-ai", backend: "https://api.z.ai/api/anthropic" });
  });

  it("covers Codex, parked Ollama Cloud, segmented Agy, and deferred Grok discovery", async () => {
    const codex = makeCodexProfile({
      cliPath: "false",
      defaultModel: "gpt-5",
      staticModels: [{ modelId: "gpt-5", name: "GPT-5", contextLimit: 300_000 }],
    });
    const ollama = makeCodexProfile({
      id: "ollama-cloud",
      cliPath: "false",
      defaultModel: "qwen:cloud",
      staticModels: [{ modelId: "qwen:cloud", name: "Qwen", contextLimit: 200_000 }],
      effort: { mechanism: "configOption", configId: "reasoning_effort", levels: ["low", "high"] },
    });
    const agy = makeAgyProfile({
      cliPath: "false",
      defaultModel: "gemini-high",
      staticModels: [{ modelId: "gemini-high", name: "Gemini High", contextLimit: 1_000_000 }],
    });
    const discover = vi.fn(async () => [
      { modelId: "grok-future", name: "Grok Future", contextLimit: 654_321 },
    ]);
    const grok = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-future",
      staticModels: [{ modelId: "grok-static", name: "Grok Static" }],
      discoverModels: discover,
    });
    expect(discover).not.toHaveBeenCalled();
    const catalogs = await Promise.all([codex, ollama, agy, grok].map((profile) => profile.catalog.fetch()));
    catalogs.forEach(validateCandidate);
    expect(catalogs.map((catalog) => catalog.scope.provider)).toEqual([
      "openai", "ollama-cloud", "google-antigravity", "xai",
    ]);
    expect(discover).toHaveBeenCalledOnce();
    expect(catalogs[2]?.models[0]?.effort.mechanism).toBe("modelBaked");
    expect(catalogs[3]?.models[0]?.id).toBe("grok-future");
  });
});
