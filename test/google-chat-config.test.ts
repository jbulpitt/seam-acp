import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { loadConfig, PresetsFileSchema } from "../packages/core/src/config.js";

const base = { DISCORD_BOT_TOKEN: "fixture-token", DISCORD_ALLOWED_USER_IDS: "123", REPOS_ROOT: tmpdir() };

describe("optional Google Chat configuration", () => {
  it("is off by default and retains Discord configuration", () => {
    const config = loadConfig({ env: base }) as any;
    expect(config.GOOGLE_CHAT_PROJECT_ID).toBeUndefined();
    expect(config.GOOGLE_CHAT_DEFAULT_LOCATION).toBe("local");
    expect(config.GOOGLE_CHAT_ALLOWED_USER_IDS).toEqual(new Set());
    expect(config.GOOGLE_CHAT_ALLOWED_SPACE_IDS).toEqual(new Set());
    expect(config.DISCORD_ALLOWED_USER_IDS).toEqual(new Set(["123"]));
  });

  it("loads project, subscription, key path, allowed users and default cwd explicitly", () => {
    const config = loadConfig({ env: { ...base, GOOGLE_CHAT_PROJECT_ID: "test-project",
      GOOGLE_CHAT_SUBSCRIPTION: "projects/test-project/subscriptions/events",
      GOOGLE_CHAT_CREDENTIALS_FILE: "/fixture/sa.json", GOOGLE_CHAT_ALLOWED_USER_IDS: "users/42, users/43",
      GOOGLE_CHAT_DEFAULT_CWD: "/fixture/projects", GOOGLE_CHAT_DEFAULT_LOCATION: "remote" } }) as any;
    expect(config.GOOGLE_CHAT_PROJECT_ID).toBe("test-project");
    expect(config.GOOGLE_CHAT_SUBSCRIPTION).toBe("projects/test-project/subscriptions/events");
    expect(config.GOOGLE_CHAT_CREDENTIALS_FILE).toBe("/fixture/sa.json");
    expect(config.GOOGLE_CHAT_ALLOWED_USER_IDS).toEqual(new Set(["users/42", "users/43"]));
    expect(config.GOOGLE_CHAT_DEFAULT_CWD).toBe("/fixture/projects");
    expect(config.GOOGLE_CHAT_DEFAULT_LOCATION).toBe("remote");
  });

  it("loads the requested shared-space allowlist without changing the per-user list", () => {
    const config = loadConfig({ env: { ...base, GOOGLE_CHAT_ALLOWED_SPACE_IDS: "spaces/team, other, spaces/team, ",
      GOOGLE_CHAT_ALLOWED_USER_IDS: "users/42" } }) as any;
    expect(config.GOOGLE_CHAT_ALLOWED_SPACE_IDS).toEqual(new Set(["spaces/team", "other"]));
    expect(config.GOOGLE_CHAT_ALLOWED_USER_IDS).toEqual(new Set(["users/42"]));
  });

  it("accepts an explicitly qualified flat Chat session overlay without accepting nonnumeric Discord keys", () => {
    const overlay = { agent: { value: "codex" } };
    expect(PresetsFileSchema.safeParse({ threads: { "google-chat:team": overlay } }).success).toBe(true);
    for (const key of ["team", "discord:team", "google-chat:team.", "google-chat:team.thread.extra"]) {
      expect(PresetsFileSchema.safeParse({ threads: { [key]: overlay } }).success).toBe(false);
    }
    expect(PresetsFileSchema.safeParse({ threads: { "123456789012345678": overlay } }).success).toBe(true);
  });
});
