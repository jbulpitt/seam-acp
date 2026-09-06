/**
 * Parked agents (#220).
 *
 * Contrast `retired-agents.ts` (#12): a parked agent is disabled in production
 * but kept in the tree so flipping one flag re-enables it. Sessions, channel
 * presets, and thread presets may still name it — those live in the DB and in
 * `channel-presets.json`, neither of which this repo rewrites. Without this
 * table a parked id fails as a bare `Unknown agent profile "…"`, which is
 * indistinguishable from a typo and reads as if the agent were gone forever.
 *
 * The contract is **fail clearly, never silently substitute**. A parked agent
 * does not fall back to the default agent: that would run the thread's prompts
 * on a different model than the thread was configured for, without anyone
 * asking. The turn fails with a message naming the park and the env flag that
 * re-enables it. Nothing is mutated — the operator decides.
 *
 * `OLLAMA_CLOUD_ENABLED` is the complete reversible switch for every live
 * surface (catalog, quota, provider-status probe, leftover sessions). The
 * profile factory, `OLLAMA_CLOUD_*` schema, brand, namer glyph, and
 * `~/.codex-ollama-cloud` layout stay in the tree.
 */

export const OLLAMA_CLOUD_AGENT_ID = "ollama-cloud";
export const OLLAMA_CLOUD_ENABLE_FLAG = "OLLAMA_CLOUD_ENABLED";
export const LINKWORKS_OLLAMA_SOURCE_ID = "linkworks-ollama";

/** Fail-closed copy for a leftover session still bound to ollama-cloud. */
export const PARKED_OLLAMA_CLOUD_SESSION_MESSAGE =
  `Agent "${OLLAMA_CLOUD_AGENT_ID}" (Ollama Cloud) is parked (disabled via ${OLLAMA_CLOUD_ENABLE_FLAG}), not retired. ` +
  `This thread is still bound to it, so it cannot start a turn. ` +
  `Re-enable by setting ${OLLAMA_CLOUD_ENABLE_FLAG}=true (the API key already in .env is fine) and redeploying. ` +
  `To keep it parked, pick a live agent with \`/seam config agent\`. ` +
  `Switching agents starts a fresh session — the previous conversation context is not carried over.`;

/** Fail-closed copy when a picker / configure / slash path tries to select it. */
export const PARKED_OLLAMA_CLOUD_SELECT_MESSAGE =
  `Agent "${OLLAMA_CLOUD_AGENT_ID}" (Ollama Cloud) is parked (disabled via ${OLLAMA_CLOUD_ENABLE_FLAG}). ` +
  `It is not available to select. Re-enable by setting ${OLLAMA_CLOUD_ENABLE_FLAG}=true and redeploying.`;

export function isOllamaCloudAgentId(agentId: string): boolean {
  const id = agentId.trim();
  return id === OLLAMA_CLOUD_AGENT_ID || id.startsWith(`${OLLAMA_CLOUD_AGENT_ID}-`);
}

/** True when the production park switch is off. */
export function isOllamaCloudParked(ollamaCloudEnabled: boolean | undefined): boolean {
  return ollamaCloudEnabled === false;
}

/**
 * Live catalog membership: both the park switch and an API key. Matches the
 * historical registration gate in `packages/core/src/index.ts`.
 */
export function shouldRegisterOllamaCloud(config: {
  OLLAMA_CLOUD_ENABLED: boolean;
  OLLAMA_CLOUD_API_KEY?: string;
}): boolean {
  return config.OLLAMA_CLOUD_ENABLED === true && Boolean(config.OLLAMA_CLOUD_API_KEY?.trim());
}

/**
 * `linkworks-ollama` is a third-party synthetic probe of a homelab inference
 * cluster — not official Ollama Cloud status. Seam only registered it as the
 * ollama-shaped check for this agent, so the same flag gates it: parked
 * ollama-cloud must not still look like we are monitoring Ollama Cloud.
 */
export function shouldIncludeLinkworksOllamaSource(ollamaCloudEnabled: boolean): boolean {
  return ollamaCloudEnabled === true;
}

export type ParkedAgentMessageKind = "session" | "select" | "config";

/**
 * Operator-facing explanation for a parked agent, or null when `agentId` is
 * not parked under the given flag. `kind` picks leftover-session vs select vs
 * boot-time setting wording.
 */
export function parkedAgentMessage(
  agentId: string,
  ollamaCloudEnabled: boolean | undefined,
  kind: ParkedAgentMessageKind = "session",
  setting = "DEFAULT_AGENT"
): string | null {
  if (!isOllamaCloudParked(ollamaCloudEnabled) || !isOllamaCloudAgentId(agentId)) {
    return null;
  }
  if (kind === "select") return PARKED_OLLAMA_CLOUD_SELECT_MESSAGE;
  if (kind === "config") {
    return (
      `${setting}="${agentId}" names a parked agent (Ollama Cloud). ` +
      `Set ${OLLAMA_CLOUD_ENABLE_FLAG}=true to re-enable it, or set ${setting} to a live agent. ` +
      `seam-acp will not substitute one for you.`
    );
  }
  return PARKED_OLLAMA_CLOUD_SESSION_MESSAGE;
}

/** Agent families `/seam usage` can scrape, in display order. */
const USAGE_FAMILIES: ReadonlyArray<{ label: string; test: (id: string) => boolean }> = [
  { label: "agy", test: (id) => id === "agy" || id.startsWith("agy-") },
  { label: "ollama-cloud", test: isOllamaCloudAgentId },
  { label: "claude", test: (id) => id === "claude" || id.startsWith("claude-") },
  { label: "copilot", test: (id) => id === "copilot" || id.startsWith("copilot-") },
  { label: "grok", test: (id) => id === "grok" || id.startsWith("grok-") },
  { label: "codex", test: (id) => id === "codex" || id.startsWith("codex-") },
];

/** Usage-card agent labels derived from the live catalog, never a hardcoded roster. */
export function liveUsageAgentLabels(profileIds: readonly string[]): string[] {
  return USAGE_FAMILIES.filter((fam) => profileIds.some((id) => fam.test(id))).map((fam) => fam.label);
}

export function formatUsageAgentList(labels: readonly string[]): string {
  return labels.map((id) => `\`${id}\``).join(", ");
}
