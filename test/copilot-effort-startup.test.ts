import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import { RequestError } from "@agentclientprotocol/sdk";
import { makeCopilotProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { controllerMetadataAdapter } from "../packages/core/src/agents/controller-metadata.js";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
const opened: ModelCatalogStore[] = [];
afterEach(() => { for (const store of opened.splice(0)) store.close(); });

const unsupportedEffort = () => new RequestError(-32603,
  "Request session.model.setReasoningEffort failed with message: This model does not support reasoning_effort configuration.",
  { fixtureCause: "native-effort-rejection" });

class AcpBoundary {
  calls: Array<{ configId: string; value: unknown }> = [];
  prompts = 0;
  error?: RequestError;
  reportEffort = true;
  currentModel = "claude-sonnet-5.5";
  currentEffort = "medium";
  options() {
    return [{ id: "model", name: "Model", type: "select", currentValue: this.currentModel,
      options: [{ name: "Current model", value: this.currentModel }] },
    ...(this.reportEffort ? [{ id: "reasoning_effort", name: "Reasoning effort", type: "select",
      currentValue: this.currentEffort,
      options: ["low", "medium", "high", "xhigh", "max"].map(value => ({ name: value, value })) }] : [])];
  }
  async newSession() { return { sessionId: "own-fresh-session", configOptions: this.options(), modes: null }; }
  async loadSession(params: { sessionId: string }) { return { sessionId: params.sessionId, configOptions: this.options(), modes: null }; }
  async setSessionConfigOption(params: { configId: string; value: string }) {
    this.calls.push(params);
    if (params.configId === "reasoning_effort") {
      if (this.error) throw this.error;
      this.currentEffort = params.value;
    } else if (params.configId === "model") this.currentModel = params.value;
    return { configOptions: this.options() };
  }
  async prompt() { this.prompts++; return { stopReason: "end_turn" }; }
  async cancel() {}
}

async function harness(model: string, requestedEffort?: string) {
  const profile = makeCopilotProfile({
    cliPath: process.execPath, defaultModel: "claude-sonnet-5.5",
    catalogProbe: async () => ({ defaultModel: "claude-sonnet-5.5", models: [
      { modelId: "claude-sonnet-5.5", displayName: "Sonnet", effortChoices: ["low", "medium", "high", "xhigh", "max"], effortDefault: "medium", priceCategory: null },
      { modelId: "claude-opus-5.5", displayName: "Opus", effortChoices: ["medium", "high"], effortDefault: "medium", priceCategory: null },
      { modelId: "no-effort", displayName: "No effort", effortChoices: [], effortDefault: "default", priceCategory: null },
    ] }),
  });
  const store = new ModelCatalogStore(":memory:");
  opened.push(store);
  const binding = { agentId: "copilot", location: "local" };
  const catalog = new ModelCatalogService({ store, logger, bindings: () => [binding],
    scope: () => profile.catalog.scope(), fetch: () => profile.catalog.fetch() });
  const publication = await catalog.refresh(binding);
  expect(publication.ok).toBe(true);
  const selected = catalog.resolve(binding, { model, effort: requestedEffort });
  const runtime = new AgentRuntime({ profile: controllerMetadataAdapter(profile), logger,
    effortDescriptor: selected.model?.effort, spawnFn: () => { throw new Error("transport is supplied by this fixture"); } });
  const connection = new AcpBoundary();
  connection.currentModel = model;
  (runtime as unknown as { connection: unknown }).connection = connection;
  (runtime as unknown as { promptCapabilities: unknown }).promptCapabilities = {};
  const input = { cwd: "/fixture", model: selected.raw.model,
    ...(selected.raw.effort ? { effort: selected.raw.effort } : {}) };
  return { runtime, connection, selected, input };
}

describe("Copilot catalog effort through ordinary session startup", () => {
  it.each(["newSession", "loadSession"] as const)("leaves default effort to Copilot before the first prompt after %s", async method => {
    const { runtime, connection, selected, input } = await harness("claude-sonnet-5.5");
    connection.error = unsupportedEffort();
    // CLI1.0.109 advertises medium here even though setting it is rejected.
    if (method === "newSession") await runtime.newSession(input);
    else await runtime.loadSession({ ...input, sessionId: "own-retained-session" });
    await runtime.prompt("ordinary first prompt");
    expect(selected.normalized.effort).toBe("default");
    expect(selected.raw.effort).toBeUndefined();
    expect(connection.calls).toEqual([]);
    expect(connection.prompts).toBe(1);
  });

  it("still applies a supported explicit effort before prompting", async () => {
    const { runtime, connection, input } = await harness("claude-opus-5.5", "high");
    await runtime.newSession(input);
    await runtime.prompt("ordinary requested effort");
    expect(connection.calls).toEqual([{ sessionId: "own-fresh-session", configId: "reasoning_effort", value: "high" }]);
    expect(connection.currentEffort).toBe("high");
    expect(connection.prompts).toBe(1);
  });

  it("preserves native rejection for an explicit effort without sending a prompt", async () => {
    const { runtime, connection, input } = await harness("claude-sonnet-5.5", "medium");
    const original = unsupportedEffort();
    connection.error = original;
    const error = await runtime.newSession(input).catch(error => error);
    expect(error).toBe(original);
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("This model does not support reasoning_effort configuration.");
    expect(error.data.fixtureCause).toBe("native-effort-rejection");
    expect(connection.calls).toHaveLength(1);
    expect(connection.prompts).toBe(0);
  });

  it("does not infer unsupported effort from omitted live options", async () => {
    const { runtime, connection, input } = await harness("claude-opus-5.5", "high");
    connection.reportEffort = false;
    await runtime.newSession(input);
    expect(connection.calls).toHaveLength(1);
    expect(connection.calls[0]?.value).toBe("high");
  });

  it("preserves the existing no-effort capability", async () => {
    const { runtime, connection, selected, input } = await harness("no-effort");
    connection.reportEffort = false;
    await runtime.newSession(input);
    await runtime.prompt("ordinary no-effort model");
    expect(selected.model?.effort.mechanism).toBe("none");
    expect(connection.calls).toEqual([]);
    expect(connection.prompts).toBe(1);
  });

  it("forwards a model unknown to the catalog", async () => {
    const { runtime, connection, selected, input } = await harness("unknown-native-model");
    connection.currentModel = "claude-sonnet-5.5";
    await runtime.newSession(input);
    expect(selected.model).toBeNull();
    expect(connection.calls).toEqual([{ sessionId: "own-fresh-session", configId: "model", value: "unknown-native-model" }]);
  });
});
