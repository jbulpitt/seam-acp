/**
 * Discord Channel Obfuscation (#52, mandatory 2026-11-16).
 *
 * Gateway still dispatches channels the bot lacks VIEW_CHANNEL on, but:
 *   - name becomes `___hidden___`
 *   - sensitive fields are nulled
 *   - CHANNEL_OBFUSCATED flag (1 << 17) is set
 *
 * HTTP GET /guilds/{id}/channels omits those channels entirely. This bot
 * never enumerates guild channels that way — DISCORD_ALLOWED_CHANNEL_IDS is
 * a static numeric-id allowlist — but gateway payloads still arrive, so
 * every name/metadata read must treat obfuscated channels as unnamed.
 *
 * discord.js 14.27.0 does not yet export the flag; we match the documented
 * bit and the sentinel name so we stay correct before/after the library adds it.
 */

/** Sentinel Discord substitutes for a channel name the bot cannot view. */
export const DISCORD_HIDDEN_CHANNEL_NAME = "___hidden___";

/** ChannelFlags.CHANNEL_OBFUSCATED — 1 << 17. */
export const CHANNEL_OBFUSCATED_FLAG = 1 << 17;

export type ChannelVisibilityInput = {
  name?: string | null;
  flags?: { bitfield?: number; has?: (bit: number) => boolean } | number | null;
};

function flagsBitfield(flags: ChannelVisibilityInput["flags"]): number {
  if (flags == null) return 0;
  if (typeof flags === "number") return flags;
  if (typeof flags.bitfield === "number") return flags.bitfield;
  if (typeof flags.has === "function") {
    try {
      return flags.has(CHANNEL_OBFUSCATED_FLAG) ? CHANNEL_OBFUSCATED_FLAG : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

/** True when Discord has obfuscated this channel (no VIEW_CHANNEL). */
export function isObfuscatedChannel(ch: ChannelVisibilityInput | null | undefined): boolean {
  if (!ch) return false;
  if (ch.name === DISCORD_HIDDEN_CHANNEL_NAME) return true;
  return (flagsBitfield(ch.flags) & CHANNEL_OBFUSCATED_FLAG) !== 0;
}

/**
 * Display name for a channel the bot is allowed to treat as real.
 * Obfuscated / `___hidden___` → undefined (never surface the sentinel).
 */
export function visibleDiscordChannelName(
  ch: ChannelVisibilityInput | null | undefined
): string | undefined {
  if (!ch || isObfuscatedChannel(ch)) return undefined;
  const n = ch.name?.trim();
  if (!n) return undefined;
  return n;
}
