import { asLocalAdapter, CLAUDE_FAST_MODE, CODEX_FAST_MODE, UNKNOWN_AGENT_IDENTITY, type AgentAdapter, type AgentClientMetadata, type AdapterCatalogSource, resolveErrorClassifier, resolveLegacyControllerErrorClassifier, resolveSessionMetaCodec, resolveLegacyControllerSessionPolicy } from "@seam/adapters";

/** ACP client metadata, not a controller-side launch or session-file reader. */
export function controllerMetadataAdapter(
  profile: Pick<AgentAdapter, "id" | "catalog"> & Partial<AgentAdapter>,
  metadata?: AgentClientMetadata,
  catalog: AdapterCatalogSource = profile.catalog,
  claudeSessionOptions?: AgentClientMetadata["claudeSessionOptions"],
): AgentAdapter {
  const claude = profile.id === "claude" || profile.id.startsWith("claude-") || !!metadata?.claudeSessionOptions;
  const copilot = profile.id.startsWith("copilot");
  const defaultModel = metadata?.defaultModel ?? profile.defaultModel ?? "default";
  const classifyError = metadata && Object.hasOwn(metadata, "errorClassifier")
    ? resolveErrorClassifier(metadata.errorClassifier, profile.id)
    : resolveLegacyControllerErrorClassifier(profile.id, metadata?.claudeSessionOptions, profile.classifyError);
  const sessionOptions = () => ({
    defaultModel, ...profile.claudeSessionOptions, ...metadata?.claudeSessionOptions,
    ...claudeSessionOptions,
  });
  const legacy = resolveLegacyControllerSessionPolicy(profile.id, metadata?.claudeSessionOptions, sessionOptions);
  const owns = (key: keyof AgentClientMetadata) => metadata !== undefined && Object.hasOwn(metadata, key);
  const sessionPolicy = {
    effort: owns("effort") ? metadata?.effort ?? undefined : legacy.effort ?? profile.effort,
    mcpServersAtSpawn: owns("mcpServersAtSpawn") ? metadata?.mcpServersAtSpawn : legacy.mcpServersAtSpawn ?? profile.mcpServersAtSpawn,
    submissionSignals: owns("submissionSignals") ? metadata?.submissionSignals ?? undefined : legacy.submissionSignals ?? profile.submissionSignals,
    newSessionMeta: owns("sessionMetaCodec")
      ? resolveSessionMetaCodec(metadata?.sessionMetaCodec, sessionOptions)
      : legacy.newSessionMeta ?? profile.newSessionMeta,
  };
  const fastPolicy: Partial<AgentAdapter> = claude ? {
    fastMode: metadata?.fastMode ?? profile.fastMode ?? (profile.id === "claude" ? CLAUDE_FAST_MODE : undefined),
  } : copilot ? {} : profile.id === "codex" || profile.id.startsWith("codex-") ? {
    fastMode: metadata?.fastMode ?? profile.fastMode ?? (profile.id === "codex" ? CODEX_FAST_MODE : undefined),
  } : {};
  return asLocalAdapter({
    id: profile.id, displayName: metadata?.displayName ?? profile.displayName ?? profile.id, defaultModel,
    requestedContextTier: profile.requestedContextTier,
    fastMode: profile.fastMode,
    restrictDiscordAccess: profile.restrictDiscordAccess,
    catalog,
    ...metadata,
    ...sessionPolicy,
    ...fastPolicy,
    classifyError,
    harness: metadata?.harness ?? UNKNOWN_AGENT_IDENTITY.harness,
    provider: metadata?.provider ?? UNKNOWN_AGENT_IDENTITY.provider,
    account: metadata?.account ?? UNKNOWN_AGENT_IDENTITY.account,
    brand: metadata?.brand,
    spawn(): never { throw new Error(`agent ${profile.id} cannot be spawned on the controller`); },
  });
}
