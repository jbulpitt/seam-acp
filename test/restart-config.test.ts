import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../packages/core/src/config.js";

describe("RESTART_DRAIN_TIMEOUT_MS", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  function baseEnv(value?: string) {
    process.env = {
      ...saved,
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: process.cwd(),
      CHANNEL_PRESETS_FILE: undefined,
      RESTART_DRAIN_TIMEOUT_MS: value,
    } as NodeJS.ProcessEnv;
  }

  it("defaults to fifteen minutes", () => {
    baseEnv(undefined);
    expect(loadConfig().RESTART_DRAIN_TIMEOUT_MS).toBe(900_000);
  });

  it("accepts an operator override", () => {
    baseEnv("1234");
    expect(loadConfig().RESTART_DRAIN_TIMEOUT_MS).toBe(1_234);
  });
});
