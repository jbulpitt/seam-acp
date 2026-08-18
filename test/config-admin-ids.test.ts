import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

/**
 * SEAM_CONFIG_ADMIN_USER_IDS parsing + compat (#71). It must parse EXACTLY like
 * DISCORD_ALLOWED_USER_IDS but stay OPTIONAL: unset/empty ⇒ undefined (opt-out,
 * NOT "nobody"), so the lock/apply gates preserve today's behavior.
 */
describe("SEAM_CONFIG_ADMIN_USER_IDS parsing (#71)", () => {
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
      // Neutralize any inherited .env pointers that would fail loadConfig for
      // reasons unrelated to this test (this suite only exercises admin-id parsing).
      CHANNEL_PRESETS_FILE: undefined,
      ...extra,
    } as NodeJS.ProcessEnv;
  }

  it("unset ⇒ undefined (opt-out, not an empty deny-all set)", () => {
    baseEnv({ SEAM_CONFIG_ADMIN_USER_IDS: undefined });
    expect(loadConfig().SEAM_CONFIG_ADMIN_USER_IDS).toBeUndefined();
  });

  it("empty string ⇒ undefined (treated as unset, NOT 'nobody')", () => {
    baseEnv({ SEAM_CONFIG_ADMIN_USER_IDS: "" });
    expect(loadConfig().SEAM_CONFIG_ADMIN_USER_IDS).toBeUndefined();
  });

  it("whitespace/trailing commas collapse to undefined", () => {
    baseEnv({ SEAM_CONFIG_ADMIN_USER_IDS: "  , ,  " });
    expect(loadConfig().SEAM_CONFIG_ADMIN_USER_IDS).toBeUndefined();
  });

  it("parses a comma-separated numeric list into a Set", () => {
    baseEnv({ SEAM_CONFIG_ADMIN_USER_IDS: "1487094572696867019, 42 " });
    const set = loadConfig().SEAM_CONFIG_ADMIN_USER_IDS;
    expect(set).toBeInstanceOf(Set);
    expect(set?.has("1487094572696867019")).toBe(true);
    expect(set?.has("42")).toBe(true);
    expect(set?.size).toBe(2);
  });

  it("rejects a non-numeric id (same validation as DISCORD_ALLOWED_USER_IDS)", () => {
    baseEnv({ SEAM_CONFIG_ADMIN_USER_IDS: "not-a-number" });
    expect(() => loadConfig()).toThrow(/SEAM_CONFIG_ADMIN_USER_IDS/);
  });
});
