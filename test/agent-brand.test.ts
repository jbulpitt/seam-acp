import { describe, it, expect } from "vitest";
import {
  brandIconUrl,
  DEFAULT_BRAND_ICON_BASE_URL,
  resolveAgentBrand,
} from "../packages/core/src/core/agent-brand.js";
import { loadConfig } from "../packages/core/src/config.js";

describe("resolveAgentBrand (#96)", () => {
  it("groups copilot* onto copilot", () => {
    expect(resolveAgentBrand("copilot")).toBe("copilot");
    expect(resolveAgentBrand("copilot-amorgan")).toBe("copilot");
    expect(resolveAgentBrand("copilot-fhr")).toBe("copilot");
  });

  it("groups claude and claude-<account> onto claude", () => {
    expect(resolveAgentBrand("claude")).toBe("claude");
    expect(resolveAgentBrand("claude-amorgan")).toBe("claude");
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
