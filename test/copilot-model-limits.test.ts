import { describe, expect, it } from "vitest";
import { copilotModelContexts } from "../packages/adapters/src/profiles/copilot-model-limits.js";

// Copilot CLI 1.0.91 models.list: capabilities carry the largest tier, billing
// carries each tier's actual input limit. Rebuild must use the selected tier.
const providerModels = { models: [
  { id: "gpt-6.1-sol", capabilities: { limits: {
    max_context_window_tokens: 1_050_000, max_prompt_tokens: 922_000, max_output_tokens: 128_000,
  } }, billing: { tokenPrices: { maxPromptTokens: 272_000, contextMax: 272_000,
    longContext: { maxPromptTokens: 922_000, contextMax: 922_000 } } } },
  { id: "claude-sonnet-5", capabilities: { limits: {
    max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000, max_output_tokens: 64_000,
  } }, billing: { tokenPrices: { maxPromptTokens: 200_000, contextMax: 200_000,
    longContext: { maxPromptTokens: 936_000, contextMax: 936_000 } } } },
] };

describe("Copilot provider context limits", () => {
  it.each([undefined, "default"])("uses the default input tier for launch %s", tier => {
    const contexts = copilotModelContexts(providerModels, tier);
    expect(contexts.get("gpt-6.1-sol")).toEqual({ native: 1_050_000, maximum: 1_050_000, effective: 272_000 });
    expect(contexts.get("claude-sonnet-5")).toEqual({ native: 1_000_000, maximum: 1_000_000, effective: 200_000 });
  });

  it("uses provider-reported long input limits only for a long_context launch", () => {
    const contexts = copilotModelContexts(providerModels, "long_context");
    expect(contexts.get("gpt-6.1-sol")?.effective).toBe(922_000);
    expect(contexts.get("claude-sonnet-5")?.effective).toBe(936_000);
  });

  it("keeps an unknown input limit unknown even when a total window is reported", () => {
    const contexts = copilotModelContexts({ models: [{ id: "unknown",
      capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
    }] });
    expect(contexts.get("unknown")).toEqual({ native: 1_000_000, maximum: 1_000_000, effective: null });
    expect(contexts.has("gpt-6-1-sol")).toBe(false);
  });

  it("accepts the SDK's documented legacy input field without treating it as a total window", () => {
    const contexts = copilotModelContexts({ models: [{ id: "legacy",
      billing: { tokenPrices: { contextMax: 123_456 } },
    }] });
    expect(contexts.get("legacy")).toEqual({ native: null, maximum: null, effective: 123_456 });
  });
});
