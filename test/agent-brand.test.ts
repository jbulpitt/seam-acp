import { describe, it, expect } from "vitest";
import {
  brandIconUrl,
  loadBrandAsset,
  resolveAgentBrand,
  withBrandAttachment,
} from "../packages/core/src/core/agent-brand.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";

describe("resolveAgentBrand (#96)", () => {
  it("groups copilot* onto copilot", () => {
    expect(resolveAgentBrand("copilot")).toBe("copilot");
    expect(resolveAgentBrand("copilot-jbulpitt")).toBe("copilot");
    expect(resolveAgentBrand("copilot-fhr")).toBe("copilot");
  });

  it("groups claude and claude-<account> onto claude", () => {
    expect(resolveAgentBrand("claude")).toBe("claude");
    expect(resolveAgentBrand("claude-jbulpitt")).toBe("claude");
  });

  it("overrides Claude-harness services to their service brand (before grouping)", () => {
    expect(resolveAgentBrand("zai")).toBe("z-ai");
    expect(resolveAgentBrand("zai-work")).toBe("z-ai");
    expect(resolveAgentBrand("ollama-cloud")).toBe("ollama-cloud");
    expect(resolveAgentBrand("ollama-cloud-extra")).toBe("ollama-cloud");
    expect(resolveAgentBrand("claude-vertex")).toBe("vertex");
    expect(resolveAgentBrand("claude-vertex-prod")).toBe("vertex");
  });

  it("is 1:1 for grok/agy/codex/kimi", () => {
    expect(resolveAgentBrand("grok")).toBe("grok");
    expect(resolveAgentBrand("agy")).toBe("agy");
    expect(resolveAgentBrand("codex")).toBe("codex");
    expect(resolveAgentBrand("kimi")).toBe("kimi");
  });

  it("honors an explicit profile.brand override", () => {
    expect(resolveAgentBrand("claude-vertex", "vertex")).toBe("vertex");
    expect(resolveAgentBrand("something-else", "custom")).toBe("custom");
  });
});

describe("loadBrandAsset (#96)", () => {
  it("loads seeded logos for known brands", () => {
    for (const brand of [
      "agy",
      "claude",
      "codex",
      "copilot",
      "grok",
      "kimi",
      "ollama-cloud",
      "vertex",
      "z-ai",
    ]) {
      const asset = loadBrandAsset(brand);
      expect(asset, `missing asset for ${brand}`).not.toBeNull();
      expect(asset!.filename.startsWith(brand)).toBe(true);
      expect(asset!.data.length).toBeGreaterThan(0);
      expect(brandIconUrl(asset!.filename)).toBe(`attachment://${asset!.filename}`);
    }
  });

  it("returns null when no file exists (text-only fallback)", () => {
    expect(loadBrandAsset("no-such-brand-xyz")).toBeNull();
  });
});

describe("withBrandAttachment", () => {
  const panel: StructuredPanel = {
    color: 1,
    title: "Working",
    fields: [],
    author: "Working",
    authorIconURL: "attachment://copilot.png",
  };

  it("adds files on first send and is a no-op without an asset", () => {
    expect(withBrandAttachment(panel, null).files).toBeUndefined();
    const asset = loadBrandAsset("copilot");
    expect(asset).not.toBeNull();
    const attached = withBrandAttachment(panel, asset);
    expect(attached.files).toEqual([
      { data: asset!.data, filename: asset!.filename },
    ]);
  });
});
