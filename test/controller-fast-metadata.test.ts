import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import * as adapters from "@seam/adapters";
import type { AgentAdapter, AgentClientMetadata, FastModeDescriptor } from "@seam/adapters";
import { inventoryFromAdapters, loadHostAdapterInventory } from "../packages/bridge/src/inventory.js";
import { controllerMetadataAdapter } from "../packages/core/src/agents/controller-metadata.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { RuntimeTransition } from "../packages/core/src/core/runtime-transition.js";
import { installConfigUi } from "../packages/core/src/core/config-ui.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import type { ThreadPreset } from "../packages/core/src/config.js";

const logger = pino({ level: "silent" });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function published(profile: AgentAdapter): AgentClientMetadata {
  return JSON.parse(JSON.stringify(inventoryFromAdapters(new Map([[profile.id, profile]]), process.execPath,
    { HOME: "/fixture/home" })[0]!.metadata));
}

function claudeHost() {
  const make = adapters.makeClaudeProfile;
  // Control only factory inputs; the real loader/factory/inventory publish an unopted variant.
  const factory = vi.spyOn(adapters, "makeClaudeProfile").mockImplementation(options =>
    make({ ...options, directAnthropic: false }));
  try {
    const loaded = loadHostAdapterInventory(process.execPath, {
      env: { HOME: "/fixture/home", AGY_ENABLED: "false", CLAUDE_CLI_PATH: process.execPath },
      exists: binary => binary === process.execPath,
    });
    const profile = loaded.adapters.get("claude")!;
    expect(factory).toHaveBeenCalledOnce();
    expect(profile.fastMode).toBeUndefined();
    return { profile, metadata: published(profile) };
  } finally { factory.mockRestore(); }
}

function fixture(hosts: Record<string, { profile: AgentAdapter; metadata: AgentClientMetadata }>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seam-fast-metadata-"));
  const store = new SessionStore(path.join(directory, "test.db"));
  cleanups.push(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const profiles = Object.values(hosts).map(host => host.profile);
  const profile = profiles[0]!;
  const modelCatalog = fixtureModelCatalog(profiles);
  const threadPresets = new Map<string, ThreadPreset>();
  const router = new SessionRouter({ logger, profiles: [], store, modelCatalog,
    defaultAgentId: profile.id, defaultModel: profile.defaultModel, defaultCwd: directory,
    threadPresets,
    profileMetadata: (id, host) => hosts[host]?.profile.id === id ? hosts[host].metadata : undefined,
    profileCatalog: (id, host) => hosts[host]?.profile.id === id ? hosts[host].profile.catalog : undefined,
  });
  const acquire = vi.spyOn(router, "getOrStartRuntime").mockRejectedValue(new Error("unexpected runtime acquisition"));
  const mutation = { applyThreadOverlay: vi.fn(), applySessionConfig: vi.fn() };
  const transition = new RuntimeTransition({ store, router, modelCatalog, mutation: mutation as never });
  function record(location = "local") {
    threadPresets.set(`thread-${location}`, { location });
    const current = router.ensureSessionRecord({ platform: "discord", channelRef: `thread-${location}`,
      parentRef: "parent", cwd: directory });
    expect(router.describeConfig(current).location.value).toBe(location);
    return store.get(current.id)!;
  }
  return { router, store, modelCatalog, transition, mutation, acquire, record, directory };
}

const refusal = (id: string) => `Refused: agent "${id}" does not declare a Fast-mode option. Nothing was changed.`;

describe("host Fast declaration at production configuration consumers", () => {
  it("does not invent Fast for an unopted real Claude factory after inventory JSON and an empty router", async () => {
    const host = claudeHost();
    const h = fixture({ local: host });
    const record = h.record();
    const before = h.store.get(record.id);
    const prepared = await h.transition.prepareSelection(record, { fastMode: true });
    expect(prepared).toEqual({ ok: false, error: refusal(host.profile.id) });
    expect(await h.transition.configure(record, record, { fastMode: true })).toEqual(prepared);
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.mutation.applyThreadOverlay).not.toHaveBeenCalled();
    expect(h.mutation.applySessionConfig).not.toHaveBeenCalled();
    expect(h.store.get(record.id)).toEqual(before);
    expect(h.store.listConfigMutations()).toEqual([]);
    expect(host.metadata).toHaveProperty("fastMode", null);
    expect(await h.transition.prepareSelection(record, { fastMode: false })).toMatchObject({ ok: true });
  });

  it("renders the no-declaration reason rather than asking an unopted factory to acquire a live Fast session", async () => {
    const host = claudeHost();
    const h = fixture({ local: host });
    const record = h.record();
    const desc = h.router.describeConfig(record);
    const plugins = new PluginHost(logger);
    cleanups.push(() => plugins.dispose());
    const panels: any[] = [];
    const ui = installConfigUi({ plugins, logger, router: h.router, store: h.store, modelCatalog: h.modelCatalog,
      config: { REPOS_ROOT: h.directory } as never,
      plan: () => ({ snapshot: () => ({ desc, channelPins: {}, withoutThread: Object.fromEntries(
        ["agent", "location", "model", "effort", "cwd", "permission", "detached", "fastMode", "statusCardStyle",
          "simpleCardGif", "role", "disableThreadPrefix"].map(key => [key, desc[key as keyof typeof desc] &&
            (desc[key as keyof typeof desc] as { value: unknown }).value])) }) }) as never,
      transport: { sendMessage: vi.fn(), sendPanel: vi.fn(async (_channel, panel) => {
        panels.push(panel); return { id: "own-panel" };
      }) }, canEditChannelPreset: () => true, agentChoices: () => [],
      promptRepoPath: async () => null, rebuild: async () => "unused", codeBlock: text => text,
      repoDisplay: repo => repo ?? "", autocomplete: () => undefined,
      interaction: () => { throw new Error("not a slash invocation"); }, parentChannels: async () => [],
    });
    await ui.ready;
    await ui.open({ platform: "discord", id: record.channelRef, parentId: "parent" }, "owner");
    const panel = panels.at(-1);
    expect(panel.actions.flat().find((action: any) => action.label === "Fast").disabled).toBe(true);
    expect(panel.fields.find((field: any) => field.name === "Fast").value).toContain(refusal(host.profile.id));
    expect(h.acquire).not.toHaveBeenCalled();
  });

  it("keeps same-selector decisions host-local and independent of descriptive identity and other policies", async () => {
    const profile = adapters.makeCodexProfile({ defaultModel: "default" });
    const yes = published(profile), no = published(profile);
    Object.assign(yes, { harness: "unknown", provider: "other", brand: "other", sessionMetaCodec: "unknown", errorClassifier: "unknown" });
    Object.assign(no, { harness: "codex", provider: "openai", fastMode: null });
    const h = fixture({ local: { profile, metadata: yes }, remote: { profile, metadata: no } });
    const local = h.record(), remote = h.record("remote");
    expect(await h.transition.prepareSelection(local, { fastMode: true })).toMatchObject({ ok: true, reset: { sessionReset: false } });
    const denied = { ok: false, error: refusal(profile.id) };
    expect(await h.transition.prepareSelection(remote, { fastMode: true })).toEqual(denied);
    expect(await h.transition.configure(remote, remote, { fastMode: true })).toEqual(denied);
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.router.getProfile(profile.id, "local")!.catalog.scope()).toEqual(profile.catalog.scope());
    expect(h.router.getProfile(profile.id, "remote")!.catalog.scope()).toEqual(profile.catalog.scope());
  });

  it("preserves an opted-in arbitrary factory selector through a real runtime's initial Fast setter", async () => {
    const profile = adapters.makeClaudeProfile({ id: "codex-looking-workbench", defaultModel: "default", directAnthropic: true });
    const metadata = published(profile);
    const h = fixture({ local: { profile, metadata } });
    const record = h.record();
    expect(await h.transition.prepareSelection(record, { fastMode: true })).toMatchObject({ ok: true, reset: { sessionReset: true } });
    const resolved = h.router.getProfile(profile.id)!;
    let enabled = false;
    const configOptions = () => [{ id: "fast", name: "Fast", type: "select", currentValue: enabled ? "on" : "off",
      options: [{ value: "on", name: "On" }, { value: "off", name: "Off" }] }];
    const connection = {
      newSession: vi.fn(async () => ({ sessionId: "own-acp", configOptions: configOptions() })),
      setSessionConfigOption: vi.fn(async (request: { configId: string; value: string }) => {
        enabled = request.value === "on"; return { configOptions: configOptions() };
      }),
    };
    const runtime = new AgentRuntime({ profile: resolved, logger });
    Object.assign(runtime, { connection, promptCapabilities: {} });
    await runtime.newSession({ cwd: h.directory, fastMode: true });
    expect(connection.setSessionConfigOption.mock.calls.map(([request]) => request))
      .toEqual([{ sessionId: "own-acp", configId: "fast", value: "on" }]);
    expect(runtime.getFastModeOutcome()).toEqual({ requested: true, applied: true });
    expect(runtime.getSessionInfo()?.sessionId).toBe("own-acp");
    expect(connection.newSession).toHaveBeenCalledOnce();
  });
});

describe("fieldwise Fast authority and absent-field legacy compatibility", () => {
  const factory = adapters.makeCodexProfile({ defaultModel: "default" });
  const metadata = (fields: Record<string, unknown> = {}): AgentClientMetadata => ({
    displayName: "Fixture", defaultModel: "default", sessionManagement: null, ...fields,
  } as AgentClientMetadata);
  const supplied: FastModeDescriptor = { configId: "owned-fast", onValue: "yes", offValue: "no", applicationMode: "live" };

  it.each([null, undefined])("normalizes own %s to no Fast even with conflicting profile and legacy hints", value => {
    for (const id of ["claude", "claude-alt", "copilot", "codex", "codex-alt", "arbitrary"]) {
      const resolved = controllerMetadataAdapter({ id, catalog: factory.catalog, fastMode: supplied },
        metadata({ fastMode: value, claudeSessionOptions: {} }));
      expect(resolved.fastMode).toBeUndefined();
    }
  });

  it("uses an own descriptor before profile/constants without deriving it from identity or codec", () => {
    const resolved = controllerMetadataAdapter({ id: "claude", catalog: factory.catalog, fastMode: adapters.CLAUDE_FAST_MODE },
      metadata({ fastMode: supplied, harness: "unknown", provider: "unrelated", account: { provenance: "unknown" },
        sessionMetaCodec: null, effort: null, mcpServersAtSpawn: false, submissionSignals: null }));
    expect(resolved.fastMode).toEqual(supplied);
    expect(resolved.effort).toBeUndefined();
    expect(resolved.newSessionMeta).toBeUndefined();
    expect(resolved.submissionSignals).toBeUndefined();
    expect(resolved.mcpServersAtSpawn).toBe(false);
  });

  it.each([
    ["claude", undefined, adapters.CLAUDE_FAST_MODE], ["claude-alt", undefined, undefined],
    ["copilot", undefined, undefined], ["copilotish", undefined, undefined],
    ["codex", undefined, adapters.CODEX_FAST_MODE], ["codex-alt", undefined, undefined],
    ["codexish", undefined, undefined], ["arbitrary", undefined, undefined],
    ["codex", {}, undefined], ["copilot", {}, undefined], ["arbitrary", {}, undefined],
  ] as const)("keeps absent legacy %s / options %s precedence", (id, options, fallback) => {
    const host = metadata(options ? { claudeSessionOptions: options } : {});
    // Other modern declarations must not change whether this particular field is legacy.
    Object.assign(host, { sessionMetaCodec: "unknown", errorClassifier: "unknown", effort: null, submissionSignals: null });
    expect(Object.hasOwn(host, "fastMode")).toBe(false);
    expect(controllerMetadataAdapter({ id, catalog: factory.catalog }, host).fastMode).toEqual(fallback);
    expect(controllerMetadataAdapter({ id, catalog: factory.catalog, fastMode: supplied }, host).fastMode).toEqual(supplied);
    expect(controllerMetadataAdapter({ id, catalog: factory.catalog, fastMode: supplied }).fastMode).toEqual(supplied);
  });

  it("keeps the old partial's inherited-value behavior only when the host has no own field", () => {
    const inherited: FastModeDescriptor = { configId: "inherited-fast", onValue: "on", offValue: "off" };
    const host = Object.assign(Object.create({ fastMode: inherited }), metadata());
    expect(Object.hasOwn(host, "fastMode")).toBe(false);
    for (const id of ["claude", "claude-alt", "codex", "codex-alt"]) {
      expect(controllerMetadataAdapter({ id, catalog: factory.catalog, fastMode: supplied }, host).fastMode).toEqual(inherited);
    }
    for (const id of ["copilot", "copilotish", "other"]) {
      expect(controllerMetadataAdapter({ id, catalog: factory.catalog, fastMode: supplied }, host).fastMode).toEqual(supplied);
    }
  });
});
