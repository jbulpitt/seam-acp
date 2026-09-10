import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("model intelligence architectural boundaries (#249)", () => {
  it("production has one refresh coordinator and no static release registry", () => {
    const entry = read("packages/core/src/index.ts");
    expect(entry).toContain("new ModelIntelligenceManager");
    expect(entry).not.toContain("new ModelMetadataManager");
    expect(entry).not.toContain("new ModelValueManager");
    expect(() => read("packages/core/src/core/model-metadata/aliases.ts")).toThrow();

    const matching = read("packages/core/src/core/model-intelligence/matching.ts");
    expect(matching).not.toMatch(/gpt-6-astra|gemini-3\.8|grok-4\.6|gpt-5\.6/);
  });

  it("keeps enrichment off the per-turn status panel", () => {
    const status = read("packages/core/src/core/status-panel.ts");
    expect(status).not.toMatch(/model-intelligence|intelligence_index|value_score/i);
  });

  it("keeps source fetches out of MCP and card read paths", () => {
    const mcp = read("packages/core/src/core/mcp/seam-mcp-server.ts");
    const card = read("packages/core/src/core/model-value/rankings-card.ts");
    expect(mcp).not.toContain("fetchAaModels");
    expect(mcp).not.toContain("fetchCopilotPricing");
    expect(card).not.toContain("fetchAaModels");
    expect(card).not.toContain("fetchCopilotPricing");
  });
});
