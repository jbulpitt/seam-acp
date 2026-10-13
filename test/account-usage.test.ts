import { describe, expect, it, vi } from "vitest";
import { readAccountUsage } from "../packages/adapters/src/account-usage.js";
import { loadHostAdapterInventory } from "../packages/bridge/src/inventory.js";

describe("shared account readers", () => {
  it("uses the owning host's runtime, profile directories, CLI paths and signal for every provider", async () => {
    const readers = Object.fromEntries(["fetchAgyUserStatus", "fetchClaudeUsage", "fetchCodexUsage", "fetchCopilotUsage", "fetchGrokUsage", "fetchGrokUsageFromConnection", "fetchOllamaCloudUsage"].map(name => [name, vi.fn(async () => ({ local: true }))]));
    const signal = new AbortController().signal, agyRuntime = { identityKey: "host-runtime" };
    for (const agentId of ["agy", "claude-work", "codex", "copilot-work", "grok", "ollama-cloud"]) {
      const result = await readAccountUsage({ agentId, profile: { id: agentId, displayName: agentId, configDir: "/host/private-profile" },
        agyRuntime: agyRuntime as never, signal, grokCliPath: "/host/grok", ollamaUsageCliPath: "/host/ollama" }, readers as never);
      expect(result.data).toEqual({ local: true });
    }
    expect(readers.fetchAgyUserStatus).toHaveBeenCalledWith(agyRuntime, signal);
    expect(readers.fetchClaudeUsage).toHaveBeenCalledWith("/host/private-profile");
    expect(readers.fetchCodexUsage).toHaveBeenCalledWith({ signal });
    expect(readers.fetchCopilotUsage).toHaveBeenCalledWith("/host/private-profile", signal);
    expect(readers.fetchGrokUsage).toHaveBeenCalledWith("/host/grok", signal);
    expect(readers.fetchOllamaCloudUsage).toHaveBeenCalledWith("/host/ollama", signal);
  });
  it("the real host inventory account boundary invokes the host's registered Codex account reader", async () => {
    const inventory = loadHostAdapterInventory("copilot", { env: { AGY_ENABLED: "false" }, exists: bin => bin === "codex-acp" });
    const profile = inventory.adapters.get("codex")!;
    const data = { ok: true, plan: "host-plan", primary: null, secondary: null, credits: null };
    const spy = vi.spyOn(profile, "accountUsage").mockResolvedValue(data as never);
    try {
      expect(await inventory.readAccountUsage("codex")).toEqual({ provider: "codex", data });
      expect(spy).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(() => inventory.readAccountUsage("not-configured")).toThrow("unknown agentId: not-configured");
    } finally { spy.mockRestore(); }
  });
});
