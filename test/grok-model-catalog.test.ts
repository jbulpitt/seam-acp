import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  makeGrokProfile,
  normalizeCatalogCandidate,
  parseGrokModelsOutput,
  parseGrokModelState,
  probeGrokCatalog,
  probeGrokModels,
  resolveGrokSubscriptionIdentity,
  type GrokAuthIdentity,
  type GrokCatalogProbe,
  type GrokModelsProbe,
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

const SUBSCRIPTION_IDENTITY: GrokAuthIdentity = {
  source: "subscription",
  fingerprint: "a".repeat(64),
};

const OTHER_SUBSCRIPTION_IDENTITY: GrokAuthIdentity = {
  source: "subscription",
  fingerprint: "b".repeat(64),
};

function writeAuth(grokHome: string, account: string): void {
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, "auth.json"), JSON.stringify({
    "https://auth.x.ai::credential": {
      auth_mode: "oauth",
      oidc_issuer: "https://auth.x.ai",
      principal_id: `principal-${account}`,
      user_id: `user-${account}`,
      team_id: `team-${account}`,
      refresh_token: `must-not-persist-${account}`,
    },
  }), { mode: 0o600 });
}

function subscriptionProbe(): GrokCatalogProbe {
  return {
    modelState: parseGrokModelState(MODEL_STATE),
    protocolVersion: "1",
    authSource: "subscription",
    authIdentity: SUBSCRIPTION_IDENTITY,
  };
}

async function subscriptionModels(modelIds = ["grok-4.6", "grok-4.5"]): Promise<GrokModelsProbe> {
  return {
    defaultModel: modelIds[0]!,
    modelIds,
    authSource: "subscription",
    authIdentity: SUBSCRIPTION_IDENTITY,
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
      authIdentityProbe: () => SUBSCRIPTION_IDENTITY,
      extraEnv: { XAI_API_KEY: "ambient-key-must-be-removed" },
    });

    const catalog = await profile.catalog.fetch();
    validateCandidate(catalog);
    expect(catalogProbe).toHaveBeenCalledOnce();
    expect(modelsProbe).not.toHaveBeenCalled();
    expect(apiProbe).not.toHaveBeenCalled();
    expect(catalog.source).toBe("grok-acp-model-state");
    expect(catalog.cliVersion).toBe("grok 1.0.24");
    expect(catalog.sourceVersion).toBe("acp/1 auth subscription");
    expect(catalog.fetchedAt).toSatisfy((value: string) => Number.isFinite(Date.parse(value)));
    expect(catalog.scope).toMatchObject({
      provider: "xai",
      credentialProfile: "subscription-account",
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
    expect(catalog.models[0]).toMatchObject({
      description: "SpaceXAI's latest frontier model",
      evidence: [expect.objectContaining({
        kind: "live-observation",
        source: "grok-acp-model-state",
        scopeRef: catalog.scope.fingerprint,
        context: { native: 500_000, maximum: 500_000, effective: 500_000, method: "ACP initialize modelState" },
        effort: { choices: ["xhigh", "high", "medium", "low"], selectionDefault: "high", method: "ACP initialize modelState" },
      })],
    });
    expect(JSON.stringify(catalog)).not.toContain("ambient-key-must-be-removed");
  });

  it("scopes equal subscription accounts across different host paths and separates different accounts", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seam-grok-identities-"));
    try {
      const localHome = path.join(temporary, "local-profile");
      const bridgeHome = path.join(temporary, "remote-profile");
      const otherHome = path.join(temporary, "same-path-shape");
      writeAuth(localHome, "alice");
      writeAuth(bridgeHome, "alice");
      writeAuth(otherHome, "bob");
      const localIdentity = resolveGrokSubscriptionIdentity({ GROK_HOME: localHome });
      const bridgeIdentity = resolveGrokSubscriptionIdentity({ GROK_HOME: bridgeHome });
      const otherIdentity = resolveGrokSubscriptionIdentity({ GROK_HOME: otherHome });
      expect(localIdentity).toEqual(bridgeIdentity);
      expect(localIdentity.fingerprint).not.toBe(otherIdentity.fingerprint);

      const common = {
        cliPath: "false",
        defaultModel: "grok-4.6",
        catalogProbe: async () => ({ ...subscriptionProbe(), authIdentity: localIdentity }),
        cliVersionProbe: async () => "grok 1.0.24",
      };
      const local = makeGrokProfile({ ...common, authIdentityProbe: () => localIdentity });
      const bridge = makeGrokProfile({ ...common, authIdentityProbe: () => bridgeIdentity });
      const otherProfile = makeGrokProfile({
        ...common,
        authIdentityProbe: () => otherIdentity,
        catalogProbe: async () => ({ ...subscriptionProbe(), authIdentity: otherIdentity }),
      });
      expect(local.catalog.scope().fingerprint).toBe(bridge.catalog.scope().fingerprint);
      expect(local.catalog.scope().fingerprint).not.toBe(otherProfile.catalog.scope().fingerprint);
      const serialized = JSON.stringify([local.catalog.scope(), bridge.catalog.scope(), otherProfile.catalog.scope()]);
      expect(serialized).not.toContain(temporary);
      expect(serialized).not.toContain("alice");
      expect(serialized).not.toContain("bob");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("uses same-account grok models only when ACP modelState is unavailable", async () => {
    const modelsProbe = vi.fn(() => subscriptionModels());
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-4.6",
      staticModels: [
        { modelId: "grok-4.6", name: "Grok 4.6", contextLimit: 500_000 },
        { modelId: "grok-4.5", name: "Grok 4.5", contextLimit: 500_000 },
      ],
      catalogProbe: async () => ({ ...subscriptionProbe(), modelState: null }),
      modelsProbe,
      cliVersionProbe: async () => "grok 1.0.24",
      authIdentityProbe: () => SUBSCRIPTION_IDENTITY,
    });
    const catalog = await profile.catalog.fetch();
    validateCandidate(catalog);
    expect(modelsProbe).toHaveBeenCalledOnce();
    expect(catalog.source).toBe("grok-models-cli");
    expect(catalog.sourceVersion).toBe("grok-models auth subscription");
    expect(catalog.models.map((model) => model.id)).toEqual(["grok-4.6", "grok-4.5"]);
  });

  it("never auto-substitutes the API catalog in subscription mode", async () => {
    const apiProbe = vi.fn(async () => [{ modelId: "api-only", name: "API only" }]);
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-4.6",
      catalogProbe: async () => ({ ...subscriptionProbe(), modelState: null }),
      modelsProbe: async () => { throw new Error("subscription CLI unavailable"); },
      discoverModels: apiProbe,
      cliVersionProbe: async () => "grok 1.0.24",
      authIdentityProbe: () => SUBSCRIPTION_IDENTITY,
    });
    await expect(profile.catalog.fetch()).rejects.toThrow(/subscription CLI unavailable/);
    expect(apiProbe).not.toHaveBeenCalled();
  });

  it("uses /v1/models only in explicit API-key mode and never records the secret", async () => {
    const catalogProbe = vi.fn(async () => subscriptionProbe());
    const modelsProbe = vi.fn(() => subscriptionModels(["grok-4.6"]));
    const apiProbe = vi.fn(async () => [{ modelId: "grok-api", name: "Grok API", contextLimit: 131_072 }]);
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-api",
      catalogMode: "api-key",
      apiKey: "do-not-record-this",
      catalogProbe,
      modelsProbe,
      discoverModels: apiProbe,
      cliVersionProbe: async () => "grok 1.0.24",
    });
    const catalog = await profile.catalog.fetch();
    expect(apiProbe).toHaveBeenCalledOnce();
    expect(catalogProbe).not.toHaveBeenCalled();
    expect(modelsProbe).not.toHaveBeenCalled();
    expect(catalog.source).toBe("xai-models-api");
    expect(catalog.sourceVersion).toBe("xai-v1/models auth api-key");
    expect(JSON.stringify(catalog)).not.toContain("do-not-record-this");
  });

  it("does not infer an API-mode default from list order", async () => {
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "configured-but-absent",
      catalogMode: "api-key",
      apiKey: "api-key-not-recorded",
      discoverModels: async () => [
        { modelId: "first", name: "First" },
        { modelId: "second", name: "Second" },
      ],
      cliVersionProbe: async () => "grok 1.0.24",
    });
    await expect(profile.catalog.fetch()).rejects.toThrow(/does not resolve/);
  });

  it("rejects a CLI fallback from a different subscription account", async () => {
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-4.6",
      authIdentityProbe: () => SUBSCRIPTION_IDENTITY,
      catalogProbe: async () => ({ ...subscriptionProbe(), modelState: null }),
      modelsProbe: async () => ({
        defaultModel: "grok-4.6",
        modelIds: ["grok-4.6"],
        authSource: "subscription",
        authIdentity: OTHER_SUBSCRIPTION_IDENTITY,
      }),
      cliVersionProbe: async () => "grok 1.0.24",
    });
    await expect(profile.catalog.fetch()).rejects.toThrow(/same subscription account/);
  });

  it.each(["malformed", "empty", "timed out"])(
    "rejects %s ACP results instead of replacing the last-known-good generation",
    async (failure) => {
      const modelsProbe = vi.fn(() => subscriptionModels(["grok-4.6"]));
      const profile = makeGrokProfile({
        cliPath: "false",
        defaultModel: "grok-4.6",
        catalogProbe: async () => { throw new Error(`ACP modelState ${failure}`); },
        modelsProbe,
        cliVersionProbe: async () => "grok 1.0.24",
        authIdentityProbe: () => SUBSCRIPTION_IDENTITY,
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
            modelState: {
              ...subscriptionProbe().modelState!,
              defaultModel: "grok-4.5",
            },
          };
        }
        throw new Error("Grok ACP modelState malformed");
      },
      cliVersionProbe: async () => "grok 1.0.24",
      authIdentityProbe: () => SUBSCRIPTION_IDENTITY,
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
      const cold = new ModelCatalogService({
        store,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
        bindings: () => [binding],
        scope: () => profile.catalog.scope(),
        fetch: async () => profile.catalog.fetch(),
      });
      try {
        expect(cold.lookup(binding).snapshot?.generation).toBe(second.generation);
        expect(cold.model(binding, "default")?.id).toBe("grok-4.5");
        expect(cold.resolve(binding, { model: "default", effort: "high" }).generation)
          .toBe(second.generation);
      } finally {
        cold.stop();
        await cold.drain();
      }
    } finally {
      service.stop();
      await service.drain();
      store.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("uses the shared two-observation quarantine for a suspicious 2-to-1 catalog", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seam-grok-collapse-"));
    const store = new ModelCatalogStore(path.join(temporary, "catalog.db"));
    let reduced = false;
    const profile = makeGrokProfile({
      cliPath: "false",
      defaultModel: "grok-4.6",
      authIdentityProbe: () => SUBSCRIPTION_IDENTITY,
      catalogProbe: async () => {
        const full = subscriptionProbe();
        return reduced ? {
          ...full,
          modelState: {
            defaultModel: "grok-4.6",
            models: full.modelState!.models.slice(0, 1),
          },
        } : full;
      },
      cliVersionProbe: async () => "grok 1.0.24",
    });
    const binding = { agentId: "grok", location: "bridge-a" };
    const service = new ModelCatalogService({
      store,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      bindings: () => [binding],
      scope: () => profile.catalog.scope(),
      fetch: async () => profile.catalog.fetch(),
    });
    try {
      const full = await service.refresh(binding);
      reduced = true;
      const firstReduction = await service.refresh(binding);
      expect(full.result).toBe("published");
      expect(firstReduction).toMatchObject({
        result: "quarantined",
        generation: full.generation,
        reduction: { rule: "small-catalog", confirmationRequired: true },
      });
      expect(service.models(binding)).toHaveLength(2);
      const confirmedReduction = await service.refresh(binding);
      expect(service.models(binding)).toHaveLength(1);
      expect(confirmedReduction.result).toBe("published");
      expect(confirmedReduction.generation).not.toBe(full.generation);
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
      const grokHome = path.join(temporary, "grok-home");
      const fixture = path.join(process.cwd(), "test/fixtures/grok/fake-acp.mjs");
      try {
        writeAuth(grokHome, "process-test");
        const operation = probeGrokCatalog({
          cliPath: process.execPath,
          baseArgs: [fixture, "--fixed-base"],
          defaultModel: "grok-test",
          cwd: temporary,
          env: {
            ...process.env,
            XAI_API_KEY: undefined,
            GROK_HOME: grokHome,
            GROK_FAKE_LOG: logPath,
            GROK_FAKE_MODE: mode,
            GROK_FAKE_MARKER: "same-environment",
          },
          timeoutMs: mode === "hang" ? 1_000 : 5_000,
        });
        if (mode === "hang") await expect(operation).rejects.toThrow(/timed out/);
        else if (mode === "missing") await expect(operation).resolves.toMatchObject({ modelState: null });
        else await expect(operation).resolves.toMatchObject({ modelState: { defaultModel: "grok-test" } });

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

  it.each([
    ["early-exit", "exited_early"],
    ["malformed-protocol", "protocol_error"],
    ["stdout-flood", "output_overflow"],
  ] as const)("fails closed through the shared lifecycle on %s", async (mode, code) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seam-grok-hostile-"));
    const grokHome = path.join(temporary, "grok-home");
    const logPath = path.join(temporary, "requests.jsonl");
    const fixture = path.join(process.cwd(), "test/fixtures/grok/fake-acp.mjs");
    try {
      writeAuth(grokHome, "hostile-test");
      const error = await probeGrokCatalog({
        cliPath: process.execPath,
        baseArgs: [fixture],
        defaultModel: "grok-test",
        cwd: temporary,
        env: {
          ...process.env,
          GROK_HOME: grokHome,
          GROK_FAKE_LOG: logPath,
          GROK_FAKE_MODE: mode,
          GROK_FAKE_SECRET: "secret-must-be-redacted",
          XAI_API_KEY: undefined,
        },
        timeoutMs: 5_000,
      }).then(() => null, (failure: unknown) => failure);
      if (mode === "early-exit") {
        expect(["exited_early", "protocol_error"]).toContain((error as { code?: string })?.code);
      } else {
        expect(error).toMatchObject({ code });
      }
      expect(String(error)).not.toContain("secret-must-be-redacted");
      if (fs.existsSync(logPath)) {
        const pid = JSON.parse(fs.readFileSync(logPath, "utf8").trim().split("\n")[0]!).pid;
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("honors caller cancellation and awaits the Grok child exit", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seam-grok-cancel-"));
    const grokHome = path.join(temporary, "grok-home");
    const logPath = path.join(temporary, "requests.jsonl");
    const signalLog = path.join(temporary, "signals.log");
    const fixture = path.join(process.cwd(), "test/fixtures/grok/fake-acp.mjs");
    const controller = new AbortController();
    try {
      writeAuth(grokHome, "cancel-test");
      const operation = probeGrokCatalog({
        cliPath: process.execPath,
        baseArgs: [fixture],
        defaultModel: "grok-test",
        cwd: temporary,
        env: {
          ...process.env,
          GROK_HOME: grokHome,
          GROK_FAKE_LOG: logPath,
          GROK_FAKE_SIGNAL_LOG: signalLog,
          GROK_FAKE_MODE: "hang",
          XAI_API_KEY: undefined,
        },
        signal: controller.signal,
        timeoutMs: 10_000,
      });
      await vi.waitFor(() => expect(fs.existsSync(logPath)).toBe(true));
      controller.abort();
      await expect(operation).rejects.toMatchObject({ code: "cancelled" });
      const pid = JSON.parse(fs.readFileSync(logPath, "utf8").trim()).pid;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(fs.readFileSync(signalLog, "utf8")).toContain("SIGTERM");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("cleans up a catalog probe that cannot spawn the configured executable", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seam-grok-missing-"));
    const grokHome = path.join(temporary, "grok-home");
    try {
      writeAuth(grokHome, "missing-test");
      await expect(probeGrokCatalog({
        cliPath: path.join(temporary, "missing-grok-executable"),
        defaultModel: "grok-test",
        env: { ...process.env, GROK_HOME: grokHome, XAI_API_KEY: undefined },
        timeoutMs: 5_000,
      })).rejects.toMatchObject({ code: "spawn_failed" });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("runs grok models with the same fixed executable context used by ACP", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seam-grok-models-"));
    const logPath = path.join(temporary, "requests.jsonl");
    const grokHome = path.join(temporary, "grok-home");
    const fixture = path.join(process.cwd(), "test/fixtures/grok/fake-acp.mjs");
    try {
      writeAuth(grokHome, "models-test");
      await expect(probeGrokModels({
        cliPath: process.execPath,
        baseArgs: [fixture, "--fixed-base"],
        cwd: temporary,
        env: {
          ...process.env,
          GROK_FAKE_LOG: logPath,
          GROK_FAKE_MARKER: "same-environment",
          GROK_HOME: grokHome,
          XAI_API_KEY: undefined,
        },
      })).resolves.toEqual({
        defaultModel: "grok-test",
        modelIds: ["grok-test"],
        authSource: "subscription",
        authIdentity: resolveGrokSubscriptionIdentity({ GROK_HOME: grokHome }),
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
