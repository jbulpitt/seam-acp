import { describe, it, expect } from "vitest";
import {
  brandIconUrl,
  DEFAULT_BRAND_ICON_BASE_URL,
  resolveAgentBrand,
} from "../packages/core/src/plugins/card-visuals/agent-brand.js";
import { loadConfig } from "../packages/core/src/config.js";

describe("resolveAgentBrand", () => {
  it.each([
    ["anthropic", "claude"], ["github-copilot", "copilot"], ["openai", "codex"],
    ["xai", "grok"], ["google-antigravity", "agy"], ["vertex", "vertex"],
    ["z-ai", "z-ai"], ["ollama-cloud", "ollama-cloud"], ["kimi", "kimi"],
  ])("uses provider %s rather than the composite selector", (provider, brand) => {
    expect(resolveAgentBrand(provider)).toBe(brand);
  });

  it("honors the explicit logo override without changing provider", () => {
    expect(resolveAgentBrand("anthropic", "custom")).toBe("custom");
    expect(resolveAgentBrand("unknown", "custom")).toBe("custom");
    expect(resolveAgentBrand(undefined)).toBe("unknown");
  });
});

describe("hosted brand icons", () => {
  it("uses pinned WebP URLs for every shipped brand", () => {
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
      expect(brandIconUrl(brand)).toBe(`${DEFAULT_BRAND_ICON_BASE_URL}/${brand}.webp`);
    }
  });

  it("keeps unknown brands text-only", () => {
    expect(brandIconUrl("no-such-brand-xyz")).toBeUndefined();
  });

  it("uses the configurable base for a future asset host", () => {
    const cfg = loadConfig({ env: {
      DISCORD_BOT_TOKEN: "test", DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: process.cwd(), BRAND_ICON_BASE_URL: "https://icons.example/agents/",
    } });
    expect(brandIconUrl("codex", cfg.BRAND_ICON_BASE_URL))
      .toBe("https://icons.example/agents/codex.webp");
  });
});
