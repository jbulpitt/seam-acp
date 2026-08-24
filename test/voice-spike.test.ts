import { describe, it, expect } from "vitest";
import { ChannelType } from "discord.js";
import { OpusEncoder } from "@discordjs/opus";
import {
  LIVE_HELP_SPIKE_VOICE_CHANNEL_ID,
  OPUS_SILENCE_FRAME,
  checkSpikeVoiceChannel,
  decodeOpusPackets,
  pcmPeakRatio,
} from "../packages/core/src/platforms/discord/voice-spike.js";

describe("live-help voice spike allowlist", () => {
  it("accepts the family-guild General voice id", () => {
    expect(
      checkSpikeVoiceChannel({
        id: LIVE_HELP_SPIKE_VOICE_CHANNEL_ID,
        name: "General",
        type: ChannelType.GuildVoice,
        parentName: "Voice Channels",
      })
    ).toEqual({ ok: true, channelId: LIVE_HELP_SPIKE_VOICE_CHANNEL_ID });
  });

  it("refuses any other snowflake", () => {
    const r = checkSpikeVoiceChannel({
      id: "1515080987074232323",
      name: "General",
      type: ChannelType.GuildVoice,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not the live-help spike test VC/);
  });

  it("refuses school-named channels even if the id matched", () => {
    const r = checkSpikeVoiceChannel({
      id: LIVE_HELP_SPIKE_VOICE_CHANNEL_ID,
      name: "school-allie",
      type: ChannelType.GuildVoice,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/school-named voice/);
  });

  it("refuses a school-named parent category", () => {
    const r = checkSpikeVoiceChannel({
      id: LIVE_HELP_SPIKE_VOICE_CHANNEL_ID,
      name: "General",
      type: ChannelType.GuildVoice,
      parentName: "school-alaina",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/school-named parent/);
  });

  it("refuses non-voice types and obfuscated channels", () => {
    expect(
      checkSpikeVoiceChannel({
        id: LIVE_HELP_SPIKE_VOICE_CHANNEL_ID,
        name: "General",
        type: ChannelType.GuildText,
      }).ok
    ).toBe(false);
    expect(
      checkSpikeVoiceChannel({
        id: LIVE_HELP_SPIKE_VOICE_CHANNEL_ID,
        name: "General",
        type: ChannelType.GuildVoice,
        obfuscated: true,
      }).ok
    ).toBe(false);
  });
});

describe("live-help voice spike capture helpers", () => {
  it("pcmPeakRatio is 0 for silence and >0 for a tone", () => {
    expect(pcmPeakRatio(Buffer.alloc(32))).toBe(0);
    const tone = Buffer.alloc(4);
    tone.writeInt16LE(16_000, 0);
    tone.writeInt16LE(-16_000, 2);
    expect(pcmPeakRatio(tone)).toBeCloseTo(16000 / 32768, 5);
  });

  it("decodeOpusPackets skips silence frames and roundtrips a 20ms stereo frame", () => {
    const enc = new OpusEncoder(48_000, 2);
    const frame = Buffer.alloc(960 * 2 * 2);
    for (let i = 0; i < 960; i++) {
      const s = Math.round(8000 * Math.sin((2 * Math.PI * i) / 960));
      frame.writeInt16LE(s, i * 4);
      frame.writeInt16LE(s, i * 4 + 2);
    }
    const packet = enc.encode(frame);
    const decoded = decodeOpusPackets([OPUS_SILENCE_FRAME, packet, OPUS_SILENCE_FRAME]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.channels).toBe(2);
    expect(decoded.pcm.byteLength).toBeGreaterThan(0);
    expect(pcmPeakRatio(decoded.pcm)).toBeGreaterThan(0.1);
  });

  it("decodeOpusPackets fails on silence-only", () => {
    const r = decodeOpusPackets([OPUS_SILENCE_FRAME, OPUS_SILENCE_FRAME]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/only silence/);
  });
});
