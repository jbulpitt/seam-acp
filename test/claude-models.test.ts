import { describe, it, expect } from "vitest";
import {
  getClaudeContextWindow,
  isForwardableFullModelId,
  makeClaudeProfile,
} from "@seam/adapters";

describe("getClaudeContextWindow", () => {
  it("returns 200K when the model is unknown/undefined", () => {
    expect(getClaudeContextWindow()).toBe(200_000);
    expect(getClaudeContextWindow("")).toBe(200_000);
  });

  it("maps `default` (latest Opus on Max) to 1M", () => {
    expect(getClaudeContextWindow("default")).toBe(1_000_000);
    expect(getClaudeContextWindow(" DEFAULT ")).toBe(1_000_000);
  });

  it("resolves exact canonical IDs to their native window", () => {
    expect(getClaudeContextWindow("claude-opus-5")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-opus-4-8")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-opus-4-7")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-opus-4-6")).toBe(200_000);
    expect(getClaudeContextWindow("claude-fable-5")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-sonnet-5")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-sonnet-4-6")).toBe(200_000);
    expect(getClaudeContextWindow("claude-haiku-4-5")).toBe(200_000);
  });

  it("falls back by family for dated / future point-release IDs", () => {
    // The JSONL sometimes records dated IDs not present in the exact table.
    expect(getClaudeContextWindow("claude-opus-4-8-20260115")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-opus-4-6-20250101")).toBe(200_000);
    expect(getClaudeContextWindow("claude-opus-4-10")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-opus-5-20260725")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-opus-5-1")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-opus-6")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-sonnet-4-5")).toBe(200_000);
    expect(getClaudeContextWindow("claude-sonnet-6")).toBe(1_000_000);
  });

  it("lets the model's true window win over a residual legacy [1m] suffix", () => {
    // Retiring [1m] means identity decides the window, not the suffix: a stray
    // [1m] must not force 1M onto a 200K model, nor is it needed for a 1M one.
    expect(getClaudeContextWindow("claude-opus-4-8[1m]")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-sonnet-4-6[1m]")).toBe(200_000);
  });
});

describe("isForwardableFullModelId", () => {
  it("forwards full canonical Claude IDs (so unadvertised models still work)", () => {
    for (const id of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "  Claude-Opus-5  ",
    ]) {
      expect(isForwardableFullModelId(id)).toBe(true);
    }
  });

  it("leaves aliases and empty values on the dynamic config-option path", () => {
    for (const id of ["default", "sonnet", "haiku", "opus", "opus[1m]", "", undefined]) {
      expect(isForwardableFullModelId(id)).toBe(false);
    }
  });
});

describe("makeClaudeProfile staticModels", () => {
  it("stamps each picker entry with its canonical contextLimit", () => {
    const profile = makeClaudeProfile({
      defaultModel: "default",
      staticModels: [
        { modelId: "default", name: "Opus latest", visionMode: "tool" },
        { modelId: "claude-opus-4-6", name: "Opus 4.6" },
        { modelId: "claude-fable-5", name: "Fable 5" },
        { modelId: "claude-sonnet-4-6", name: "Sonnet 4.6" },
      ],
    });
    expect(profile.staticModels).toEqual([
      {
        modelId: "default",
        name: "Opus latest",
        contextLimit: 1_000_000,
        visionMode: "tool",
      },
      { modelId: "claude-opus-4-6", name: "Opus 4.6", contextLimit: 200_000 },
      { modelId: "claude-fable-5", name: "Fable 5", contextLimit: 1_000_000 },
      { modelId: "claude-sonnet-4-6", name: "Sonnet 4.6", contextLimit: 200_000 },
    ]);
    expect(profile.describe().models[0]?.visionMode).toBe("tool");
  });
});
