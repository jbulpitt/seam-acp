import { describe, expect, it } from "vitest";
import { lookupClaudeNativeContextWindow } from "@seam/adapters";
import {
  GROK_STATIC_MODELS,
  OLLAMA_CLOUD_STATIC_MODELS,
  ZAI_STATIC_MODELS,
} from "../packages/core/src/config.js";
import {
  enrichModelListWithKnownLimits,
  resolveContextWindow,
  reconstructionBudgetTokens,
} from "../packages/core/src/core/reconstruction/index.js";

describe("enrichModelListWithKnownLimits", () => {
  it("copies exact-id curated limits onto a production-style GROK_MODELS override", () => {
    const override = [
      { modelId: "grok-4.6", name: "Grok 4.6 (500k)" },
      { modelId: "grok-4.5", name: "Grok 4.5 (500k)" },
    ];
    const enriched = enrichModelListWithKnownLimits(override, GROK_STATIC_MODELS);
    expect(enriched).toEqual([
      { modelId: "grok-4.6", name: "Grok 4.6 (500k)", contextLimit: 500_000 },
      { modelId: "grok-4.5", name: "Grok 4.5 (500k)", contextLimit: 500_000 },
    ]);
  });

  it("does not invent a limit from the cosmetic label of an unknown id", () => {
    const override = [{ modelId: "mystery-999", name: "Mystery (999k)" }];
    expect(enrichModelListWithKnownLimits(override, GROK_STATIC_MODELS)).toEqual(override);
  });
});

describe("lookupClaudeNativeContextWindow", () => {
  it("does not apply the generic 200K fallback", () => {
    expect(lookupClaudeNativeContextWindow("claude-haiku-4-5")).toBeUndefined();
    expect(lookupClaudeNativeContextWindow("not-a-model")).toBeUndefined();
  });

  it("resolves default and dotted canonical aliases", () => {
    expect(lookupClaudeNativeContextWindow("default")).toBe(1_000_000);
    expect(lookupClaudeNativeContextWindow("claude-opus-4.8")).toBe(1_000_000);
    expect(lookupClaudeNativeContextWindow("claude-opus-4-8")).toBe(1_000_000);
  });
});

describe("resolveContextWindow matrix", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof resolveContextWindow>[0];
    window: number;
    source: string;
  }> = [
    {
      name: "Grok grok-4.6 with production-style override (no static limit) on first use",
      input: {
        agentId: "grok",
        model: "grok-4.6",
        staticModels: [{ modelId: "grok-4.6", name: "Grok 4.6 (500k)" }],
      },
      window: 500_000,
      source: "curated-catalog",
    },
    {
      name: "Grok grok-4.5",
      input: { agentId: "grok", model: "grok-4.5" },
      window: 500_000,
      source: "curated-catalog",
    },
    {
      name: "Claude canonical dotted alias",
      input: { agentId: "claude", model: "claude-opus-4.8" },
      window: 1_000_000,
      source: "curated-catalog",
    },
    {
      name: "Claude default alias",
      input: { agentId: "claude", model: "default", defaultModel: "claude-opus-4.8" },
      window: 1_000_000,
      source: "curated-catalog",
    },
    {
      name: "Copilot exact cached metadata when no live usage or static list",
      input: {
        agentId: "copilot",
        model: "gpt-5.5",
        staticModels: [{ modelId: "gpt-5.5", name: "GPT-5.5" }],
        metadataWindow: 400_000,
      },
      window: 400_000,
      source: "model-metadata",
    },
    {
      name: "Codex advertised/cached metadata with no static list",
      input: {
        agentId: "codex",
        model: "gpt-5.4",
        metadataWindow: 272_000,
      },
      window: 272_000,
      source: "model-metadata",
    },
    {
      name: "AGY listPickerModels contextLimit without a live usage row",
      input: {
        agentId: "agy",
        model: "gemini-3.8-flash-high",
        pickerModels: [{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High", contextLimit: 1_048_576 }],
      },
      window: 1_048_576,
      source: "picker-catalog",
    },
    {
      name: "Z.ai retains curated limit under a custom label override",
      input: {
        agentId: "zai",
        model: "glm-5.2",
        staticModels: [{ modelId: "glm-5.2", name: "GLM 5.2 (custom)" }],
        curatedLimits: ZAI_STATIC_MODELS,
      },
      window: 1_000_000,
      source: "curated-catalog",
    },
    {
      name: "Ollama Cloud retains curated limit under a custom label override",
      input: {
        agentId: "ollama-cloud",
        model: "glm-5.3:cloud",
        staticModels: [{ modelId: "glm-5.3:cloud", name: "GLM 5.3 hosted" }],
        curatedLimits: OLLAMA_CLOUD_STATIC_MODELS,
      },
      window: 1_000_000,
      source: "curated-catalog",
    },
    {
      name: "Remote profile uses the host adapter descriptor",
      input: {
        agentId: "grok@office",
        model: "grok-4.6",
        adapterModels: [{ modelId: "grok-4.6", name: "Grok 4.6", contextLimit: 500_000 }],
      },
      window: 500_000,
      source: "adapter-descriptor",
    },
    {
      name: "Matching live usage wins over static",
      input: {
        agentId: "claude",
        model: "claude-opus-4.8",
        lastContextUsage: { model: "claude-opus-4.8", size: 800_000 },
        staticModels: [{ modelId: "claude-opus-4.8", name: "Opus", contextLimit: 1_000_000 }],
      },
      window: 800_000,
      source: "live-usage",
    },
  ];

  it.each(cases)("$name", ({ input, window, source }) => {
    const resolved = resolveContextWindow(input);
    expect(resolved.window).toBe(window);
    expect(resolved.budgetTokens).toBe(reconstructionBudgetTokens(window));
    expect(resolved.budgetTokens).toBe(Math.floor(window * 0.6));
    expect(resolved.source).toBe(source);
    expect(resolved.agentId).toBe(input.agentId);
    expect(resolved.model).toBe(input.model);
  });

  it("ignores live usage from a different model", () => {
    const resolved = resolveContextWindow({
      agentId: "grok",
      model: "grok-4.6",
      lastContextUsage: { model: "grok-4.5", size: 111_111 },
    });
    expect(resolved.window).toBe(500_000);
    expect(resolved.source).toBe("curated-catalog");
  });

  it("fails closed for an unknown exact model and names the sources checked", () => {
    expect(() =>
      resolveContextWindow({
        agentId: "copilot",
        model: "mystery-999",
        staticModels: [{ modelId: "gpt-5.5", name: "GPT-5.5", contextLimit: 400_000 }],
        adapterModels: [{ modelId: "gpt-5.5", name: "GPT-5.5", contextLimit: 400_000 }],
        metadataWindow: null,
      })
    ).toThrow(/agent `copilot` model `mystery-999`[\s\S]*Checked: live-usage, static-profile, adapter-descriptor, picker-catalog, curated-catalog, model-metadata/);
  });

  it("does not parse a (500k) label as a window", () => {
    expect(() =>
      resolveContextWindow({
        agentId: "grok",
        model: "not-grok",
        staticModels: [{ modelId: "not-grok", name: "Grok 4.6 (500k)" }],
      })
    ).toThrow(/model `not-grok`/);
  });

  it("does not substitute a generic 200K Claude fallback for an unknown Claude id", () => {
    expect(() =>
      resolveContextWindow({
        agentId: "claude",
        model: "claude-haiku-4-5",
      })
    ).toThrow(/model `claude-haiku-4-5`/);
  });
});
