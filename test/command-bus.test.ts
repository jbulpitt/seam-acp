import { describe, it, expect } from "vitest";
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

  it("protocol version is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
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
