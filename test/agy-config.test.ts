import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../packages/core/src/config.js";

describe("package-backed agy configuration gates", () => {
  let env: Record<string, string | undefined>;

  function base(extra: Record<string, string | undefined> = {}): void {
    env = {
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: process.cwd(),
      CHANNEL_PRESETS_FILE: undefined,
      AGY_ENABLED: "false",
      AGY_NATIVE_RESTORE: "false",
      AGY_OLD_ROLLBACK_ENABLED: "false",
      ...extra,
    } as NodeJS.ProcessEnv;
  }

  function enabled(extra: Record<string, string | undefined> = {}): void {
    base({
      AGY_ENABLED: "true",
      AGY_CLI_PATH: "/opt/agy/runtime/" + "a".repeat(64) + "/agy",
      AGY_BIN: undefined,
      AGY_VERSION: "1.1.28",
      AGY_SHA256: "a".repeat(64),
      AGY_RUNTIME_ROOT: "/opt/agy/runtime",
      AGY_ACP_STATE_DIR: path.join(os.homedir(), ".agy-acp"),
      AGY_CONVERSATIONS_DIR: "/srv/agy/conversations",
      AGY_DEFAULT_MODEL: "gemini-3.7-pro-high",
      AGY_CREDENTIAL_SCOPE: "antigravity-oauth:primary",
      ...extra,
    });
  }

  it("keeps native agy disabled by default", () => {
    base({ AGY_ENABLED: undefined, AGY_OLD_ROLLBACK_ENABLED: undefined });
    const config = loadConfig({ env });
    expect(config.AGY_ENABLED).toBe(false);
    expect(config.AGY_OLD_ROLLBACK_ENABLED).toBe(false);
  });

  it("accepts only the exact native runtime", () => {
    enabled();
    expect(loadConfig({ env })).toMatchObject({
      AGY_VERSION: "1.1.28",
      AGY_SHA256: "a".repeat(64),
      AGY_RUNTIME_ROOT: "/opt/agy/runtime",
    });

    enabled({ AGY_CREDENTIAL_SCOPE: "person@example.com" });
    expect(() => loadConfig({ env })).toThrow(/semantic identifier/);

    enabled({ AGY_VERSION: "" });
    expect(() => loadConfig({ env })).toThrow(/AGY_VERSION/);
    enabled({ AGY_SHA256: "" });
    expect(() => loadConfig({ env })).toThrow(/AGY_SHA256/);
    enabled({ AGY_DEFAULT_MODEL: "" });
    expect(() => loadConfig({ env })).toThrow(/AGY_DEFAULT_MODEL/);
  });

  it("does not treat missing pins as unpinned", () => {
    enabled({ AGY_SHA256: "", AGY_VERSION: "", AGY_RUNTIME_ROOT: undefined });
    expect(() => loadConfig({ env })).toThrow(/does not unpin agy/);
    expect(() => loadConfig({ env })).toThrow(/AGY_PIN=unpinned/);
  });

  it("accepts AGY_PIN=unpinned without a digest and refuses a pin left beside it", () => {
    enabled({
      AGY_PIN: "unpinned",
      AGY_CLI_PATH: undefined,
      AGY_BIN: undefined,
      AGY_OLD_CLI_PATH: undefined,
      AGY_SHA256: "",
      AGY_VERSION: "",
      AGY_RUNTIME_ROOT: undefined,
    });
    expect(loadConfig({ env })).toMatchObject({ AGY_PIN: "unpinned", AGY_ENABLED: true });
    enabled({ AGY_PIN: "unpinned", AGY_SHA256: "a".repeat(64) });
    expect(() => loadConfig({ env })).toThrow(/AGY_SHA256/);
    expect(() => loadConfig({ env })).toThrow(/snapshot/);
  });

  it("requires an explicit native path and default model", () => {
    base({ AGY_ENABLED: "true", AGY_CLI_PATH: undefined, AGY_OLD_CLI_PATH: undefined, AGY_BIN: undefined });
    expect(() => loadConfig({ env })).toThrow(/AGY_CLI_PATH/);
    base({ AGY_ENABLED: "true", AGY_CLI_PATH: "/opt/agy/runtime/" + "a".repeat(64) + "/agy", AGY_BIN: undefined, AGY_DEFAULT_MODEL: "gemini-high", AGY_VERSION: "1.1.28", AGY_SHA256: "a".repeat(64), AGY_RUNTIME_ROOT: "/opt/agy/runtime" });
    expect(loadConfig({ env })).toMatchObject({ AGY_ENABLED: true, AGY_CLI_PATH: "/opt/agy/runtime/" + "a".repeat(64) + "/agy" });
    base({ AGY_OLD_ROLLBACK_ENABLED: "true", AGY_OLD_CLI_PATH: "/opt/agy/runtime/" + "a".repeat(64) + "/agy", AGY_BIN: undefined, AGY_DEFAULT_MODEL: "gemini-high", AGY_CLI_PATH: undefined, AGY_VERSION: "1.1.28", AGY_SHA256: "a".repeat(64), AGY_RUNTIME_ROOT: "/opt/agy/runtime" });
    expect(loadConfig({ env }).AGY_OLD_ROLLBACK_ENABLED).toBe(true);
  });
});
