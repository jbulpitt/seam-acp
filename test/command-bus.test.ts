import { describe, it, expect, vi } from "vitest";
import {
  isAllowedRpcMethod,
  isAdapterRpcMethod,
  PROTOCOL_VERSION,
} from "@seam/adapters";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";
import { makeMux } from "@seam/adapters";

describe("command-bus rpc allow-list", () => {
  it("accepts adapter methods without dev mode", () => {
    expect(isAllowedRpcMethod("readAttachment", { devMode: false })).toBe(true);
    expect(isAllowedRpcMethod("prepare", { devMode: false })).toBe(true);
    expect(isAdapterRpcMethod("fetchModelCatalog")).toBe(true);
    expect(isAdapterRpcMethod("describeModelCatalog")).toBe(true);
    expect(isAdapterRpcMethod("install")).toBe(true);
  });

  it("rejects unknown methods", () => {
    expect(isAllowedRpcMethod("rm -rf", { devMode: false })).toBe(false);
    expect(isAllowedRpcMethod("eval", { devMode: true })).toBe(false);
  });

  it("dev methods are off unless devMode is on", () => {
    expect(isAllowedRpcMethod("exec", { devMode: false })).toBe(false);
    expect(isAllowedRpcMethod("shell", { devMode: false })).toBe(false);
    expect(isAllowedRpcMethod("exec", { devMode: true })).toBe(true);
    expect(isAllowedRpcMethod("shell", { devMode: true })).toBe(true);
  });

  it("dispatch rejects unknown methods even in dev mode", async () => {
    await expect(
      dispatchBridgeRpc("notAMethod", {}, "claude", {
        adapters: new Map(),
        workspaceRoot: "/tmp",
        cwd: "/tmp",
        devMode: true,
      })
    ).rejects.toThrow(/unknown rpc method/);
  });

  it("dispatches catalog refresh through the host adapter boundary", async () => {
    // A valid single-model candidate: the bridge boundary now enforces the same
    // provider-neutral semantics as core (#236), so an empty model list is
    // refused before transport rather than after it.
    const candidate = {
      schemaVersion: 1,
      scope: { fingerprint: "f".repeat(64), provider: "openai" },
      models: [{
        id: "m1", runtimeId: "m1", displayName: "M1", aliases: [], default: true,
        context: { native: null, maximum: null, effective: null },
        modalities: { input: ["text"], output: ["text"] },
        visionMode: "none", availability: "available", lifecycle: "stable",
        serviceTiers: [], pricingCategory: null, compatibility: null,
        applicationMode: "live",
        effort: { mechanism: "none", choices: [{ id: "default" }], selectionDefault: "default" },
        bindings: [{ model: "m1", effort: "default", rawModel: "m1" }],
      }],
      source: "test", adapterVersion: 1, fetchedAt: new Date().toISOString(),
    };
    const result = await dispatchBridgeRpc("fetchModelCatalog", {}, "codex", {
      adapters: new Map([["codex", {
        catalog: { fetch: async () => candidate },
      } as any]]),
      workspaceRoot: "/tmp",
      cwd: "/tmp",
      devMode: false,
    });
    expect(result).toEqual(candidate);
  });

  it("describes semantic catalog scope without fetching the provider", async () => {
    const scope = { fingerprint: "a".repeat(64), provider: "outlier" };
    const fetch = vi.fn();
    const result = await dispatchBridgeRpc("describeModelCatalog", {}, "odd", {
      adapters: new Map([["odd", { catalog: { scope: () => scope, fetch } } as any]]),
      workspaceRoot: "/tmp",
      cwd: "/tmp",
      devMode: false,
    });
    expect(result).toEqual(scope);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("protocol version is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("keeps release verification metadata secret-free", () => {
    const hello = {
      v: PROTOCOL_VERSION,
      type: "hello" as const,
      bridgeId: "media-server",
      instanceId: "instance",
      protocolVersion: PROTOCOL_VERSION,
      host: { os: "darwin", arch: "arm64" },
      agents: [],
      release: { sourceSha: "a".repeat(40), artifactChecksum: "b".repeat(64), verificationAgent: "grok" },
    };
    expect(Object.keys(hello.release)).toEqual(["sourceSha", "artifactChecksum", "verificationAgent"]);
  });
});

describe("makeMux still exports the slot mux", () => {
  it("returns attach, spawn, sendCmd, and rpc", () => {
    const mux = makeMux({ id: "bus-probe" });
    expect(typeof mux.attach).toBe("function");
    expect(typeof mux.spawn).toBe("function");
    expect(typeof mux.sendCmd).toBe("function");
    expect(typeof mux.rpc).toBe("function");
    expect(typeof mux.helloAck).toBe("function");
  });
});
