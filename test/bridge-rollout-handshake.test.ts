import { describe, expect, it, vi } from "vitest";
import type { HelloFrame } from "@seam/adapters";
import { verifyStagedReleaseCatalogRpcs } from "../packages/core/src/core/bridge-hub.js";

function hello(overrides: Partial<HelloFrame["release"]> = {}): HelloFrame {
  return {
    v: 1,
    type: "hello",
    bridgeId: "media-server",
    instanceId: "new-instance",
    protocolVersion: 1,
    host: { os: "darwin", arch: "x64" },
    agents: [{ agentId: "grok", version: 1, installed: true, ready: false }],
    release: {
      formatVersion: 2,
      activationId: "c".repeat(64),
      stageId: "d".repeat(64),
      bridgeId: "media-server",
      sourceSha: "a".repeat(40),
      artifactChecksum: "b".repeat(64),
      verificationAgent: "grok",
      oldPid: 41,
      pid: 57,
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    },
  };
}

describe("staged bridge handshake verification (#241)", () => {
  it("calls both catalog RPCs directly on the newly connected bridge", async () => {
    const rpc = vi.fn(async () => ({}));
    await expect(verifyStagedReleaseCatalogRpcs(
      hello(),
      new Map([["grok", { installed: true }]]),
      rpc,
    )).resolves.toBe("grok");
    expect(rpc.mock.calls).toEqual([
      ["describeModelCatalog", {}, { agentId: "grok" }],
      ["fetchModelCatalog", {}, { agentId: "grok" }],
    ]);
  });

  it("does not honor malformed release metadata or an unadvertised agent", async () => {
    const rpc = vi.fn(async () => ({}));
    await expect(verifyStagedReleaseCatalogRpcs(
      hello({ sourceSha: "$(bad)" }),
      new Map([["grok", { installed: true }]]),
      rpc,
    )).resolves.toBeNull();
    await expect(verifyStagedReleaseCatalogRpcs(
      hello(),
      new Map(),
      rpc,
    )).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propagates failed RPC verification and does not claim success", async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === "fetchModelCatalog") throw new Error("stale bridge");
      return {};
    });
    await expect(verifyStagedReleaseCatalogRpcs(
      hello(),
      new Map([["grok", { installed: true }]]),
      rpc,
    )).rejects.toThrow(/stale bridge/);
  });
});
