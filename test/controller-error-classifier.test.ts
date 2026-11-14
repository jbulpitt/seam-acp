import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import * as adapters from "@seam/adapters";
import type { AgentAdapter, AgentClientMetadata } from "@seam/adapters";
import { loadHostAdapterInventory, inventoryFromAdapters } from "../packages/bridge/src/inventory.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { controllerMetadataAdapter } from "../packages/core/src/agents/controller-metadata.js";
import { DEFAULT_ERROR_RULES } from "../packages/core/src/core/error-resolution-rules.js";

const makeCopilot = adapters.makeCopilotProfile;
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } };
const catalog = adapters.manifestCatalogSource({ provider: "fixture", defaultModel: "fixture", adapterVersion: 4,
  models: () => [{ modelId: "fixture", name: "Fixture" }] });
const metadata = (extra: Record<string, unknown> = {}): AgentClientMetadata => ({
  displayName: "Fixture", defaultModel: "fixture", sessionManagement: null, ...extra,
} as AgentClientMetadata);

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.clearAllMocks());

function copilotHost(id: string, configDir = "/fixture/account-a") {
  // Control factory inputs only; the loader, factory body and inventory stay real.
  const factory = vi.spyOn(adapters, "makeCopilotProfile").mockImplementation(options =>
    makeCopilot({ ...options, id, configDir }));
  try {
    const env = { HOME: "/fixture/home", AGY_ENABLED: "false" };
    const loaded = loadHostAdapterInventory(process.execPath, {
      env, exists: binary => binary === process.execPath,
    });
    const profile = loaded.adapters.get("copilot")!;
    expect(factory).toHaveBeenCalledOnce();
    expect(profile.id).toBe(id);
    // Each owned host map names the selected factory variant, as its hello does.
    const rows = inventoryFromAdapters(new Map([[profile.id, profile]]), process.execPath, env);
    return { profile, metadata: JSON.parse(JSON.stringify(rows[0]!.metadata)) as AgentClientMetadata };
  } finally {
    factory.mockRestore();
  }
}

function routerFor(hosts: Record<string, { profile: AgentAdapter; metadata: AgentClientMetadata }>) {
  return new SessionRouter({
    logger, profiles: [], store: {} as never, defaultAgentId: "fixture", defaultModel: "fixture",
    modelCatalog: { lookup: () => ({}) } as never,
    profileMetadata: (id, host) => hosts[host]?.profile.id === id ? hosts[host].metadata : undefined,
    profileCatalog: (id, host) => hosts[host]?.profile.id === id ? hosts[host].profile.catalog : undefined,
  });
}

async function rejectedSession(profile: AgentAdapter, error: unknown) {
  const newSession = vi.fn().mockRejectedValue(error);
  const runtime = new AgentRuntime({ profile, logger });
  // The ACP response is the controlled boundary; runtime classification is real.
  Object.assign(runtime, { connection: { newSession }, promptCapabilities: {} });
  const thrown: unknown = await runtime.newSession({ cwd: "/fixture" }).catch(reason => reason);
  expect(newSession).toHaveBeenCalledOnce();
  return thrown;
}

const copilotError = () => new RequestError(-32603, "copilot ACP advertised no model config options", { trace: "retained" });

describe("host-declared parser through the loader, router and ACP runtime", () => {
  it.each(["workbench", "claude-looking", "copilot-alternate"])("classifies the actual factory behind %s", async id => {
    const host = copilotHost(id);
    const profile = routerFor({ remote: host }).getProfile(id, "remote")!;
    const original = copilotError();
    const thrown = await rejectedSession(profile, original);
    expect(thrown).toBe(original);
    expect(original.code).toBe(-32603);
    expect(original.data).toMatchObject({ trace: "retained", errorKind: "capability_absent", agentId: id });
    expect(adapters.resolveError(adapters.readErrorClassification(thrown)!, DEFAULT_ERROR_RULES))
      .toMatchObject({ errorKind: "capability_absent", startRung: 2, transience: "terminal" });
    expect(profile.mcpServersAtSpawn).toBe(true);
    expect(profile.fastMode).toBeUndefined();
    expect(profile.catalog.scope()).toEqual(host.profile.catalog.scope());
  });

  it("keeps same-selector parsers host-local and independent of descriptive identity", async () => {
    const first = copilotHost("same-selector", "/fixture/account-a");
    const second = copilotHost("same-selector", "/fixture/account-b");
    first.metadata = metadata({ ...first.metadata, errorClassifier: "copilot" });
    second.metadata = metadata({ ...second.metadata, errorClassifier: "claude" });
    for (const host of [first, second]) Object.assign(host.metadata, {
      harness: "unknown", provider: "same-description", account: { provenance: "unknown" }, brand: "same-logo",
    });
    const router = routerFor({ first, second });
    const native = () => new RequestError(-32603, "Failed to authenticate: OAuth session expired and could not be refreshed");
    const firstError = await rejectedSession(router.getProfile("same-selector", "first")!, native());
    const secondError = await rejectedSession(router.getProfile("same-selector", "second")!, native());
    expect(adapters.readErrorClassification(firstError)).toMatchObject({ errorKind: "unclassified", agentId: "same-selector" });
    expect(adapters.readErrorClassification(secondError)).toMatchObject({ errorKind: "auth_expired", agentId: "same-selector" });
  });
});

describe("explicit modern unknown does not regain a guessed parser", () => {
  it.each(["unknown", null, "future-parser", undefined])("keeps %s unclassified despite selector and supplied function", async reference => {
    const supplied = vi.fn(adapters.classifyCopilotError);
    const profile = controllerMetadataAdapter({ id: "copilot", catalog, classifyError: supplied },
      metadata({ errorClassifier: reference }));
    const original = copilotError();
    expect(await rejectedSession(profile, original)).toBe(original);
    expect(adapters.readErrorClassification(original)).toMatchObject({ errorKind: "unclassified", agentId: "copilot" });
    expect(supplied).not.toHaveBeenCalled();
  });

  it("does not lose an already attached same-selector observation", async () => {
    const profile = controllerMetadataAdapter({ id: "copilot", catalog }, metadata({ errorClassifier: "unknown" }));
    const original = Object.assign(new Error("opaque provider cause"), {
      data: { errorKind: "permission_denied", agentId: "copilot", trace: "preserved", exitCode: 7, signal: null },
    });
    expect(await rejectedSession(profile, original)).toBe(original);
    expect(original.data).toMatchObject({ errorKind: "permission_denied", trace: "preserved", exitCode: 7, signal: null });
  });
});

describe("absent host declaration freezes legacy controller precedence", () => {
  const cases = [
    ["claude", undefined, adapters.classifyClaudeError],
    ["claude-alt", undefined, adapters.classifyClaudeError],
    ["copilot", undefined, adapters.classifyCopilotError],
    ["copilotish", undefined, adapters.classifyCopilotError],
    ["codex", undefined, adapters.classifyCodexError],
    ["codex-alt", undefined, adapters.classifyCodexError],
    ["agy", undefined, adapters.classifyAgyError],
    ["grok", undefined, adapters.classifyGrokError],
    ["grokish", undefined, adapters.classifyGrokError],
    ["copilot", {}, adapters.classifyClaudeError],
    ["codex-alt", {}, adapters.classifyClaudeError],
    ["renamed", {}, adapters.classifyClaudeError],
  ] as const;
  it.each(cases)("keeps legacy %s with options %s", (id, options, parser) => {
    const fallback = vi.fn();
    const profile = controllerMetadataAdapter({ id, catalog, classifyError: fallback },
      metadata(options ? { claudeSessionOptions: options } : {}));
    for (const makeError of [copilotError,
      () => new Error("OAuth session expired and could not be refreshed"),
      () => new Error("agent process exited mid-turn (code=7, signal=null)")]) {
      const expected = parser(makeError(), id);
      expect(profile.classifyError?.(makeError())).toEqual(expected);
    }
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(["renamed", "agy-alt", "codexish"])("retains a supplied %s function without broadening predicates", id => {
    const fallback = vi.fn(() => ({ agentId: id, errorKind: "cancelled" as const }));
    const profile = controllerMetadataAdapter({ id, catalog, classifyError: fallback,
      claudeSessionOptions: { thinkingDisplay: "omitted" } }, metadata());
    const original = new Error("fixture");
    expect(profile.classifyError).toBe(fallback);
    expect(profile.classifyError?.(original)).toMatchObject({ errorKind: "cancelled", agentId: id });
    expect(fallback).toHaveBeenCalledExactlyOnceWith(original);
  });

  it("does not treat a supplied profile reference as a host declaration", () => {
    const supplied = adapters.makeClaudeProfile({ id: "copilot", defaultModel: "fixture" });
    const profile = controllerMetadataAdapter(supplied, metadata());
    expect(profile.classifyError?.(copilotError())).toMatchObject({ errorKind: "capability_absent", agentId: "copilot" });
  });

  it("retains unknown without manufacturing a classifier", () => {
    expect(controllerMetadataAdapter({ id: "unmapped", catalog }, metadata()).classifyError).toBeUndefined();
  });
});

describe("cause and classifier-failure boundaries remain runtime-owned", () => {
  it.each(["primitive", "frozen", "throws"])("preserves %s rejection causes", async shape => {
    const original = shape === "primitive" ? "provider cause" : shape === "frozen"
      ? Object.freeze(new Error("provider cause")) : new Error("provider cause");
    const profile = controllerMetadataAdapter({ id: "unmapped", catalog,
      ...(shape === "throws" ? { classifyError() { throw new Error("classifier bug"); } } : {}) }, metadata());
    const thrown = await rejectedSession(profile, original);
    expect((thrown as Error).message).toBe("provider cause");
    if (shape === "throws") expect(thrown).toBe(original);
    else expect((thrown as Error).cause).toBe(original);
    expect(adapters.readErrorClassification(thrown)).toMatchObject({ errorKind: "unclassified", agentId: "unmapped" });
  });
});
