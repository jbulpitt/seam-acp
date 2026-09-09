import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  makeGrokProfile,
  parseGrokModelsOutput,
  parseGrokModelState,
  probeGrokCatalog,
  probeGrokModels,
  type GrokCatalogProbe,
} from "@seam/adapters";
import {
  ModelCatalogService,
  validateCandidate,
} from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";

const MODEL_STATE = {
  currentModelId: "grok-4.6",
  availableModels: [
    {
      modelId: "grok-4.6",
      name: "Grok 4.6",
      description: "SpaceXAI's latest frontier model",
      _meta: {
        totalContextTokens: 500_000,
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          { id: "xhigh", value: "xhigh", label: "Extra High Effort", description: "Highest effort", default: false },
          { id: "high", value: "high", label: "High Effort", description: "Extensive reasoning", default: true },
          { id: "medium", value: "medium", label: "Medium Effort", description: "Balanced", default: false },
          { id: "low", value: "low", label: "Low Effort", description: "Quick", default: false },
        ],
      },
    },
    {
      modelId: "grok-4.5",
      name: "Grok 4.5",
      _meta: {
        totalContextTokens: 500_000,
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          { id: "high", value: "high", label: "High Effort", default: true },
          { id: "medium", value: "medium", label: "Medium Effort", default: false },
          { id: "low", value: "low", label: "Low Effort", default: false },
        ],
      },
    },
  ],
};

function subscriptionProbe(): GrokCatalogProbe {
  return {
    ...parseGrokModelState(MODEL_STATE),
    protocolVersion: "1",
    authSource: "subscription",
  };
}

describe("Grok subscription model catalog", () => {
  it("normalizes ACP modelState models, descriptions, contexts, and per-model effort defaults", () => {
    const parsed = parseGrokModelState(MODEL_STATE);
    expect(parsed.defaultModel).toBe("grok-4.6");
    expect(parsed.models).toEqual([
      expect.objectContaining({
        modelId: "grok-4.6",
        name: "Grok 4.6",
        description: "SpaceXAI's latest frontier model",
        contextLimit: 500_000,
        effortDefault: "high",
        effortChoices: [
          expect.objectContaining({ id: "xhigh", raw: "xhigh", default: false }),
          expect.objectContaining({ id: "high", raw: "high", default: true }),
          expect.objectContaining({ id: "medium", raw: "medium", default: false }),
          expect.objectContaining({ id: "low", raw: "low", default: false }),
        ],
      }),
      expect.objectContaining({
        modelId: "grok-4.5",
        name: "Grok 4.5",
        description: null,
        contextLimit: 500_000,
        effortDefault: "high",
        effortChoices: [
          expect.objectContaining({ id: "high", raw: "high", default: true }),
          expect.objectContaining({ id: "medium", raw: "medium", default: false }),
          expect.objectContaining({ id: "low", raw: "low", default: false }),
        ],
      }),
    ]);
  });

  it("publishes ACP modelState as the primary source without an API key", async () => {
    const catalogProbe = vi.fn(async () => subscriptionProbe());
    const modelsProbe = vi.fn(async () => {
      throw new Error("grok models must not replace ACP modelState");
    });
    const apiProbe = vi.fn(async () => [{ modelId: "api-only", name: "API only" }]);
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-4.6",
      staticModels: [{ modelId: "stale-static", name: "Stale static" }],
      catalogProbe,
      modelsProbe,
      discoverModels: apiProbe,
      cliVersionProbe: async () => "grok 1.0.24",
      extraEnv: { HOME: "/profiles/alice", XAI_API_KEY: undefined },
    });

    const catalog = await profile.catalog.fetch();
    validateCandidate(catalog);
    expect(catalogProbe).toHaveBeenCalledOnce();
    expect(modelsProbe).not.toHaveBeenCalled();
    expect(apiProbe).not.toHaveBeenCalled();
    expect(catalog.source).toBe("grok-acp-model-state");
    expect(catalog.cliVersion).toBe("grok 1.0.24");
    expect(catalog.sourceVersion).toBe("acp/1; auth=subscription");
    expect(catalog.fetchedAt).toSatisfy((value: string) => Number.isFinite(Date.parse(value)));
    expect(catalog.scope).toMatchObject({
      provider: "xai",
      credentialProfile: "subscription:/profiles/alice/.grok",
    });
    expect(catalog.models.map((model) => model.id)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(catalog.models.find((model) => model.default)?.id).toBe("grok-4.6");
    expect(catalog.models[0]?.context).toEqual({ native: 500_000, maximum: 500_000, effective: 500_000 });
    expect(catalog.models[0]?.effort).toMatchObject({
      mechanism: "spawnArgs",
      selectionDefault: "high",
      choices: [{ id: "xhigh" }, { id: "high" }, { id: "medium" }, { id: "low" }],
    });
    expect(catalog.models[1]?.effort).toMatchObject({
      selectionDefault: "high",
      choices: [{ id: "high" }, { id: "medium" }, { id: "low" }],
    });
  });

  it("keeps local and bridge semantic scope equivalent while credentials remain isolated", () => {
    const common = {
      cliPath: "false",
      defaultModel: "grok-4.6",
      catalogProbe: async () => subscriptionProbe(),
      cliVersionProbe: async () => "grok 1.0.24",
      extraEnv: { XAI_API_KEY: undefined },
    };
    const local = makeGrokProfile({ ...common, extraEnv: { ...common.extraEnv, HOME: "/profiles/alice" } });
    const bridge = makeGrokProfile({ ...common, extraEnv: { ...common.extraEnv, HOME: "/profiles/alice" } });
    const otherProfile = makeGrokProfile({ ...common, extraEnv: { ...common.extraEnv, HOME: "/profiles/bob" } });
    expect(local.catalog.scope().fingerprint).toBe(bridge.catalog.scope().fingerprint);
    expect(local.catalog.scope().fingerprint).not.toBe(otherProfile.catalog.scope().fingerprint);
    expect(local.catalog.scope().backend).toBeUndefined();
  });

  it("uses same-account grok models only when ACP modelState is unavailable", async () => {
    const modelsProbe = vi.fn(async () => ({
      defaultModel: "grok-4.6",
      modelIds: ["grok-4.6", "grok-4.5"],
      authSource: "subscription" as const,
    }));
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-4.6",
      staticModels: [
        { modelId: "grok-4.6", name: "Grok 4.6", contextLimit: 500_000 },
        { modelId: "grok-4.5", name: "Grok 4.5", contextLimit: 500_000 },
      ],
      catalogProbe: async () => null,
      modelsProbe,
      cliVersionProbe: async () => "grok 1.0.24",
      extraEnv: { HOME: "/profiles/alice", XAI_API_KEY: undefined },
    });
    const catalog = await profile.catalog.fetch();
    validateCandidate(catalog);
    expect(modelsProbe).toHaveBeenCalledOnce();
    expect(catalog.source).toBe("grok-models-cli");
    expect(catalog.sourceVersion).toBe("grok-models; auth=subscription");
    expect(catalog.models.map((model) => model.id)).toEqual(["grok-4.6", "grok-4.5"]);
  });

  it("never auto-substitutes the API catalog in subscription mode", async () => {
    const apiProbe = vi.fn(async () => [{ modelId: "api-only", name: "API only" }]);
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-4.6",
      catalogProbe: async () => null,
      modelsProbe: async () => { throw new Error("subscription CLI unavailable"); },
      discoverModels: apiProbe,
      cliVersionProbe: async () => "grok 1.0.24",
      extraEnv: { XAI_API_KEY: undefined },
    });
    await expect(profile.catalog.fetch()).rejects.toThrow(/subscription CLI unavailable/);
    expect(apiProbe).not.toHaveBeenCalled();
  });

  it("uses /v1/models only in explicit API-key mode and never records the secret", async () => {
    const catalogProbe = vi.fn(async () => subscriptionProbe());
    const modelsProbe = vi.fn(async () => ({
      defaultModel: "grok-4.6",
      modelIds: ["grok-4.6"],
      authSource: "subscription" as const,
    }));
    const apiProbe = vi.fn(async () => [{ modelId: "grok-api", name: "Grok API", contextLimit: 131_072 }]);
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-api",
      catalogMode: "api-key",
      catalogProbe,
      modelsProbe,
      discoverModels: apiProbe,
      cliVersionProbe: async () => "grok 1.0.24",
      extraEnv: { HOME: "/profiles/alice", XAI_API_KEY: "do-not-record-this" },
    });
    const catalog = await profile.catalog.fetch();
    expect(apiProbe).toHaveBeenCalledOnce();
    expect(catalogProbe).not.toHaveBeenCalled();
    expect(modelsProbe).not.toHaveBeenCalled();
    expect(catalog.source).toBe("xai-models-api");
    expect(catalog.sourceVersion).toBe("xai-v1/models; auth=api-key");
    expect(JSON.stringify(catalog)).not.toContain("do-not-record-this");
  });

  it.each(["malformed", "empty", "timed out"])(
    "rejects %s ACP results instead of replacing the last-known-good generation",
    async (failure) => {
      const modelsProbe = vi.fn(async () => ({
        defaultModel: "grok-4.6",
        modelIds: ["grok-4.6"],
        authSource: "subscription" as const,
      }));
      const profile = makeGrokProfile({
        cliPath: "false",
        defaultModel: "grok-4.6",
        catalogProbe: async () => { throw new Error(`ACP modelState ${failure}`); },
        modelsProbe,
        extraEnv: { XAI_API_KEY: undefined },
      });
      await expect(profile.catalog.fetch()).rejects.toThrow(failure);
      expect(modelsProbe).not.toHaveBeenCalled();
    }
  );

  it("parses the authenticated grok models fallback without terminal decoration", () => {
    expect(parseGrokModelsOutput(`\u001b[32mYou are logged in with grok.com.\u001b[0m

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`)).toEqual({
      defaultModel: "grok-4.6",
      modelIds: ["grok-4.6", "grok-4.5"],
      authSource: "subscription",
    });
  });

  it("rejects malformed and empty ACP modelState payloads", () => {
    expect(() => parseGrokModelState(null)).toThrow(/malformed/);
    expect(() => parseGrokModelState({ currentModelId: "grok-4.6", availableModels: [] }))
      .toThrow(/no current model or available models/);
    expect(() => parseGrokModelState({
      ...MODEL_STATE,
      availableModels: [{ ...MODEL_STATE.availableModels[0], _meta: { totalContextTokens: 0 } }],
    })).toThrow(/invalid context limit/);
  });

  it("retains generation B after a later malformed Grok refresh", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seam-grok-catalog-"));
    const dbPath = path.join(temporary, "catalog.db");
    let attempt = 0;
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-4.6",
      catalogProbe: async () => {
        attempt += 1;
        if (attempt === 1) return subscriptionProbe();
        if (attempt === 2) {
          return {
            ...subscriptionProbe(),
            defaultModel: "grok-4.5",
          };
        }
        throw new Error("Grok ACP modelState malformed");
      },
      cliVersionProbe: async () => "grok 1.0.24",
      extraEnv: { HOME: "/profiles/alice", XAI_API_KEY: undefined },
    });
    const store = new ModelCatalogStore(dbPath);
    const binding = { agentId: "grok", location: "bridge-a" };
    const service = new ModelCatalogService({
      store,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      bindings: () => [binding],
      scope: () => profile.catalog.scope(),
      fetch: async () => profile.catalog.fetch(),
    });
    try {
      const first = await service.refresh(binding);
      const second = await service.refresh(binding);
      const failed = await service.refresh(binding);
      expect(first.result).toBe("published");
      expect(second.result).toBe("published");
      expect(second.generation).not.toBe(first.generation);
      expect(failed).toMatchObject({
        result: "retained",
        generation: second.generation,
      });
      expect(service.model(binding, "default")?.id).toBe("grok-4.5");
    } finally {
      service.stop();
      await service.drain();
      store.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it.each(["success", "missing", "hang"] as const)(
    "cleans up the initialize-only ACP child on the %s path",
    async (mode) => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seam-grok-process-"));
      const logPath = path.join(temporary, "requests.jsonl");
      const fixture = path.join(process.cwd(), "test/fixtures/grok/fake-acp.mjs");
      try {
        const operation = probeGrokCatalog({
          cliPath: process.execPath,
          baseArgs: [fixture, "--fixed-base"],
          defaultModel: "grok-test",
          cwd: temporary,
          env: {
            ...process.env,
            XAI_API_KEY: undefined,
            GROK_FAKE_LOG: logPath,
            GROK_FAKE_MODE: mode,
            GROK_FAKE_MARKER: "same-environment",
          },
          timeoutMs: mode === "hang" ? 1_000 : 5_000,
        });
        if (mode === "hang") await expect(operation).rejects.toThrow(/timed out/);
        else if (mode === "missing") await expect(operation).resolves.toBeNull();
        else await expect(operation).resolves.toMatchObject({ defaultModel: "grok-test" });

        const requests = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          method: "initialize",
          argv: ["--fixed-base", "agent", "--model", "grok-test", "stdio"],
          cwd: temporary,
          marker: "same-environment",
        });
        expect(() => process.kill(requests[0].pid, 0)).toThrow();
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
  );

  it("cleans up a catalog probe that cannot spawn the configured executable", async () => {
    await expect(probeGrokCatalog({
      cliPath: path.join(os.tmpdir(), "missing-grok-executable"),
      defaultModel: "grok-test",
      timeoutMs: 5_000,
    })).rejects.toThrow();
  });

  it("runs grok models with the same fixed executable context used by ACP", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seam-grok-models-"));
    const logPath = path.join(temporary, "requests.jsonl");
    const fixture = path.join(process.cwd(), "test/fixtures/grok/fake-acp.mjs");
    try {
      await expect(probeGrokModels({
        cliPath: process.execPath,
        baseArgs: [fixture, "--fixed-base"],
        cwd: temporary,
        env: {
          ...process.env,
          GROK_FAKE_LOG: logPath,
          GROK_FAKE_MARKER: "same-environment",
          XAI_API_KEY: undefined,
        },
      })).resolves.toEqual({
        defaultModel: "grok-test",
        modelIds: ["grok-test"],
        authSource: "subscription",
      });
      const invocation = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
      expect(invocation).toMatchObject({
        method: "models",
        argv: ["--fixed-base", "models"],
        cwd: temporary,
        marker: "same-environment",
      });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
