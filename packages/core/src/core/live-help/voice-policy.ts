/**
 * D11 refuse-list for production live-help. Explicit snowflake; no General-only
 * allowlist. School-named VCs/parents and obfuscated channels are refused.
 */
export const SCHOOL_NAME_RE = /school/i;
/** discord.js ChannelType.GuildVoice */
export const GUILD_VOICE_TYPE = 2;

export type LiveHelpVoiceCheck =
  | { ok: true; channelId: string }
  | { ok: false; reason: string };

export function isDiscordSnowflake(id: string): boolean {
  return /^\d{10,}$/.test(id);
}

export function checkLiveHelpVoiceChannel(input: {
  id: string;
  name?: string | null;
  type?: number | null;
  parentName?: string | null;
  obfuscated?: boolean;
}): LiveHelpVoiceCheck {
  if (!isDiscordSnowflake(input.id)) {
    return { ok: false, reason: "refused: voiceChannelId is not a Discord snowflake" };
  }
  if (input.obfuscated) {
    return { ok: false, reason: "refused: obfuscated channel" };
  }
  if (input.type != null && input.type !== GUILD_VOICE_TYPE) {
    return { ok: false, reason: "refused: not a guild voice channel" };
  }
  if (input.name && SCHOOL_NAME_RE.test(input.name)) {
    return { ok: false, reason: "refused: school-named voice channel" };
  }
  if (input.parentName && SCHOOL_NAME_RE.test(input.parentName)) {
    return { ok: false, reason: "refused: school-named parent" };
  }
  return { ok: true, channelId: input.id };
}

export function parseLiveHelpMintSpec(
  raw: unknown
): { ok: true; spec: { voiceChannelId: string; system: string; historySummary?: string; notifyThread?: string; preset?: string } } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "create_live_help args must be an object" };
  }
  const o = raw as Record<string, unknown>;
  const voiceChannelId = typeof o.voiceChannelId === "string" ? o.voiceChannelId.trim() : "";
  const system = typeof o.system === "string" ? o.system.trim() : "";
  if (!voiceChannelId) return { ok: false, error: "`voiceChannelId` is required." };
  if (!isDiscordSnowflake(voiceChannelId)) {
    return { ok: false, error: "`voiceChannelId` must be a Discord snowflake." };
  }
  if (!system) return { ok: false, error: "`system` is required." };
  if (system.length > 8000) return { ok: false, error: "`system` is too long (max 8000)." };
  const spec: {
    voiceChannelId: string;
    system: string;
    historySummary?: string;
    notifyThread?: string;
    preset?: string;
  } = { voiceChannelId, system };
  if (typeof o.historySummary === "string" && o.historySummary.trim()) {
    spec.historySummary = o.historySummary.trim().slice(0, 4000);
  }
  if (o.notifyThread != null && o.notifyThread !== "") {
    if (typeof o.notifyThread !== "string" || !isDiscordSnowflake(o.notifyThread.trim())) {
      return { ok: false, error: "`notifyThread` must be a Discord snowflake." };
    }
    spec.notifyThread = o.notifyThread.trim();
  }
  if (typeof o.preset === "string" && o.preset.trim()) {
    spec.preset = o.preset.trim().slice(0, 80);
  }
  return { ok: true, spec };
}
