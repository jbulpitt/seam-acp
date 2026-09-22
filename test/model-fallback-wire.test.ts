import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isModelFallbackPlan, type ModelFallbackPlan } from "@seam/adapters";
import { dispatchBridgeRpc, type SlotSpawnConfig } from "../packages/bridge/src/rpc.js";
import { spawnRemoteSlot, type MuxHandle } from "../packages/core/src/core/remote-spawn.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const plan: ModelFallbackPlan = { version: 1, agentId: "agy", location: "remote", requestedModel: "original",
  requiredContextTokens: 400_000, alternatives: [{ model: "sibling", normalizedModel: "sibling", applicationMode: "live",
    contextWindow: 1_000_000, notice: "intelligence index +0; price 1×" }] };

describe("precomputed model policy wire", () => {
  it("transports the ordered plan into SlotSpawnConfig before releasing ACP stdin, retaining the legacy scalar", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seam-fallback-wire-")); dirs.push(cwd);
    const configured = vi.fn<(slot: number, cfg: SlotSpawnConfig) => void>();
    const child = { slot: 4, kill: vi.fn() };
    const releaseStdin = vi.fn();
    const mux = { spawn: () => child, releaseStdin,
      rpc: async (method: string, params: unknown) => {
        expect(releaseStdin).not.toHaveBeenCalled();
        return dispatchBridgeRpc(method, JSON.parse(JSON.stringify(params)), "agy",
          { adapters: new Map(), cwd, workspaceRoot: cwd, devMode: false, configureSlot: configured });
      },
    } as unknown as MuxHandle;
    await spawnRemoteSlot(mux, { agentId: "agy", model: "original", modelFallbacks: plan, cwd, mcpServers: [] });
    expect(configured).toHaveBeenCalledWith(4, expect.objectContaining({ agentId: "agy", model: "original", modelFallbacks: plan }));
    expect(releaseStdin).toHaveBeenCalledWith(4);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([undefined, { ...plan, version: 2 }, { ...plan, agentId: "other" }, { ...plan, requestedModel: "other" },
    { ...plan, alternatives: [null] }])("mixed-version/malformed policy never refuses the original spawn (%j)", async modelFallbacks => {
    const cwd = mkdtempSync(join(tmpdir(), "seam-fallback-wire-")); dirs.push(cwd);
    const configured = vi.fn();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(dispatchBridgeRpc("spawn", { slot: 1, agentId: "agy", model: "original", modelFallbacks }, "agy",
      { adapters: new Map(), cwd, workspaceRoot: cwd, devMode: false, configureSlot: configured }))
      .resolves.toMatchObject({ ok: true });
    const config = configured.mock.calls[0]![1] as SlotSpawnConfig;
    expect(config.model).toBe("original");
    expect(config.modelFallbacks).toBeUndefined();
    if (modelFallbacks !== undefined) expect(warn).toHaveBeenCalledWith(expect.stringContaining("keeping requested model"));
  });

  it("rejects unbounded/non-data context numbers at the RPC boundary", () => {
    expect(isModelFallbackPlan(plan)).toBe(true);
    expect(isModelFallbackPlan({ ...plan, requiredContextTokens: Infinity })).toBe(false);
    expect(isModelFallbackPlan({ ...plan, requiredContextTokens: -1 })).toBe(false);
  });
});
