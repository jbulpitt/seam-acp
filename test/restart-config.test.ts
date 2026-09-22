import { describe, expect, it } from "vitest";
import { loadConfig } from "../packages/core/src/config.js";

describe("RESTART_DRAIN_TIMEOUT_MS", () => {
  let env: Record<string, string | undefined>;

  function baseEnv(value?: string) {
    env = {
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: process.cwd(),
      CHANNEL_PRESETS_FILE: undefined,
      RESTART_DRAIN_TIMEOUT_MS: value,
    } as NodeJS.ProcessEnv;
  }

  it("defaults to fifteen minutes", () => {
    baseEnv(undefined);
    expect(loadConfig({ env }).RESTART_DRAIN_TIMEOUT_MS).toBe(900_000);
  });

  it("accepts an operator override", () => {
    baseEnv("1234");
    expect(loadConfig({ env }).RESTART_DRAIN_TIMEOUT_MS).toBe(1_234);
  });
});
