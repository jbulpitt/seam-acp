/**
 * Immutable cost/correctness policy for Premium Compact (Discord).
 *
 * Discord is the provider-neutral source. Every bulk-analysis call on this
 * path runs through AGY at one exact model so a run cannot consume the
 * destination thread's Codex/Claude/Copilot/Grok quota.
 */

export const DISCORD_COMPACTION_EXECUTOR_ID = "agy";
export const DISCORD_COMPACTION_MODEL = "gemini-3.8-flash-high";
export const DISCORD_COMPACTION_EXECUTOR_LABEL =
  `AGY · ${DISCORD_COMPACTION_MODEL}`;

export class DiscordCompactionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordCompactionUnavailableError";
  }
}

export function discordCompactionExecutor(): {
  id: string;
  displayName: string;
  model: string;
} {
  return {
    id: DISCORD_COMPACTION_EXECUTOR_ID,
    displayName: "AGY",
    model: DISCORD_COMPACTION_MODEL,
  };
}

export function isAgyExecutorId(id: string | undefined): boolean {
  return id === DISCORD_COMPACTION_EXECUTOR_ID || Boolean(id?.startsWith("agy-"));
}

export function resolveDiscordCompactionProfile<
  T extends { id: string; sessionManager?: unknown },
>(getProfile: (id: string) => T | undefined): {
  profile: T;
  manager: NonNullable<T["sessionManager"]>;
} {
  const profile = getProfile(DISCORD_COMPACTION_EXECUTOR_ID);
  if (!profile || !isAgyExecutorId(profile.id)) {
    throw new DiscordCompactionUnavailableError(
      "Premium Compact (Discord) requires the AGY profile; it is not configured."
    );
  }
  const manager = profile.sessionManager;
  if (!manager) {
    throw new DiscordCompactionUnavailableError(
      "Premium Compact (Discord) requires the AGY session manager; it is unavailable."
    );
  }
  return { profile, manager: manager as NonNullable<T["sessionManager"]> };
}

export function requireExactCatalogModel(
  catalog: ReadonlyArray<{ modelId: string }>,
  modelId: string = DISCORD_COMPACTION_MODEL
): void {
  if (!catalog.some((entry) => entry.modelId === modelId)) {
    throw new DiscordCompactionUnavailableError(
      `Premium Compact (Discord) requires AGY model ${modelId} in the live catalog; it is unavailable or rejected.`
    );
  }
}

export function isDiscordPremiumCompactAvailable(
  getProfile: (id: string) => { id: string; sessionManager?: unknown } | undefined
): boolean {
  try {
    resolveDiscordCompactionProfile(getProfile);
    return true;
  } catch (err) {
    if (err instanceof DiscordCompactionUnavailableError) return false;
    throw err;
  }
}
