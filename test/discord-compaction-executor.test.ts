import { describe, expect, it } from "vitest";
import {
  DISCORD_COMPACTION_EXECUTOR_ID,
  DISCORD_COMPACTION_EXECUTOR_LABEL,
  DISCORD_COMPACTION_MODEL,
  DiscordCompactionUnavailableError,
  discordCompactionExecutor,
  isAgyExecutorId,
  isDiscordPremiumCompactAvailable,
  requireExactCatalogModel,
  resolveDiscordCompactionProfile,
} from "../packages/core/src/core/compaction/discord-executor.js";

const agy = { id: "agy" as const, displayName: "Antigravity", sessionManager: { name: "agy-mgr" } };
const dest = { id: "codex" as const, displayName: "Codex", sessionManager: { name: "codex-mgr" } };

describe("Discord premium compaction executor policy", () => {
  it("pins the exact AGY model and label", () => {
    expect(DISCORD_COMPACTION_EXECUTOR_ID).toBe("agy");
    expect(DISCORD_COMPACTION_MODEL).toBe("gemini-3.8-flash-high");
    expect(DISCORD_COMPACTION_MODEL).not.toBe("default");
    expect(DISCORD_COMPACTION_EXECUTOR_LABEL).toBe("AGY · gemini-3.8-flash-high");
    expect(discordCompactionExecutor()).toEqual({
      id: "agy",
      displayName: "AGY",
      model: "gemini-3.8-flash-high",
    });
  });

  it("resolves the AGY profile independently of the destination profile", () => {
    const resolved = resolveDiscordCompactionProfile((id) => {
      if (id === "agy") return agy;
      return dest;
    });
    expect(resolved.profile).toBe(agy);
    expect(resolved.manager).toBe(agy.sessionManager);
    expect(resolved.profile.id).not.toBe(dest.id);
  });

  it("fails closed when AGY is missing, even if a destination profile exists", () => {
    expect(() => resolveDiscordCompactionProfile(() => dest)).toThrow(
      DiscordCompactionUnavailableError
    );
    expect(() => resolveDiscordCompactionProfile(() => dest)).toThrow(/AGY profile/);
  });

  it("fails closed when getProfile('agy') returns a non-AGY profile", () => {
    expect(() => resolveDiscordCompactionProfile(() => dest)).toThrow(/AGY profile/);
  });

  it("fails closed when the AGY session manager is missing", () => {
    expect(() =>
      resolveDiscordCompactionProfile((id) =>
        id === "agy" ? { id: "agy", displayName: "Antigravity" } : undefined
      )
    ).toThrow(/session manager/);
  });

  it("requires the exact live catalog model and does not accept default", () => {
    expect(() =>
      requireExactCatalogModel([{ modelId: "default" }, { modelId: dest.id }])
    ).toThrow(DiscordCompactionUnavailableError);
    expect(() =>
      requireExactCatalogModel([{ modelId: "gemini-3.8-flash-high" }])
    ).not.toThrow();
    expect(() => requireExactCatalogModel([])).toThrow(/live catalog/);
  });

  it("gates Discord premium on AGY, not on the destination compaction model", () => {
    expect(
      isDiscordPremiumCompactAvailable((id) => (id === "agy" ? agy : dest))
    ).toBe(true);
    expect(isDiscordPremiumCompactAvailable(() => dest)).toBe(false);
    expect(
      isDiscordPremiumCompactAvailable((id) =>
        id === "agy" ? { id: "agy", displayName: "Antigravity" } : undefined
      )
    ).toBe(false);
  });

  it("recognizes only AGY executor ids", () => {
    expect(isAgyExecutorId("agy")).toBe(true);
    expect(isAgyExecutorId("codex")).toBe(false);
    expect(isAgyExecutorId("claude")).toBe(false);
    expect(isAgyExecutorId("copilot")).toBe(false);
    expect(isAgyExecutorId("default")).toBe(false);
  });
});
