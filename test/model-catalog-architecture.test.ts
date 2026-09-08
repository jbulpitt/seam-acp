import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function source(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

describe("model catalog architecture", () => {
  it("has no operational fallback to static, picker, or live-session model inventories", () => {
    const authorityConsumers = [
      "packages/core/src/core/session-router.ts",
      "packages/core/src/core/thread-session-control.ts",
      "packages/core/src/core/config-mutation.ts",
      "packages/core/src/core/context-window.ts",
      "packages/core/src/platforms/discord/config-editor.ts",
      "packages/core/src/platforms/discord/orchestrator.ts",
    ].map(source).join("\n");
    expect(authorityConsumers).not.toMatch(/pickerModelsForProfile|listPickerModels|\.staticModels/);
    expect(authorityConsumers).not.toMatch(/getSessionInfo\(\)\?\.availableModels/);
    expect(authorityConsumers).not.toMatch(/profile\??\.effort/);
    expect(authorityConsumers).not.toMatch(/profile\??\.defaultModel/);
    expect(source("packages/core/src/platforms/discord/orchestrator.ts")).not.toContain("this.config.DEFAULT_MODEL");
    expect(source("packages/adapters/src/command-bus.ts")).not.toContain("listPickerModels");
    expect(source("packages/adapters/src/command-bus.ts")).toContain("fetchModelCatalog");
    expect(source("packages/core/src/core/model-value/sources.ts")).not.toContain("probeCopilotCatalog");
  });

  it("keeps provider naming rules out of core model selection", () => {
    const selectionCore = [
      "packages/core/src/core/model-catalog/service.ts",
      "packages/core/src/core/session-router.ts",
      "packages/core/src/core/thread-session-control.ts",
      "packages/core/src/platforms/discord/config-editor.ts",
      "packages/core/src/core/choice/ingest-model.ts",
    ].map(source).join("\n");
    expect(selectionCore).not.toMatch(/includes\(["'](?:claude|codex|copilot|agy|grok|zai|ollama-cloud)/);
    expect(selectionCore).not.toMatch(/===\s*["'](?:claude|codex|copilot|agy|grok|zai|ollama-cloud)["']/);
    const legacySelectionLeaks = [
      source("packages/core/src/core/choice/ingest-model.ts"),
      source("packages/core/src/platforms/discord/orchestrator.ts"),
    ].join("\n");
    expect(legacySelectionLeaks).not.toMatch(/ISOLATED_SAFE_[A-Z_]+_MODELS/);
    expect(legacySelectionLeaks).not.toMatch(/summaryModel\s*=|gpt-5-mini|gemini-3-flash/);
    expect(legacySelectionLeaks).not.toMatch(/COMPACTION_MODEL_WINDOWS|config\.[A-Z_]+_COMPACTION_MODEL/);
  });

  it("requires every adapter to expose the single catalog boundary", () => {
    const contract = source("packages/adapters/src/agent-profile.ts");
    expect(contract).toContain("readonly catalog: AdapterCatalogSource");
    expect(source("packages/adapters/src/model-catalog.ts")).toContain("scope(): CatalogScope");
    expect(contract).not.toContain("readonly staticModels");
    for (const profile of ["copilot", "claude", "codex", "agy", "grok"]) {
      expect(source(`packages/adapters/src/profiles/${profile}.ts`)).toMatch(/catalog:\s*(?:\{|manifestCatalogSource)/);
    }
  });
});
