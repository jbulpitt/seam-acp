import { describe, expect, it } from "vitest";
import os from "node:os";
import { describeProvenanceMode } from "../packages/adapters/src/agy-native-runtime.js";
import { loadHostAdapters } from "../packages/bridge/src/inventory.js";

/**
 * #330. Two failures, one of which took a laptop offline.
 *
 * 1. macOS cannot exec a code-signed Mach-O through `/dev/fd/N`, so the
 *    descriptor-bound provenance route was Linux-only in practice even though
 *    a darwin branch existed.
 * 2. A `strict: true` adapter whose factory threw escaped `loadHostAdapters`
 *    and killed the bridge process. On a multi-agent host that silently lost
 *    one agent; on an agy-only host it was a total outage.
 */
describe("AGY provenance is platform-correct and cannot take down the host (#330)", () => {
  it("reports the mechanism that actually guarantees verified bytes are executed bytes", () => {
    const mode = describeProvenanceMode();
    // Linux keeps the unlinked-descriptor route. Everything else must name the
    // immutable-path route rather than silently claim the descriptor guarantee.
    expect(mode).toBe(process.platform === "linux" ? "descriptor" : "immutable-path");
    expect(["descriptor", "immutable-path"]).toContain(mode);
  });

  it("keeps every other adapter serving when a strict adapter refuses to load", () => {
    const refused: Array<{ agentId: string; reason: string }> = [];

    // AGY_RUNTIME_ROOT does not exist, so the strict agy factory throws during
    // verification — exactly the shape of the macOS provenance failure.
    const adapters = loadHostAdapters("copilot", {
      exists: () => true,
      onAdapterRefused: (agentId, reason) => refused.push({ agentId, reason }),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        AGY_ENABLED: "true",
        AGY_CLI_PATH: "/definitely/missing/agy",
        AGY_DEFAULT_MODEL: "fixture-model",
        AGY_VERSION: "fixture-version",
        AGY_SHA256: "a".repeat(64),
        AGY_RUNTIME_ROOT: "/definitely/missing/runtime",
      },
    });

    // The refusal is recorded and named, not swallowed.
    expect(refused.map((entry) => entry.agentId)).toContain("agy");
    expect(refused[0]?.reason).toMatch(/AGY_RUNTIME_ROOT|sha256|provenance|verification/i);

    // The failing agent is absent...
    expect(adapters.has("agy")).toBe(false);
    // ...and the host still serves its other agents. Deleting the per-adapter
    // isolation makes this line throw instead of fail, which is the outage.
    expect(adapters.size).toBeGreaterThan(0);
    expect(adapters.has("claude")).toBe(true);
  });

  it("does not invent a descriptor path on a platform that cannot exec one", () => {
    // The guarantee is that we never hand a `/dev/fd/N` path to spawn on
    // darwin. `describeProvenanceMode` is the observable proxy for that choice,
    // and it must not report `descriptor` anywhere but linux.
    if (process.platform !== "linux") {
      expect(describeProvenanceMode()).not.toBe("descriptor");
    }
  });
});
