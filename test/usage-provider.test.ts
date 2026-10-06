import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageProviderPort } from "../packages/core/src/core/quota/usage-provider.js";
import * as adapters from "@seam/adapters";
import type { AgentProfile, AgyLaunchRuntime } from "@seam/adapters";

vi.mock("@seam/adapters", async importOriginal => ({
  ...await importOriginal<typeof import("@seam/adapters")>(),
  fetchAgyUserStatus: vi.fn(), fetchClaudeUsage: vi.fn(), fetchCodexUsage: vi.fn(), fetchCopilotUsage: vi.fn(),
  fetchGrokUsage: vi.fn(), fetchGrokUsageFromConnection: vi.fn(), fetchOllamaCloudUsage: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const profiles = ["agy", "claude-work", "codex", "copilot-work", "grok", "ollama-cloud", "gemini"].map(id => ({ id, displayName: id, configDir: `/private/${id}` } as AgentProfile));

describe("internal usage-provider port", () => {
  it("passes the verified agy runtime and signal intact; never exposes launch or credentials in binding facts", async () => {
    const runtime = { kind: "verified", csrfToken: "private-csrf" } as unknown as AgyLaunchRuntime;
    const port = createUsageProviderPort({ profiles, agyRuntime: runtime });
    const signal = new AbortController().signal;
    await port.readUsage(port.binding("agy"), signal);
    expect(adapters.fetchAgyUserStatus).toHaveBeenCalledWith(runtime, signal);
    expect(Object.isFrozen(port.binding("agy"))).toBe(true);
    expect(JSON.stringify(port.bindings())).not.toMatch(/private|csrf|configDir|request/);
  });

  it("uses the Grok live connection internally, and its cold path otherwise", async () => {
    const request = vi.fn();
    const port = createUsageProviderPort({ profiles, grokCliPath: "/grok", liveRequest: id => id === "live" ? request : undefined });
    const signal = new AbortController().signal;
    await port.readUsage(port.binding("grok", "live"), signal);
    expect(adapters.fetchGrokUsageFromConnection).toHaveBeenCalledWith(request, signal);
    expect(adapters.fetchGrokUsage).not.toHaveBeenCalled();
    await port.readUsage(port.binding("grok"), signal);
    expect(adapters.fetchGrokUsage).toHaveBeenCalledWith("/grok", signal);
  });

  it("retains the provider account directories, CLI paths and abort signals", async () => {
    const port = createUsageProviderPort({ profiles, ollamaUsageCliPath: "/ollama-usage" });
    const signal = new AbortController().signal;
    for (const id of ["claude-work", "copilot-work", "codex", "ollama-cloud"]) await port.readUsage(port.binding(id), signal);
    expect(adapters.fetchClaudeUsage).toHaveBeenCalledWith("/private/claude-work");
    expect(adapters.fetchCopilotUsage).toHaveBeenCalledWith("/private/copilot-work", signal);
    expect(adapters.fetchCodexUsage).toHaveBeenCalledWith({ signal });
    expect(adapters.fetchOllamaCloudUsage).toHaveBeenCalledWith("/ollama-usage", signal);
    await expect(port.readUsage(port.binding("gemini"))).rejects.toThrow("Agent 'gemini' does not expose usage data");
    await expect(port.readUsage(port.binding("agy"))).rejects.toThrow("configured verified runtime");
  });

  it("reads Codex on the requested host before comparing same-account snapshots across hosts", async () => {
    const signal = new AbortController().signal;
    const read = vi.fn(async (location: string, mode: "live" | "snapshot") => ({
      ok: mode === "snapshot", plan: "pro", primary: {usedPercent: location === "worker" ? 1 : 100, windowMinutes: 10080, resetsAt: 123},
      secondary: null, credits: null, credentialProfile: "account-shared", error: mode === "live" ? "provider socket refused" : undefined,
      source: {kind: mode === "live" ? "live" as const : "rollout" as const, host: location,
        observedAt: location === "worker" ? "2026-10-06T00:05:00Z" : "2026-10-05T23:04:00Z"},
    }));
    const port = createUsageProviderPort({profiles, readCodexHost: read, codexLocations: () => ["local", "worker"]});
    const result = await port.readUsage(port.binding("codex", undefined, "worker"), signal);
    expect(read.mock.calls[0]).toEqual(["worker", "live", signal]);
    expect(result).toMatchObject({provider: "codex", data: {primary: {usedPercent: 1}, source: {host: "worker"}, liveError: "provider socket refused"}});
  });
});
