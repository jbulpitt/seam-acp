import { describe, expect, it } from "vitest";
import { VoiceLeaseManager } from "../packages/core/src/core/voice-lease.js";

describe("VoiceLeaseManager", () => {
  it("allows exactly one product lease per guild and names the active holder", () => {
    const leases = new VoiceLeaseManager({ now: () => "2026-08-27T12:00:00.000Z" });
    const first = leases.acquire({
      kind: "thread_voice",
      sessionId: "tv_1",
      guildId: "guild-1",
      voiceChannelId: "vc-1",
    });
    expect(first).toMatchObject({ ok: true, acquired: true });

    const refused = leases.acquire({
      kind: "live_help",
      sessionId: "lh_1",
      guildId: "guild-1",
      voiceChannelId: "vc-2",
    });
    expect(refused).toMatchObject({
      ok: false,
      active: { kind: "thread_voice", sessionId: "tv_1" },
    });
    if (!refused.ok) {
      expect(refused.error).toContain("thread_voice");
      expect(refused.error).toContain("tv_1");
    }
  });

  it("is idempotent for one holder and independent across guilds", () => {
    const leases = new VoiceLeaseManager();
    const input = {
      kind: "thread_voice" as const,
      sessionId: "console-or-session-id",
      guildId: "guild-1",
      voiceChannelId: "vc-1",
    };
    expect(leases.acquire(input)).toMatchObject({ ok: true, acquired: true });
    expect(leases.acquire(input)).toMatchObject({ ok: true, acquired: false });
    expect(
      leases.acquire({ ...input, sessionId: "tv_2", guildId: "guild-2" })
    ).toMatchObject({ ok: true, acquired: true });
    expect(leases.list()).toHaveLength(2);
  });

  it("prevents a stale holder from releasing a newer guild lease", () => {
    const leases = new VoiceLeaseManager();
    leases.acquire({
      kind: "thread_voice",
      sessionId: "tv_old",
      guildId: "guild-1",
      voiceChannelId: "vc-1",
    });
    expect(
      leases.release({ kind: "thread_voice", sessionId: "tv_old", guildId: "guild-1" })
    ).toBe(true);
    leases.acquire({
      kind: "live_help",
      sessionId: "lh_new",
      guildId: "guild-1",
      voiceChannelId: "vc-1",
    });
    expect(
      leases.release({ kind: "thread_voice", sessionId: "tv_old", guildId: "guild-1" })
    ).toBe(false);
    expect(leases.get("guild-1")?.sessionId).toBe("lh_new");
  });

  it("uses only guild identity as the generic key", () => {
    const leases = new VoiceLeaseManager();
    const result = leases.acquire({
      kind: "thread_voice",
      sessionId: "future-console-1",
      guildId: "guild-1",
      voiceChannelId: "vc-1",
    });
    expect(result.ok && result.lease).not.toHaveProperty("channelRef");
    expect(result.ok && result.lease).not.toHaveProperty("homeThreadId");
  });
});
