import { describe, it, expect } from "vitest";
import {
  getClaudeContextWindow,
  isForwardableFullModelId,
  lookupClaudeNativeContextWindow,
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
    expect(getClaudeContextWindow("claude-fable-5-1")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-opus-5")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-opus-4-8")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-opus-4-7")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-fable-5")).toBe(1_000_000);
    expect(getClaudeContextWindow("claude-sonnet-5")).toBe(1_000_000);
  });

  it("falls back conservatively for models not admitted to the picker", () => {
    expect(getClaudeContextWindow("claude-opus-4-6")).toBe(200_000);
    expect(getClaudeContextWindow("claude-haiku-4-5")).toBe(200_000);
    expect(getClaudeContextWindow("claude-opus-6")).toBe(200_000);
  });
});

describe("lookupClaudeNativeContextWindow", () => {
  it("returns only verified native windows", () => {
    expect(lookupClaudeNativeContextWindow("default")).toBe(1_000_000);
    expect(lookupClaudeNativeContextWindow("claude-opus-4.8")).toBe(1_000_000);
    expect(lookupClaudeNativeContextWindow("claude-haiku-4-5")).toBeUndefined();
  });
});

describe("isForwardableFullModelId", () => {
  it("forwards full canonical Claude IDs (so unadvertised models still work)", () => {
    for (const id of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-sonnet-5",
      "  Claude-Opus-5  ",
    ]) {
      expect(isForwardableFullModelId(id)).toBe(true);
    }
  });

  it("leaves aliases and empty values on the dynamic config-option path", () => {
    for (const id of ["default", "sonnet", "haiku", "opus", "", undefined]) {
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
        { modelId: "claude-fable-5-1", name: "Fable 5.1" },
        { modelId: "claude-fable-5", name: "Fable 5" },
      ],
    });
    expect(profile.staticModels).toEqual([
      {
        modelId: "default",
        name: "Opus latest",
        contextLimit: 1_000_000,
        visionMode: "tool",
      },
      { modelId: "claude-fable-5-1", name: "Fable 5.1", contextLimit: 1_000_000 },
      { modelId: "claude-fable-5", name: "Fable 5", contextLimit: 1_000_000 },
    ]);
    expect(profile.describe().models[0]?.visionMode).toBe("tool");
  });
});
