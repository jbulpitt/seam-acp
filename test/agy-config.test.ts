import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agyAcpReleaseArtifact } from "@seam/adapters";
import { loadConfig } from "../packages/core/src/config.js";

describe("package-backed agy configuration gates", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  function base(extra: Record<string, string | undefined> = {}): void {
    process.env = {
      ...saved,
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: process.cwd(),
      CHANNEL_PRESETS_FILE: undefined,
      AGY_ENABLED: "false",
      AGY_OLD_ROLLBACK_ENABLED: "false",
      ...extra,
    } as NodeJS.ProcessEnv;
  }

  function enabled(extra: Record<string, string | undefined> = {}): void {
    base({
      AGY_ENABLED: "true",
      AGY_ACP_BIN: "/opt/agy/antigravity-acp",
      AGY_BIN: "/opt/agy/agy",
      AGY_VERSION: "1.1.28",
      AGY_ACP_VERSION: "1.1.0",
      AGY_ACP_SHA256: agyAcpReleaseArtifact().sha256,
      AGY_ACP_STATE_DIR: path.join(os.homedir(), ".agy-acp"),
      AGY_CONVERSATIONS_DIR: "/srv/agy/conversations",
      AGY_ACP_CWD: "/srv/workspaces",
      AGY_DEFAULT_MODEL: "gemini-3.7-pro-high",
      AGY_CREDENTIAL_SCOPE: "antigravity-oauth:primary",
      AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED: "true",
      ...extra,
    });
  }

  it("keeps both implementations disabled by default", () => {
    base({ AGY_ENABLED: undefined, AGY_OLD_ROLLBACK_ENABLED: undefined });
    const config = loadConfig();
    expect(config.AGY_ENABLED).toBe(false);
    expect(config.AGY_OLD_ROLLBACK_ENABLED).toBe(false);
  });

  it("accepts only the exact reviewed runtime and explicit security acknowledgement", () => {
    enabled();
    expect(loadConfig()).toMatchObject({
      AGY_ENABLED: true,
      AGY_ACP_VERSION: "1.1.0",
      AGY_VERSION: "1.1.28",
      AGY_ACP_SHA256: agyAcpReleaseArtifact().sha256,
      AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED: true,
    });

    enabled({ AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED: "false" });
    expect(() => loadConfig()).toThrow(/dangerously-skip-permissions/);
    enabled({ AGY_ACP_SHA256: "0".repeat(64) });
    expect(() => loadConfig()).toThrow(/reviewed v1\.1\.0/);
    enabled({ AGY_ACP_STATE_DIR: "/tmp/not-wrapper-state" });
    expect(() => loadConfig()).toThrow(/cannot relocate/);
    enabled({ AGY_CREDENTIAL_SCOPE: "person@example.com" });
    expect(() => loadConfig()).toThrow(/semantic identifier/);

    enabled({ AGY_VERSION: "" });
    expect(() => loadConfig()).toThrow(/AGY_VERSION/);
    enabled({ AGY_DEFAULT_MODEL: "" });
    expect(() => loadConfig()).toThrow(/AGY_DEFAULT_MODEL/);
  });

  it("requires a separate exact executable for the legacy rollback", () => {
    base({ AGY_OLD_ROLLBACK_ENABLED: "true", AGY_OLD_CLI_PATH: undefined });
    expect(() => loadConfig()).toThrow(/AGY_OLD_CLI_PATH/);
    base({ AGY_OLD_ROLLBACK_ENABLED: "true", AGY_OLD_CLI_PATH: "/opt/agy/agy-old" });
    expect(loadConfig().AGY_OLD_ROLLBACK_ENABLED).toBe(true);
  });
});
