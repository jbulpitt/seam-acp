/**
 * Agent brand keys for status-card icons (#96).
 *
 * The icon names the *service*, not the harness: a Claude-code process pointed
 * at Z.ai / Ollama Cloud / Vertex shows that service's logo, not Claude's.
 */

export const DEFAULT_BRAND_ICON_BASE_URL =
  "https://cdn.jsdelivr.net/gh/jbulpitt/seam-acp@8414cb8c3df938fd0e9360e511ea9db62837456b/assets/agents";

const SERVICE_OVERRIDES: ReadonlyArray<{
  test: (id: string) => boolean;
  brand: string;
}> = [
  { test: (id) => id === "zai" || id.startsWith("zai-"), brand: "z-ai" },
  {
    test: (id) => id === "ollama-cloud" || id.startsWith("ollama-cloud-"),
    brand: "ollama-cloud",
  },
  {
    test: (id) => id === "claude-vertex" || id.startsWith("claude-vertex-"),
    brand: "vertex",
  },
];

const BRANDS = new Set([
  "agy", "claude", "codex", "copilot", "grok", "kimi",
  "ollama-cloud", "vertex", "z-ai",
]);

/**
 * Resolve `agentId` (and an optional profile.brand override) to the stable
 * brand key that names `assets/agents/<brand>.<ext>`.
 *
 * Service overrides run *before* base-agent grouping so `claude-vertex` is
 * `vertex`, not `claude`.
 */
export function resolveAgentBrand(agentId: string, profileBrand?: string): string {
  const explicit = profileBrand?.trim();
  if (explicit) return explicit;
  const id = agentId.trim();
  if (!id) return id;
  for (const o of SERVICE_OVERRIDES) {
    if (o.test(id)) return o.brand;
  }
  if (id === "copilot" || id.startsWith("copilot-")) return "copilot";
  if (id === "claude" || id.startsWith("claude-")) return "claude";
  return id;
}

/** Unknown brands keep their text-only icon fallback. */
export function brandIconUrl(
  brand: string,
  baseUrl = DEFAULT_BRAND_ICON_BASE_URL
): string | undefined {
  if (!BRANDS.has(brand)) return undefined;
  return `${baseUrl.replace(/\/+$/, "")}/${brand}.webp`;
}
