import { asLocalAdapter, claudeSessionMetadata, CLAUDE_FAST_MODE, type AgentProfile, type AgentClientMetadata, type AdapterCatalogSource, classifyAndAttach, classifyCodexError, classifyAgyError, classifyClaudeError, classifyCopilotError, classifyGrokError } from "@seam/adapters";

/** ACP client metadata, not a controller-side launch or session-file reader. */
export function controllerMetadataAdapter(
  profile: Pick<AgentProfile, "id" | "catalog"> & Partial<AgentProfile>,
  metadata?: AgentClientMetadata,
  catalog: AdapterCatalogSource = profile.catalog,
  claudeSessionOptions?: AgentClientMetadata["claudeSessionOptions"],
): AgentProfile {
  const claude = profile.id === "claude" || profile.id.startsWith("claude-") || !!metadata?.claudeSessionOptions;
  const copilot = profile.id.startsWith("copilot");
  const defaultModel = metadata?.defaultModel ?? profile.defaultModel ?? "default";
  const policy: Partial<AgentProfile> = claude ? {
    classifyError: (error: unknown) => classifyAndAttach(error, classifyClaudeError(error, profile.id)),
    effort: { mechanism: "meta", levels: ["low", "medium", "high", "xhigh", "max"] },
    fastMode: metadata?.fastMode ?? profile.fastMode ?? (profile.id === "claude" ? CLAUDE_FAST_MODE : undefined),
    submissionSignals: "claude_sdk",
    newSessionMeta: (model?: string, effort?: string) => claudeSessionMetadata({
      defaultModel, ...profile.claudeSessionOptions, ...metadata?.claudeSessionOptions,
      ...claudeSessionOptions,
    }, model, effort),
  } : copilot ? {
    classifyError: (error: unknown) => classifyAndAttach(error, classifyCopilotError(error, profile.id)),
    mcpServersAtSpawn: true,
    effort: { mechanism: "configOption", configId: "reasoning_effort", levels: ["low", "medium", "high", "xhigh", "max"] },
  } : profile.id === "codex" || profile.id.startsWith("codex-") ? {
    classifyError: (error: unknown) => classifyAndAttach(error, classifyCodexError(error, profile.id)),
  } : profile.id === "agy" ? {
    classifyError: (error: unknown) => classifyAndAttach(error, classifyAgyError(error, profile.id)),
  } : profile.id.startsWith("grok") ? {
    classifyError: (error: unknown) => classifyAndAttach(error, classifyGrokError(error, profile.id)),
  } : {};
  return asLocalAdapter({
    id: profile.id, displayName: metadata?.displayName ?? profile.displayName ?? profile.id, defaultModel,
    brand: profile.brand, requestedContextTier: profile.requestedContextTier,
    effort: profile.effort, fastMode: profile.fastMode,
    restrictDiscordAccess: profile.restrictDiscordAccess,
    mcpServersAtSpawn: profile.mcpServersAtSpawn, submissionSignals: profile.submissionSignals,
    newSessionMeta: profile.newSessionMeta, classifyError: profile.classifyError,
    catalog,
    ...metadata,
    ...policy,
    spawn(): never { throw new Error(`agent ${profile.id} cannot be spawned on the controller`); },
  });
}
