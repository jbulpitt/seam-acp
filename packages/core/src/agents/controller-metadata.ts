import { asLocalAdapter, UNKNOWN_AGENT_IDENTITY, type AgentAdapter, type AgentClientMetadata, type AdapterCatalogSource, resolveErrorClassifier, resolveLegacyControllerErrorClassifier, resolveSessionMetaCodec, resolveLegacyControllerSessionPolicy, resolveLegacyControllerFastMode } from "@seam/adapters";

/** ACP client metadata, not a controller-side launch or session-file reader. */
export function controllerMetadataAdapter(
  profile: Pick<AgentAdapter, "id" | "catalog"> & Partial<AgentAdapter>,
  metadata?: AgentClientMetadata,
  catalog: AdapterCatalogSource = profile.catalog,
  claudeSessionOptions?: AgentClientMetadata["claudeSessionOptions"],
): AgentAdapter {
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
  const fastMode = owns("fastMode") ? metadata?.fastMode ?? undefined
    : resolveLegacyControllerFastMode(profile.id, metadata, profile.fastMode);
  return asLocalAdapter({
    id: profile.id, displayName: metadata?.displayName ?? profile.displayName ?? profile.id, defaultModel,
    requestedContextTier: profile.requestedContextTier,
    restrictDiscordAccess: profile.restrictDiscordAccess,
    catalog,
    ...metadata,
    ...sessionPolicy,
    fastMode,
    classifyError,
    harness: metadata?.harness ?? UNKNOWN_AGENT_IDENTITY.harness,
    provider: metadata?.provider ?? UNKNOWN_AGENT_IDENTITY.provider,
    account: metadata?.account ?? UNKNOWN_AGENT_IDENTITY.account,
    brand: metadata?.brand,
    spawn(): never { throw new Error(`agent ${profile.id} cannot be spawned on the controller`); },
  });
}
