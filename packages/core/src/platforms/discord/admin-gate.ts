/**
 * #83 / #71 stamped-admin predicate for `/seam bridge` and `/seam debug`.
 *
 * Fail closed when speaker identity is off or there is no stamped id — the
 * same rule as config_propose in a locked channel. Discord `interaction.user.id`
 * is the slash-path stamp; it is still refused unless SPEAKER_IDENTITY_ENABLED
 * is on, so a misconfigured host cannot pair a bridge or open the dev tunnel.
 */
import type { Config } from "../../config.js";

export const BRIDGE_ADMIN_REFUSAL =
  "🔒 Bridge and debug commands are admin-only.";
export const THREAD_VOICE_ADMIN_REFUSAL =
  "🔒 `/seam voice` is admin-only in Thread Voice v1.";

export interface StampedAdminResult {
  allowed: boolean;
  speakerId: string | null;
  reason?: "speaker-identity-off" | "no-stamped-id" | "not-admin";
}

export function isStampedConfigAdmin(
  config: Pick<Config, "SPEAKER_IDENTITY_ENABLED" | "SEAM_CONFIG_ADMIN_USER_IDS">,
  stampedUserId: string | undefined | null
): StampedAdminResult {
  const speakerId = stampedUserId ?? null;
  if (!config.SPEAKER_IDENTITY_ENABLED) {
    return { allowed: false, speakerId, reason: "speaker-identity-off" };
  }
  if (!speakerId) {
    return { allowed: false, speakerId: null, reason: "no-stamped-id" };
  }
  if (!config.SEAM_CONFIG_ADMIN_USER_IDS?.has(speakerId)) {
    return { allowed: false, speakerId, reason: "not-admin" };
  }
  return { allowed: true, speakerId };
}

/** Inverse of `isStampedConfigAdmin` — true when the command must be refused. */
export function isBridgeAdminRefused(
  config: Pick<Config, "SPEAKER_IDENTITY_ENABLED" | "SEAM_CONFIG_ADMIN_USER_IDS">,
  stampedUserId: string | undefined | null
): boolean {
  return !isStampedConfigAdmin(config, stampedUserId).allowed;
}

/** Thread Voice trusts Discord's slash-command user id, but still fails closed. */
export function isThreadVoiceAdminRefused(
  config: Pick<Config, "SEAM_CONFIG_ADMIN_USER_IDS">,
  authenticatedUserId: string | undefined | null
): boolean {
  return !authenticatedUserId || !config.SEAM_CONFIG_ADMIN_USER_IDS?.has(authenticatedUserId);
}
