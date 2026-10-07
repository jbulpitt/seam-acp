import { asLocalAdapter, claudeSessionMetadata, type AgentProfile, type AgentClientMetadata, type AdapterCatalogSource, classifyAndAttach, classifyCodexError, classifyAgyError, classifyClaudeError, classifyCopilotError, classifyGrokError } from "@seam/adapters";

/** ACP client metadata, not a controller-side launch or session-file reader. */
export function controllerMetadataAdapter(
  profile: Pick<AgentProfile, "id" | "catalog"> & Partial<AgentProfile>,
  metadata?: AgentClientMetadata,
  catalog: AdapterCatalogSource = profile.catalog,
  claudeSessionOptions?: AgentClientMetadata["claudeSessionOptions"],
): AgentProfile {
  return asLocalAdapter({
    id: profile.id, displayName: metadata?.displayName ?? profile.displayName!, defaultModel: metadata?.defaultModel ?? profile.defaultModel!,
    brand: profile.brand, requestedContextTier: profile.requestedContextTier,
    effort: profile.effort, fastMode: profile.fastMode,
    restrictDiscordAccess: profile.restrictDiscordAccess,
    mcpServersAtSpawn: profile.mcpServersAtSpawn, submissionSignals: profile.submissionSignals,
    newSessionMeta: profile.newSessionMeta, classifyError: profile.classifyError,
    catalog,
    ...((profile.id === "codex" || profile.id.startsWith("codex-")) ? {
      classifyError: (error: unknown) => classifyAndAttach(error, classifyCodexError(error, profile.id)),
    } : profile.id === "agy" ? {
      classifyError: (error: unknown) => classifyAndAttach(error, classifyAgyError(error, profile.id)),
    } : {}),
    ...metadata,
    ...(metadata?.claudeSessionOptions ? {
      classifyError: (error: unknown) => classifyAndAttach(error, classifyClaudeError(error, profile.id)),
    } : profile.id.startsWith("copilot") ? {
      classifyError: (error: unknown) => classifyAndAttach(error, classifyCopilotError(error, profile.id)),
    } : profile.id.startsWith("grok") ? {
      classifyError: (error: unknown) => classifyAndAttach(error, classifyGrokError(error, profile.id)),
    } : {}),
    ...(metadata?.claudeSessionOptions ? {
      newSessionMeta: (model?: string, effort?: string) => claudeSessionMetadata({
        defaultModel: metadata.defaultModel, ...metadata.claudeSessionOptions,
        ...claudeSessionOptions,
      }, model, effort),
    } : {}),
    spawn(): never { throw new Error(`agent ${profile.id} cannot be spawned on the controller`); },
  });
}
