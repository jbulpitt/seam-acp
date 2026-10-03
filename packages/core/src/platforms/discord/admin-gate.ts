/** Slash commands trust Discord's authenticated user id, not prompt stamping. */
import type { Config } from "../../config.js";

export const BRIDGE_ADMIN_REFUSAL =
  "🔒 Bridge and debug commands are admin-only.";
export const THREAD_VOICE_ADMIN_REFUSAL =
  "🔒 `/seamadmin voice` is admin-only in Thread Voice v1.";

export function isBridgeAdminRefused(
  config: Pick<Config, "SEAM_CONFIG_ADMIN_USER_IDS">,
  authenticatedUserId: string | undefined | null
): boolean {
  return !authenticatedUserId || !config.SEAM_CONFIG_ADMIN_USER_IDS?.has(authenticatedUserId);
}

export const isThreadVoiceAdminRefused = isBridgeAdminRefused;
