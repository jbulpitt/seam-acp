import { describe, it, expect } from "vitest";
import {
  isForwardableFullModelId,
  makeClaudeProfile,
} from "@seam/adapters";

describe("isForwardableFullModelId", () => {
  it("forwards full canonical Claude IDs (so unadvertised models still work)", () => {
    for (const id of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-opus-5-5",
      "claude-3-5-sonnet-20241022",
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

describe("makeClaudeProfile catalog", () => {
  it("does not borrow Haiku 5.5's verified window for an unscoped manifest", async () => {
    const profile = makeClaudeProfile({
      defaultModel: "claude-haiku-5-5",
      staticModels: [{ modelId: "claude-haiku-5-5", name: "Haiku 5.5" }],
    });
    const catalog = await profile.catalog.fetch();
    expect(catalog.models[0]?.context).toEqual({
      native: null,
      maximum: null,
      effective: null,
    });
  });

  it("forwards effort without adding a compaction policy", () => {
    const profile = makeClaudeProfile({
      defaultModel: "default",
    });
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const meta = profile.newSessionMeta?.("claude-haiku-5-5", effort);
      expect(meta).toMatchObject({
        claudeCode: {
          options: {
            effort,
          },
        },
      });
      expect(JSON.stringify(meta)).not.toContain("compactionControl");
    }
  });

  it("keeps only explicitly supplied manifest limits", async () => {
    const profile = makeClaudeProfile({
      defaultModel: "default",
      staticModels: [
        { modelId: "default", name: "Opus latest", visionMode: "tool" },
        { modelId: "claude-fable-5-1", name: "Fable 5.1" },
        { modelId: "claude-fable-5", name: "Fable 5", contextLimit: 128_000 },
      ],
    });
    const catalog = await profile.catalog.fetch();
    expect(catalog.models.map((model) => ({
      modelId: model.id,
      name: model.displayName,
      contextLimit: model.context.effective,
      ...(model.visionMode !== "none" ? { visionMode: model.visionMode } : {}),
    }))).toEqual([
      {
        modelId: "default",
        name: "Opus latest",
        contextLimit: null,
        visionMode: "tool",
      },
      { modelId: "claude-fable-5-1", name: "Fable 5.1", contextLimit: null },
      { modelId: "claude-fable-5", name: "Fable 5", contextLimit: 128_000 },
    ]);
    expect(catalog.models[0]?.visionMode).toBe("tool");
  });
});
