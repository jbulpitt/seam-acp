import { describe, it, expect, afterEach } from "vitest";
import {
  loadConfig,
  isRestrictedParticipant,
  mayConfigureUserIds,
  adminParticipantOverlapIds,
  PARTICIPANT_CONFIG_REFUSAL,
} from "../packages/core/src/config.js";

/**
 * SEAM_PARTICIPANT_USER_IDS parsing + precedence (#74). Must parse EXACTLY like
 * SEAM_CONFIG_ADMIN_USER_IDS: unset/empty/whitespace ⇒ undefined (opt-out, NOT
 * "nobody"). Admin > participant > operator: an id in both sets is NOT
 * restricted, and the overlap is named so a privilege bug cannot hide.
 */
describe("SEAM_PARTICIPANT_USER_IDS parsing (#74)", () => {
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

  it("unset ⇒ undefined (opt-out, not an empty deny-all set)", () => {
    baseEnv({ SEAM_PARTICIPANT_USER_IDS: undefined });
    expect(loadConfig().SEAM_PARTICIPANT_USER_IDS).toBeUndefined();
  });

  it("empty string ⇒ undefined (treated as unset, NOT 'nobody')", () => {
    baseEnv({ SEAM_PARTICIPANT_USER_IDS: "" });
    expect(loadConfig().SEAM_PARTICIPANT_USER_IDS).toBeUndefined();
  });

  it("whitespace/trailing commas collapse to undefined", () => {
    baseEnv({ SEAM_PARTICIPANT_USER_IDS: "  , ,  " });
    expect(loadConfig().SEAM_PARTICIPANT_USER_IDS).toBeUndefined();
  });

  it("parses a comma-separated numeric list into a Set", () => {
    baseEnv({ SEAM_PARTICIPANT_USER_IDS: "1534937951044112505, 42 " });
    const set = loadConfig().SEAM_PARTICIPANT_USER_IDS;
    expect(set).toBeInstanceOf(Set);
    expect(set?.has("1534937951044112505")).toBe(true);
    expect(set?.has("42")).toBe(true);
    expect(set?.size).toBe(2);
  });

  it("rejects a non-numeric id (same validation as SEAM_CONFIG_ADMIN_USER_IDS)", () => {
    baseEnv({ SEAM_PARTICIPANT_USER_IDS: "not-a-number" });
    expect(() => loadConfig()).toThrow(/SEAM_PARTICIPANT_USER_IDS/);
  });
});

describe("isRestrictedParticipant precedence (#74)", () => {
  const ADMIN = "1487094572696867019";
  const STUDENT = "1534937951044112505";
  const OPERATOR = "111";

  it("unset participant set ⇒ nobody is restricted (byte-identical to today)", () => {
    expect(isRestrictedParticipant(STUDENT, undefined, new Set([ADMIN]))).toBe(false);
    expect(isRestrictedParticipant(ADMIN, undefined, new Set([ADMIN]))).toBe(false);
  });

  it("a participant who is not an admin is restricted", () => {
    expect(isRestrictedParticipant(STUDENT, new Set([STUDENT]), new Set([ADMIN]))).toBe(true);
  });

  it("an admin is never restricted, even when also listed as a participant", () => {
    expect(isRestrictedParticipant(ADMIN, new Set([ADMIN, STUDENT]), new Set([ADMIN]))).toBe(false);
  });

  it("an operator (neither set) is not restricted", () => {
    expect(isRestrictedParticipant(OPERATOR, new Set([STUDENT]), new Set([ADMIN]))).toBe(false);
  });

  it("admin set unset + participant listed ⇒ restricted (admin cannot 'win' if unset)", () => {
    expect(isRestrictedParticipant(STUDENT, new Set([STUDENT]), undefined)).toBe(true);
  });
});

describe("adminParticipantOverlapIds (#74 boot warning input)", () => {
  const ADMIN = "1487094572696867019";
  const STUDENT = "1534937951044112505";

  it("returns [] when either set is unset", () => {
    expect(
      adminParticipantOverlapIds({
        SEAM_CONFIG_ADMIN_USER_IDS: undefined,
        SEAM_PARTICIPANT_USER_IDS: new Set([STUDENT]),
      })
    ).toEqual([]);
    expect(
      adminParticipantOverlapIds({
        SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
        SEAM_PARTICIPANT_USER_IDS: undefined,
      })
    ).toEqual([]);
  });

  it("names every overlapping id (admin wins; boot must warn)", () => {
    expect(
      adminParticipantOverlapIds({
        SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN, "99"]),
        SEAM_PARTICIPANT_USER_IDS: new Set([ADMIN, STUDENT, "99"]),
      })
    ).toEqual(["1487094572696867019", "99"]);
  });

  it("returns [] when the sets are disjoint", () => {
    expect(
      adminParticipantOverlapIds({
        SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
        SEAM_PARTICIPANT_USER_IDS: new Set([STUDENT]),
      })
    ).toEqual([]);
  });
});

describe("mayConfigureUserIds (#74 picker / Apply fallback set)", () => {
  const ADMIN = "1487094572696867019";
  const STUDENT = "1534937951044112505";
  const OPERATOR = "111";
  const allowed = new Set([ADMIN, STUDENT, OPERATOR]);

  it("returns the same DISCORD_ALLOWED_USER_IDS reference when the participant set is unset", () => {
    const out = mayConfigureUserIds({
      DISCORD_ALLOWED_USER_IDS: allowed,
      SEAM_PARTICIPANT_USER_IDS: undefined,
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    });
    expect(out).toBe(allowed);
  });

  it("excludes restricted participants and keeps operators + admins", () => {
    const out = mayConfigureUserIds({
      DISCORD_ALLOWED_USER_IDS: allowed,
      SEAM_PARTICIPANT_USER_IDS: new Set([STUDENT]),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    });
    expect(out.has(STUDENT)).toBe(false);
    expect(out.has(ADMIN)).toBe(true);
    expect(out.has(OPERATOR)).toBe(true);
    expect(out.size).toBe(2);
  });

  it("keeps an overlapping admin+participant in the may-configure set (admin wins)", () => {
    const out = mayConfigureUserIds({
      DISCORD_ALLOWED_USER_IDS: allowed,
      SEAM_PARTICIPANT_USER_IDS: new Set([ADMIN, STUDENT]),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    });
    expect(out.has(ADMIN)).toBe(true);
    expect(out.has(STUDENT)).toBe(false);
  });
});

describe("PARTICIPANT_CONFIG_REFUSAL copy (#74)", () => {
  it("is the friendly refusal, not a lock or a permission-failure", () => {
    expect(PARTICIPANT_CONFIG_REFUSAL).toContain("That's an admin setting");
    expect(PARTICIPANT_CONFIG_REFUSAL).toContain("ask your seam-acp admin");
    expect(PARTICIPANT_CONFIG_REFUSAL.toLowerCase()).not.toContain("permission");
    expect(PARTICIPANT_CONFIG_REFUSAL.toLowerCase()).not.toMatch(/error/);
  });
});
