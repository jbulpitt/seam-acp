import { describe, expect, it, vi } from "vitest";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";
import { bridgeHello } from "../packages/bridge/src/hello.js";

describe("bridge host account usage RPC", () => {
  it("advertises support without changing the protocol version or durable slot behavior", () => {
    const hello = bridgeHello({ protocolVersion: 1, bridgeId: "worker", instanceId: "one", host: { os: "linux", arch: "x64" }, agents: [] });
    expect(hello.capabilities).toMatchObject({ durableSlots: true, accountUsage: true });
    expect(hello.protocolVersion).toBe(1);
  });
  it("dispatches only to the bridge-local account reader and returns the provider result", async () => {
    const result = { provider: "codex", data: { ok: true, plan: "host-plan", primary: null, secondary: null, credits: null } }, readAccountUsage = vi.fn(async () => result);
    expect(await dispatchBridgeRpc("readAccountUsage", { agentId: "codex" }, undefined, { adapters: new Map(), cwd: "/host", workspaceRoot: "/host", readAccountUsage } as never)).toEqual(result);
    expect(readAccountUsage).toHaveBeenCalledExactlyOnceWith("codex");
  });
  it("preserves a failed host reader's real cause", async () => {
    const error = new Error("RetrieveUserQuotaSummary HTTP 401 (unauthenticated)"), readAccountUsage = vi.fn(async () => { throw error; });
    await expect(dispatchBridgeRpc("readAccountUsage", { agentId: "agy" }, undefined, { adapters: new Map(), cwd: "/host", workspaceRoot: "/host", readAccountUsage } as never)).rejects.toBe(error);
  });
});
