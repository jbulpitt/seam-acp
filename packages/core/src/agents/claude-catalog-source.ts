import type { CatalogBinding } from "../core/model-catalog/service.js";

/**
 * Route only the ordinary direct-Anthropic Claude profile to the controller's
 * canonical API catalog. This prevents a lagging bridge wrapper from hiding a
 * same-day model release. Removing this mapping makes `claude@bridge` consult
 * that bridge's wrapper again. Named Claude profiles and compatible backends
 * remain independent because their runtime access is not proven equivalent.
 */
export function mainClaudeCatalogSource(
  binding: CatalogBinding,
  enabled: boolean,
): CatalogBinding {
  return enabled && binding.agentId === "claude" && binding.location !== "local"
    ? { agentId: "claude", location: "local" }
    : binding;
}
