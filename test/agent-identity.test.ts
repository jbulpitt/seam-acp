import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { makeClaudeProfile, makeCodexProfile, makeCopilotProfile, makeGrokProfile, makeAgyProfile,
  asRemoteCatalogAdapter, manifestCatalogScope, manifestCatalogSource, type AgentAdapter } from "@seam/adapters";
import { inventoryFromAdapters } from "../packages/bridge/src/inventory.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { WarmSetManager } from "../packages/core/src/core/warm-set/manager.js";
import { createCardVisualsPlugin } from "../packages/core/src/plugins/card-visuals/index.js";
import { createOrdinaryAgyFixture } from "./helpers/agy-runtime-fixture.js";
import { holdingMb, loadCost } from "../packages/core/src/core/warm-set/footprint.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { StatusCardRegistry } from "../packages/core/src/plugins/status-card-registry.js";

const logger = pino({ level: "silent" });

function controller(hostProfile: AgentAdapter) {
  const inventory = inventoryFromAdapters(new Map([[hostProfile.id, hostProfile]]), process.execPath);
  const metadata = inventory[0]!.metadata;
  return Object.assign(Object.create(SessionRouter.prototype), {
    profileById: new Map(),
    profileMetadata: (id: string, host: string) => id === hostProfile.id && host === "fixture-host" ? metadata : undefined,
    profileCatalog: () => hostProfile.catalog,
    modelCatalog: { lookup: () => ({}) },
  }) as SessionRouter;
}

describe("host-owned agent identity", () => {
  it("renders Z.ai's service and warms its Claude harness through the production boundaries", async () => {
    const host = makeClaudeProfile({
      id: "zai", provider: "z-ai", brand: "z-ai", cliPath: process.execPath,
      defaultModel: "fixture-model", staticModels: [{ modelId: "fixture-model", name: "Fixture" }],
      extraEnv: { ANTHROPIC_BASE_URL: "https://fixture.invalid" },
    });
    const router = controller(host);
    const profile = router.getProfile("zai", "fixture-host")!;
    const plugin = createCardVisualsPlugin({} as never);
    await plugin.activate!({ config: { BRAND_ICON_BASE_URL: "https://icons.invalid" }, logger } as never);
    const facts = { state: "Working", agentId: profile.id, profileBrand: profile.brand,
      provider: profile.provider, model: "fixture-model", style: "full", gifOn: false } as const;
    const visuals = plugin.contributions!.statusCards![0]!.decorate(facts, {} as never);
    expect(visuals.icon).toBe("https://icons.invalid/z-ai.webp");
    const record = { id: "discord:fixture", channelRef: "fixture", platform: "discord", agentId: "zai",
      acpSessionId: "fixture-acp", configJson: "{}", updatedUtc: "2026-11-13T00:00:00.000Z" };
    const resume = vi.fn(async () => {});
    const manager = new WarmSetManager({
      logger, store: { listSessionsUncapped: () => [record], get: () => record } as never,
      router: { getProfile: (id, location) => router.getProfile(id, location), hasRuntime: () => false,
        turnHealth: () => ({ busy: false, silentMs: 0, stalled: false }), getRuntime: () => undefined,
        isBusy: () => false, resumeExistingSession: resume, invalidate: vi.fn() },
      hub: { isBridgeReady: () => true }, threadPresets: new Map([["fixture", { location: "fixture-host" }]]),
      hosts: [{ id: "fixture-host", budgetMb: 680 }], intervalMs: 60_000, maxConcurrent: 1,
    });
    await manager.tick();
    expect(resume).toHaveBeenCalledExactlyOnceWith(record);
    await plugin.dispose?.();
  });

  it("keeps arbitrary selectors out of provider brands and measured harness costs", async () => {
    const profiles = [
      [makeClaudeProfile({ id: "renamed-route", provider: "z-ai", defaultModel: "fixture" }), "claude", "z-ai", 680, "low"],
      [makeCodexProfile({ id: "claude-looking", provider: "ollama-cloud", defaultModel: "fixture",
        modelsCachePath: "/fixture/models.json" }), "codex", "ollama-cloud", 380, "high"],
      [makeCopilotProfile({ id: "codex-looking", defaultModel: "fixture", configDir: "/fixture/work" }), "copilot", "github-copilot", null, "low"],
    ] as const;
    const plugin = createCardVisualsPlugin({} as never);
    await plugin.activate!({ config: { BRAND_ICON_BASE_URL: "https://icons.invalid" }, logger } as never);
    for (const [host, harness, provider, mb, cost] of profiles) {
      const remote = controller(host).getProfile(host.id, "fixture-host")!;
      expect(remote).toMatchObject({ id: host.id, harness, provider, account: { provenance: "configured-context" } });
      expect(holdingMb(remote.harness)).toBe(mb);
      expect(loadCost(remote.harness)).toBe(cost);
      const icon = plugin.contributions!.statusCards![0]!.decorate({
        state: "Working", agentId: remote.id, provider: remote.provider, profileBrand: remote.brand,
        model: "fixture", style: "full", gifOn: false,
      }, {} as never).icon;
      expect(icon).toBe(`https://icons.invalid/${provider === "github-copilot" ? "copilot" : provider}.webp`);
    }
    await plugin.dispose?.();
  });

  it("carries AGY factory metadata from a controlled fixture without a provider session", () => {
    const fixture = createOrdinaryAgyFixture({ baseEnv: { HOME: process.cwd() }, credentialScope: "antigravity-oauth:fixture" });
    try {
      const host = makeAgyProfile({ runtime: fixture.runtime, defaultModel: "fixture",
        dataDir: `${fixture.executable}-state`, initialSettingsFile: `${fixture.executable}-settings` });
      expect(controller(host).getProfile("agy", "fixture-host")).toMatchObject({
        harness: "agy", provider: "google-antigravity", account: { provenance: "configured-context" },
      });
    } finally { fixture.cleanup(); }
  });

  it.each([false, true])("does not borrow controller-local identity for a legacy host (hello=%s)", hello => {
    const local = makeClaudeProfile({ id: "claude", directAnthropic: true,
      brand: "local-logo", defaultModel: "fixture", configDir: "/private/local-fixture" });
    const router = controller(local);
    Object.assign(router, {
      profileById: new Map([["claude", local]]),
      profileMetadata: () => hello ? { displayName: "Legacy host", defaultModel: "fixture", sessionManagement: null } : undefined,
    });
    const remote = router.getProfile("claude", "fixture-host")!;
    expect(remote).toMatchObject({ harness: "unknown", provider: "unknown", account: { provenance: "unknown" } });
    expect(remote.brand).toBeUndefined();
    expect(remote.defaultModel).toBe("fixture");
    expect(holdingMb(remote.harness)).toBeNull();
    if (!hello) expect(remote.spawn).toBe(local.spawn);
  });

  it("keeps cache-only identity unknown even when the catalog provider is known", async () => {
    const candidate = await manifestCatalogSource({ provider: "anthropic", defaultModel: "fixture",
      models: () => [{ modelId: "fixture", name: "Fixture" }], adapterVersion: 4 }).fetch();
    const profile = asRemoteCatalogAdapter("claude", candidate);
    expect(profile).toMatchObject({ harness: "unknown", provider: "unknown", account: { provenance: "unknown" } });
    expect(profile.catalog.scope()).toEqual(candidate.scope);
    expect(profile.defaultModel).toBe("fixture");
  });

  it("renders configuration confirmation using the selected host's provider", async () => {
    const local = makeClaudeProfile({ id: "same-selector", directAnthropic: true, defaultModel: "fixture" });
    const remote = makeClaudeProfile({ id: "same-selector", provider: "z-ai", defaultModel: "fixture" });
    const metadata = [local, remote].map(profile => inventoryFromAdapters(new Map([[profile.id, profile]]), process.execPath)[0]!.metadata);
    const router = controller(remote);
    Object.assign(router, { profileById: new Map([[local.id, local]]),
      profileMetadata: (_id, location) => metadata[location === "fixture-host" ? 1 : 0] });
    const plugin = createCardVisualsPlugin({} as never);
    await plugin.activate!({ config: { BRAND_ICON_BASE_URL: "https://icons.invalid" }, logger } as never);
    const statusCards = new StatusCardRegistry(logger);
    statusCards.register(plugin.id, plugin.contributions!.statusCards!, {} as never);
    const sendPanel = vi.fn(async () => ({}));
    const orchestrator = Object.assign(Object.create(Orchestrator.prototype), {
      router, plugins: { statusCards }, adapter: { sendPanel }, logger,
    }) as Orchestrator;
    const unchanged = { before: "fixture", after: "fixture", changed: false };
    const result = await orchestrator.presentThreadConfigurationChange({ channelRef: "caller" } as never,
      { channelRef: "target", platform: "discord" } as never, {
        applied: { agent: remote.id, model: "fixture", location: "fixture-host" },
        changes: { agent: unchanged, model: unchanged, effort: unchanged, role: unchanged,
          disableThreadPrefix: unchanged, fastMode: unchanged }, warnings: [],
        ok: true, sessionReset: false, runtimeReloaded: false,
      });
    expect(result.confirmationPosted).toBe(true);
    expect(sendPanel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ authorIconURL: "https://icons.invalid/z-ai.webp" }));
    await plugin.dispose?.();
  });

  it("updates Grok context only through its existing scope/fetch observations", async () => {
    let fingerprint = "a".repeat(64);
    const identity = vi.fn(() => ({ source: "api-key" as const, fingerprint }));
    const host = makeGrokProfile({ defaultModel: "fixture", catalogMode: "api-key", apiKey: "fixture-key",
      authIdentityProbe: identity, cliVersionProbe: async () => "fixture-1",
      discoverModels: async () => [{ modelId: "fixture", name: "Fixture" }],
    });
    expect(host.account).toEqual({ provenance: "unknown" });
    expect(identity).not.toHaveBeenCalled();
    const first = controller(host).getProfile("grok", "fixture-host")!;
    expect(first.account).toEqual({ provenance: "observed-context", contextKey: "a".repeat(64) });
    expect(identity).toHaveBeenCalledTimes(1);
    fingerprint = "b".repeat(64);
    const candidate = await host.catalog.fetch();
    expect(host.account).toEqual({ provenance: "observed-context", contextKey: fingerprint });
    expect(identity).toHaveBeenCalledTimes(2);
    expect(first.account.contextKey).toBe("a".repeat(64));
    expect(controller(host).getProfile("grok", "fixture-host")!.account.contextKey).toBe(fingerprint);
    const reads = identity.mock.calls.length;
    holdingMb(host.harness);
    loadCost(host.harness);
    void host.account;
    expect(identity).toHaveBeenCalledTimes(reads);
    expect(candidate.scope.fingerprint).not.toBe(fingerprint);
  });

  it("preserves the catalog's exact identity inputs independently of display identity", () => {
    const variants = [
      { provider: "anthropic", directAnthropic: true },
      { provider: "anthropic", directAnthropic: true, configDir: "/credentials/work" },
      { provider: "vertex", extraEnv: { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "project-7", CLOUD_ML_REGION: "us-east5" } },
      { provider: "z-ai", extraEnv: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } },
    ];
    const scopes = variants.map(variant => {
      const host = makeClaudeProfile({ ...variant, id: "unrelated-selector", brand: "custom-logo", defaultModel: "fixture" });
      const expected = manifestCatalogScope({ provider: variant.provider,
        backend: variant.provider === "vertex" ? "vertex" : variant.extraEnv?.ANTHROPIC_BASE_URL,
        credentialProfile: variant.configDir ?? "default",
        project: variant.extraEnv?.ANTHROPIC_VERTEX_PROJECT_ID, region: variant.extraEnv?.CLOUD_ML_REGION,
      });
      expect(host.catalog.scope().fingerprint).toBe(expected.fingerprint);
      expect(host.catalog.scope().provider).toBe(variant.provider);
      const remote = controller(host).getProfile(host.id, "fixture-host")!;
      expect(remote.brand).toBe("custom-logo");
      expect(JSON.stringify(remote.account)).not.toContain("/credentials");
      return host.catalog.scope().fingerprint;
    });
    expect(new Set(scopes).size).toBe(4);
  });

  it("keeps busy unknown work owned while leaving cold unknown contexts alone", async () => {
    const records = ["busy", "cold"].map(channelRef => ({ id: `discord:${channelRef}`, channelRef,
      platform: "discord", agentId: "claude", acpSessionId: "fixture", configJson: "{}", updatedUtc: "2026-11-13T00:00:00.000Z" }));
    const invalidate = vi.fn(), resume = vi.fn();
    const manager = new WarmSetManager({
      logger, store: { listSessionsUncapped: () => records, get: id => records.find(r => r.id === id) } as never,
      router: { getProfile: () => undefined, hasRuntime: id => id === "discord:busy",
        turnHealth: id => ({ busy: id === "discord:busy", silentMs: 0, stalled: false }),
        getRuntime: () => ({ markActivity() {} }), isBusy: () => true,
        resumeExistingSession: resume, invalidate },
      hub: { isBridgeReady: () => true }, threadPresets: new Map(records.map(r => [r.channelRef, { location: "fixture-host" }])),
      hosts: [{ id: "fixture-host", budgetMb: 0 }], intervalMs: 60_000, maxConcurrent: 1,
    });
    await manager.tick();
    expect(invalidate).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});
