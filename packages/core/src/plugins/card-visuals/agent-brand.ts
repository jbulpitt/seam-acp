/**
 * Agent brand keys for status-card icons.
 *
 * The icon names the *service*, not the harness: a Claude-code process pointed
 * at Z.ai / Ollama Cloud / Vertex shows that service's logo, not Claude's.
 */

export const DEFAULT_BRAND_ICON_BASE_URL =
  "https://cdn.jsdelivr.net/gh/jbulpitt/seam-acp@8414cb8c3df938fd0e9360e511ea9db62837456b/assets/agents";

const PROVIDER_BRANDS: Readonly<Record<string, string>> = {
  anthropic: "claude", "github-copilot": "copilot", openai: "codex",
  xai: "grok", "google-antigravity": "agy",
};

const BRANDS = new Set([
  "agy", "claude", "codex", "copilot", "grok", "kimi",
  "ollama-cloud", "vertex", "z-ai",
]);

/** The provider names the service; an explicit display override wins. */
export function resolveAgentBrand(provider = "unknown", profileBrand?: string): string {
  return profileBrand?.trim() || PROVIDER_BRANDS[provider] || provider;
}

/** Unknown brands keep their text-only icon fallback. */
export function brandIconUrl(
  brand: string,
  baseUrl = DEFAULT_BRAND_ICON_BASE_URL
): string | undefined {
  if (!BRANDS.has(brand)) return undefined;
  return `${baseUrl.replace(/\/+$/, "")}/${brand}.webp`;
}
