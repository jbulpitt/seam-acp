import { describe, expect, it, vi } from "vitest";
import {
  agyExecutionPolicyArgs,
  parseAgyModelsList,
  resolveAgyModel,
  selectAgyTurnModel,
  type AgyCatalogEntry,
} from "../packages/adapters/src/profiles/agy.js";

describe("agyExecutionPolicyArgs", () => {
  it("keeps normal chat compatibility with the shared staging directory", () => {
    const args = agyExecutionPolicyArgs("/workspace", {
      sandbox: false,
      exposeGlobalStaging: true,
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--sandbox");
    expect(args).toContain("/workspace");
    expect(args.filter((arg) => arg === "--add-dir")).toHaveLength(2);
  });

  it("confines the vision sidecar to its private sandbox cwd", () => {
    expect(
      agyExecutionPolicyArgs("/private/image", {
        sandbox: true,
        exposeGlobalStaging: false,
      })
    ).toEqual([
      "--sandbox",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/private/image",
    ]);
  });
});

const ACCEPTED_MODELS = [
  "Gemini 3.7 Flash (High)",
  "Gemini 3.7 Flash (Medium)",
  "Gemini 3.7 Flash (Low)",
  "Gemini 3.6 Flash (High)",
  "Gemini 3.6 Flash (Medium)",
  "Gemini 3.6 Flash (Low)",
  "Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (Low)",
  "Gemini 3.1 Pro (High)",
  "Gemini 3.1 Pro (Low)",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
  "GPT-OSS 120B (Medium)",
] as const;

function catalogEntry(
  modelId: string,
  rawDisplayName: string,
  recommended = false
): AgyCatalogEntry {
  return {
    modelId,
    rawDisplayName,
    displayName: rawDisplayName,
    ctx: "1M",
    recommended,
    supportsThinking: false,
    supportsImages: false,
    maxTokens: 1_000_000,
  };
}

describe("parseAgyModelsList", () => {
  // Observed shape, agy 1.1.27 on Linux: a progress line, then one
  // `<modelId>\t<displayName>` row per model, exit 0, no prompt.
  const observed = [
    "Fetching available models...",
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
    "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  ].join("\n");

  it("reads ids and display names and ignores the progress line", () => {
    expect(parseAgyModelsList(observed)).toEqual([
      { modelId: "gemini-3.8-flash-high", rawDisplayName: "Gemini 3.8 Flash (High)" },
      { modelId: "gemini-3.1-pro-high", rawDisplayName: "Gemini 3.1 Pro (High)" },
      { modelId: "claude-opus-4-6-thinking", rawDisplayName: "Claude Opus 4.6 (Thinking)" },
    ]);
  });

  it("tolerates a space separator and skips rows missing either field", () => {
    // The separator is a display detail of a CLI we do not control; losing the
    // whole list to it would be a much worse outcome than accepting both.
    expect(parseAgyModelsList("model-a Model A\nnoseparator\n\n  \n")).toEqual([
      { modelId: "model-a", rawDisplayName: "Model A" },
    ]);
  });

  it("keeps the first row for a duplicated id", () => {
    expect(parseAgyModelsList("a\tFirst\na\tSecond")).toEqual([
      { modelId: "a", rawDisplayName: "First" },
    ]);
  });

  it("returns nothing rather than guessing when the output is prose", () => {
    expect(parseAgyModelsList("CLI error: not signed in")).toEqual([]);
  });
});

describe("resolveAgyModel", () => {
  const first = catalogEntry("first", "Gemini 3.7 Flash (Low)");
  const recommended = catalogEntry(
    "recommended",
    "Gemini 3.7 Flash (High)",
    true
  );
  const configuredDefault = catalogEntry(
    "configured-default",
    "Gemini 3.5 Flash (High)"
  );

  it("auto-heals an unknown session model to the configured raw display name", () => {
    expect(
      resolveAgyModel(
        [first, recommended, configuredDefault],
        "gemini-3.1-flash-lite",
        "Gemini 3.5 Flash (High)"
      )
    ).toBe(configuredDefault);
  });

  it("falls back to a recommended entry, then the first catalog entry", () => {
    expect(
      resolveAgyModel([first, recommended], "missing", "missing default")
    ).toBe(recommended);
    expect(resolveAgyModel([first], "missing", "missing default")).toBe(first);
  });

  it("does not auto-heal when allowAutoHeal is false", () => {
    expect(
      resolveAgyModel(
        [first, recommended, configuredDefault],
        "gemini-3.1-flash-lite",
        "Gemini 3.5 Flash (High)",
        { allowAutoHeal: false }
      )
    ).toBeUndefined();
  });
});

describe("selectAgyTurnModel", () => {
  const flash = catalogEntry("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)", true);
  const opus = catalogEntry("claude-opus-4.6-thinking", "Claude Opus 4.6 (Thinking)");

  it("uses an explicit session model exactly and never heals it", () => {
    expect(
      selectAgyTurnModel({
        catalog: [flash, opus],
        sessionModelId: "gemini-3.8-flash-high",
      })
    ).toEqual({ entry: flash });
  });

  it("rejects an explicit unknown session model instead of substituting another catalog entry", () => {
    expect(
      selectAgyTurnModel({
        catalog: [flash, opus],
        sessionModelId: "gemini-3.1-flash-lite",
      })
    ).toEqual({ error: "unknown AGY model gemini-3.1-flash-lite" });
  });

  it("rejects a missing session model instead of consulting a shared default", () => {
    expect(
      selectAgyTurnModel({
        catalog: [flash, opus],
      })
    ).toEqual({ error: "AGY session has no model selection" });
  });
});
