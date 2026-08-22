import { describe, it, expect, afterEach } from "vitest";
import {
  CHANNEL_OBFUSCATED_FLAG,
  DISCORD_HIDDEN_CHANNEL_NAME,
  isObfuscatedChannel,
  visibleDiscordChannelName,
} from "../packages/core/src/platforms/discord/channel-visibility.js";
import { loadConfig } from "../packages/core/src/config.js";

describe("channel obfuscation (#52)", () => {
  it("treats the ___hidden___ sentinel as obfuscated, never as a display name", () => {
    const ch = { name: DISCORD_HIDDEN_CHANNEL_NAME, flags: { bitfield: 0 } };
    expect(isObfuscatedChannel(ch)).toBe(true);
    expect(visibleDiscordChannelName(ch)).toBeUndefined();
  });

  it("detects CHANNEL_OBFUSCATED (1 << 17) even when the name is still present", () => {
    const ch = { name: "secrets", flags: { bitfield: CHANNEL_OBFUSCATED_FLAG } };
    expect(CHANNEL_OBFUSCATED_FLAG).toBe(1 << 17);
    expect(isObfuscatedChannel(ch)).toBe(true);
    expect(visibleDiscordChannelName(ch)).toBeUndefined();
  });

  it("honors flags.has() like discord.js ChannelFlagsBitField", () => {
    const ch = {
      name: "general",
      flags: { has: (bit: number) => bit === CHANNEL_OBFUSCATED_FLAG },
    };
    expect(isObfuscatedChannel(ch)).toBe(true);
    expect(visibleDiscordChannelName(ch)).toBeUndefined();
  });

  it("returns the real name for a visible channel", () => {
    const ch = { name: "general", flags: { bitfield: 0 } };
    expect(isObfuscatedChannel(ch)).toBe(false);
    expect(visibleDiscordChannelName(ch)).toBe("general");
  });

  it("numeric flags bitfield also works", () => {
    expect(isObfuscatedChannel({ name: "x", flags: CHANNEL_OBFUSCATED_FLAG })).toBe(true);
    expect(isObfuscatedChannel({ name: "x", flags: 0 })).toBe(false);
  });
});

describe("DISCORD_ALLOWED_CHANNEL_IDS (#52 — IDs only, no guild enumeration)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function baseEnv(extra: Record<string, string | undefined>) {
    process.env = {
      ...saved,
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: process.cwd(),
      CHANNEL_PRESETS_FILE: undefined,
      ...extra,
    } as NodeJS.ProcessEnv;
  }

  it("parses a comma-separated numeric id list (never names)", () => {
    baseEnv({ DISCORD_ALLOWED_CHANNEL_IDS: "111, 222 " });
    const set = loadConfig().DISCORD_ALLOWED_CHANNEL_IDS;
    expect(set).toBeInstanceOf(Set);
    expect(set?.has("111")).toBe(true);
    expect(set?.has("222")).toBe(true);
  });

  it("rejects a channel name (including the obfuscation sentinel)", () => {
    baseEnv({ DISCORD_ALLOWED_CHANNEL_IDS: DISCORD_HIDDEN_CHANNEL_NAME });
    expect(() => loadConfig()).toThrow(/DISCORD_ALLOWED_CHANNEL_IDS/);
  });

  it("unset ⇒ undefined (no guild-wide channel listing)", () => {
    baseEnv({ DISCORD_ALLOWED_CHANNEL_IDS: undefined });
    expect(loadConfig().DISCORD_ALLOWED_CHANNEL_IDS).toBeUndefined();
  });
});
