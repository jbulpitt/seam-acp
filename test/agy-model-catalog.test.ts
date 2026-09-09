import { describe, expect, it, vi } from "vitest";
import {
  agyExecutionPolicyArgs,
  filterAgyCatalogByAcceptedModels,
  parseAgyAcceptedModels,
  resolveAgyModel,
  selectAgyTurnModel,
  type AgyCatalogEntry,
} from "../packages/adapters/src/profiles/agy.js";

describe("agyExecutionPolicyArgs", () => {
  it("keeps normal chat compatibility with the shared staging directory", () => {
    const args = agyExecutionPolicyArgs("/workspace", {
      sandbox: false,
      exposeGlobalStaging: true,
      persistModelSelection: true,
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
        persistModelSelection: false,
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

describe("parseAgyAcceptedModels", () => {
  it("parses the 14 exact display names from agy's validator output", () => {
    const output = [
      "invalid model selection: __seam_probe_invalid__ is not recognized",
      "Available models:",
      ...ACCEPTED_MODELS.map((model) => `  ${model}`),
      "",
    ].join("\n");
    expect(parseAgyAcceptedModels(output)).toEqual(new Set(ACCEPTED_MODELS));
  });

  it("returns an empty set when the marker is absent", () => {
    expect(parseAgyAcceptedModels("invalid model, but no catalog followed")).toEqual(
      new Set()
    );
  });

  it("ignores trailing junk after the accepted-model block", () => {
    const output = [
      "Available models:",
      "  Gemini 3.7 Flash (High)",
      "  Claude Opus 4.6 (Thinking)",
      "",
      "traceback: unrelated trailing diagnostics",
      "  Gemini 2.5 Pro",
    ].join("\n");
    expect(parseAgyAcceptedModels(output)).toEqual(
      new Set(["Gemini 3.7 Flash (High)", "Claude Opus 4.6 (Thinking)"])
    );
  });
});

describe("filterAgyCatalogByAcceptedModels", () => {
  const rows = [
    catalogEntry("gemini-3.7-flash-high", "Gemini 3.7 Flash (High)", true),
    catalogEntry("claude-opus-4.6-thinking", "Claude Opus 4.6 (Thinking)"),
    catalogEntry("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"),
    catalogEntry("gemini-2.5-pro", "Gemini 2.5 Pro"),
    catalogEntry("unknown", "?"),
  ];

  it("intersects polluted LS rows with exact CLI-accepted display names", () => {
    const filtered = filterAgyCatalogByAcceptedModels(
      rows,
      new Set(["Gemini 3.7 Flash (High)", "Claude Opus 4.6 (Thinking)"])
    );
    expect(filtered.map((row) => row.rawDisplayName)).toEqual([
      "Gemini 3.7 Flash (High)",
      "Claude Opus 4.6 (Thinking)",
    ]);
  });

  it("fails open when the accepted-model probe returns empty", () => {
    expect(filterAgyCatalogByAcceptedModels(rows, new Set())).toEqual(rows);
  });

  it("warns and fails open when no accepted name matches the catalog", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filtered = filterAgyCatalogByAcceptedModels(
      rows,
      new Set(["Future Model With An Unexpected Name"])
    );
    expect(filtered).toEqual(rows);
    expect(filtered).not.toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/matched none/));
    warn.mockRestore();
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
        defaultModel: "Claude Opus 4.6 (Thinking)",
      })
    ).toEqual({ entry: flash });
  });

  it("rejects an explicit unknown session model instead of substituting another catalog entry", () => {
    expect(
      selectAgyTurnModel({
        catalog: [flash, opus],
        sessionModelId: "gemini-3.1-flash-lite",
        defaultModel: "Claude Opus 4.6 (Thinking)",
      })
    ).toEqual({ error: "unknown AGY model gemini-3.1-flash-lite" });
  });

  it("still auto-heals the settings.json / default path when no session model is set", () => {
    expect(
      selectAgyTurnModel({
        catalog: [flash, opus],
        settingsModelId: "stale-settings-id",
        defaultModel: "Claude Opus 4.6 (Thinking)",
      })
    ).toEqual({ entry: opus, healedFrom: "stale-settings-id" });
  });
});
