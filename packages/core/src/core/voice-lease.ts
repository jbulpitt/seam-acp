export type VoiceLeaseKind = "live_help" | "thread_voice";

/**
 * One reservation for the bot's single Discord voice connection in a guild.
 * The holder is a product session/console id. Home-thread identity deliberately
 * does not participate in this generic key so a future Voice Console can own
 * several bindings behind one guild connection.
 */
export interface VoiceLease {
  kind: VoiceLeaseKind;
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  acquiredUtc: string;
}

export type VoiceLeaseAcquireResult =
  | { ok: true; lease: VoiceLease; acquired: boolean }
  | { ok: false; active: VoiceLease; error: string };

export class VoiceLeaseManager {
  private readonly byGuild = new Map<string, VoiceLease>();
  private readonly now: () => string;

  constructor(opts: { now?: () => string } = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  acquire(input: Omit<VoiceLease, "acquiredUtc"> & { acquiredUtc?: string }): VoiceLeaseAcquireResult {
    const active = this.byGuild.get(input.guildId);
    if (active) {
      if (
        active.kind === input.kind &&
        active.sessionId === input.sessionId &&
        active.voiceChannelId === input.voiceChannelId
      ) {
        return { ok: true, lease: active, acquired: false };
      }
      return {
        ok: false,
        active,
        error:
          `Guild voice is already leased by ${active.kind} session ` +
          `\`${active.sessionId}\` in channel \`${active.voiceChannelId}\`.`,
      };
    }
    const lease: VoiceLease = {
      kind: input.kind,
      sessionId: input.sessionId,
      guildId: input.guildId,
      voiceChannelId: input.voiceChannelId,
      acquiredUtc: input.acquiredUtc ?? this.now(),
    };
    this.byGuild.set(lease.guildId, lease);
    return { ok: true, lease, acquired: true };
  }

  get(guildId: string): VoiceLease | undefined {
    return this.byGuild.get(guildId);
  }

  list(): VoiceLease[] {
    return [...this.byGuild.values()];
  }

  /** A stale holder cannot release a newer lease for the same guild. */
  release(input: Pick<VoiceLease, "guildId" | "kind" | "sessionId">): boolean {
    const active = this.byGuild.get(input.guildId);
    if (!active || active.kind !== input.kind || active.sessionId !== input.sessionId) {
      return false;
    }
    this.byGuild.delete(input.guildId);
    return true;
  }

  releaseAll(): VoiceLease[] {
    const released = this.list();
    this.byGuild.clear();
    return released;
  }
}
