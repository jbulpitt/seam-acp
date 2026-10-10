import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { loadConfig } from "../packages/core/src/config.js";

const base = { DISCORD_BOT_TOKEN: "fixture-token", DISCORD_ALLOWED_USER_IDS: "123", REPOS_ROOT: tmpdir() };

describe("optional Google Chat configuration", () => {
  it("is off by default and retains Discord configuration", () => {
    const config = loadConfig({ env: base }) as any;
    expect(config.GOOGLE_CHAT_PROJECT_ID).toBeUndefined();
    expect(config.GOOGLE_CHAT_ALLOWED_USER_IDS).toEqual(new Set());
    expect(config.DISCORD_ALLOWED_USER_IDS).toEqual(new Set(["123"]));
  });

  it("loads project, subscription, key path, allowed users and default cwd explicitly", () => {
    const config = loadConfig({ env: { ...base, GOOGLE_CHAT_PROJECT_ID: "test-project",
      GOOGLE_CHAT_SUBSCRIPTION: "projects/test-project/subscriptions/events",
      GOOGLE_CHAT_CREDENTIALS_FILE: "/fixture/sa.json", GOOGLE_CHAT_ALLOWED_USER_IDS: "users/42, users/43",
      GOOGLE_CHAT_DEFAULT_CWD: "/fixture/projects" } }) as any;
    expect(config.GOOGLE_CHAT_PROJECT_ID).toBe("test-project");
    expect(config.GOOGLE_CHAT_SUBSCRIPTION).toBe("projects/test-project/subscriptions/events");
    expect(config.GOOGLE_CHAT_CREDENTIALS_FILE).toBe("/fixture/sa.json");
    expect(config.GOOGLE_CHAT_ALLOWED_USER_IDS).toEqual(new Set(["users/42", "users/43"]));
    expect(config.GOOGLE_CHAT_DEFAULT_CWD).toBe("/fixture/projects");
  });
});
