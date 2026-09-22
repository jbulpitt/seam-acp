import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { loadConfig } from "../packages/core/src/config.js";

const fixture = Object.freeze({
  DISCORD_BOT_TOKEN: "fixture-token",
  DISCORD_ALLOWED_USER_IDS: "123",
  REPOS_ROOT: tmpdir(),
});

describe("#495 explicit config inputs", () => {
  it("uses fixture values/defaults and mutates neither the map nor process.env", () => {
    const before = JSON.stringify(process.env);
    const config = loadConfig({ env: fixture });
    expect(config.DISCORD_BOT_TOKEN).toBe("fixture-token");
    expect(config.DISCORD_ALLOWED_USER_IDS).toEqual(new Set(["123"]));
    expect(config.AGENT_LOCATION_DENY).toEqual([]);
    expect(config.channelPresets.size).toBe(0);
    // Compare booleans, never dump the operator's environment on assertion failure.
    expect(JSON.stringify(process.env) === before).toBe(true);
    expect(Object.keys(fixture)).toHaveLength(3);
  });

  it.each(["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USER_IDS", "REPOS_ROOT"] as const)(
    "does not borrow a missing %s from ambient config", key => {
      const env: Record<string, string | undefined> = { ...fixture };
      delete env[key];
      expect(() => loadConfig({ env })).toThrow(key);
    });

  it("uses the explicit HOME even in diagnostics", () => {
    expect(() => loadConfig({ env: { ...fixture, REPOS_ROOT: "/missing/seam-495-repo", HOME: "/fixture-home" } }))
      .toThrow("REPOS_ROOT=/fixture-home/Projects");
  });
});
