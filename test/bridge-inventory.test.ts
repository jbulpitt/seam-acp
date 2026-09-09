import { afterEach, describe, it, expect, vi } from "vitest";
import { inventoryFromAdapters, loadHostAdapters } from "../packages/bridge/src/inventory.js";
import { agyAcpReleaseArtifact } from "@seam/adapters";

afterEach(() => vi.unstubAllEnvs());

describe("loadHostAdapters", () => {
  it("skips adapters whose CLI is not on PATH (agy must not spawn ENOENT)", () => {
    const adapters = loadHostAdapters("copilot", (bin) => bin === "copilot");
    expect([...adapters.keys()]).toEqual(["copilot"]);
    expect(adapters.has("agy")).toBe(false);
  });

  it("keeps legacy disabled and advertises exact package runtime only when fully acknowledged", () => {
    vi.stubEnv("AGY_ENABLED", "true");
    vi.stubEnv("AGY_ACP_BIN", "/opt/agy/antigravity-acp");
    vi.stubEnv("AGY_BIN", "/opt/agy/agy");
    vi.stubEnv("AGY_VERSION", "1.1.28");
    vi.stubEnv("AGY_SHA256", "a".repeat(64));
    vi.stubEnv("AGY_DEFAULT_MODEL", "gemini-high");
    vi.stubEnv("AGY_ACP_VERSION", "1.1.0");
    vi.stubEnv("AGY_ACP_SHA256", agyAcpReleaseArtifact().sha256);
    vi.stubEnv("AGY_CONVERSATIONS_DIR", "/srv/agy/conversations");
    vi.stubEnv("AGY_ACP_CWD", "/srv/workspaces");
    vi.stubEnv("AGY_CREDENTIAL_SCOPE", "antigravity-oauth:test");
    vi.stubEnv("AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED", "true");
    vi.stubEnv("AGY_OLD_ROLLBACK_ENABLED", "false");
    const adapters = loadHostAdapters("copilot", () => true);
    expect(adapters.has("agy")).toBe(true);
    expect(adapters.has("agy-old")).toBe(false);
    const row = inventoryFromAdapters(adapters, "copilot").find((item) => item.agentId === "agy");
    expect(row?.runtime).toMatchObject({
      executable: "/opt/agy/antigravity-acp",
      cwd: "/srv/workspaces",
      environment: {
        AGY_BIN: "/opt/agy/agy",
        AGY_SKIP_DOWNLOAD: "1",
        AGY_CONVERSATIONS_DIR: "/srv/agy/conversations",
      },
      credentialScope: "antigravity-oauth:test",
    });
  });

  it("registers agy-old only under the explicit rollback gate", () => {
    vi.stubEnv("AGY_OLD_ROLLBACK_ENABLED", "true");
    vi.stubEnv("AGY_OLD_CLI_PATH", "/opt/agy/agy-old");
    const adapters = loadHostAdapters("copilot", () => true);
    expect(adapters.has("agy-old")).toBe(true);
    expect(adapters.has("agy")).toBe(false);
  });
});
