import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  makeCopilotProfile,
  probeCopilotCatalog,
  type CopilotCatalogProbe,
} from "../packages/adapters/src/profiles/copilot.js";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";

interface ModelFixture {
  id: string;
  name: string;
  choices: string[];
  defaultEffort: string;
  priceCategory: string | null;
}

function modelFixtures(count = 30): ModelFixture[] {
  return Array.from({ length: count }, (_unused, index) => {
    if (index === 0) {
      return {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        choices: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        priceCategory: "premium",
      };
    }
    if (index === 1) {
      return {
        id: "grok-4.6",
        name: "Grok 4.6",
        choices: ["low", "medium", "high"],
        defaultEffort: "high",
        priceCategory: "standard",
      };
    }
    if (index === 2) {
      return {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        choices: [],
        defaultEffort: "default",
        priceCategory: null,
      };
    }
    const choices = index % 2 === 0 ? ["low", "medium", "high"] : ["medium", "high"];
    return {
      id: `fixture-${String(index).padStart(2, "0")}`,
      name: `Fixture ${index}`,
      choices,
      defaultEffort: index % 2 === 0 ? "medium" : "high",
      priceCategory: index % 3 === 0 ? "premium" : "standard",
    };
  });
}

function configOptions(models: ModelFixture[], selectedModel: string, selectedEffort: string) {
  const selected = models.find((model) => model.id === selectedModel)!;
  return [
    {
      id: "model",
      name: "Model",
      type: "select" as const,
      currentValue: selectedModel,
      options: [
        {
          group: "live",
          name: "Live catalog",
          options: models.map((model) => ({
            value: model.id,
            name: model.name,
            ...(model.priceCategory
              ? { _meta: { copilotPriceCategory: model.priceCategory } }
              : {}),
          })),
        },
      ],
    },
    ...(selected.choices.length
      ? [{
          id: "reasoning_effort",
          name: "Reasoning effort",
          type: "select" as const,
          currentValue: selectedEffort,
          options: selected.choices.map((value) => ({ value, name: value })),
        }]
      : []),
  ];
}

function fakeCopilotSpawner(opts: {
  models?: ModelFixture[];
  failModel?: string;
  hangModel?: string;
  emptyModel?: string;
  mismatchOnceModel?: string;
  ignoreTerm?: boolean;
} = {}) {
  const models = opts.models ?? modelFixtures();
  const calls: Array<{
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    signals: Array<NodeJS.Signals | number | undefined>;
  }> = [];
  const openedSessions = new Set<string>();
  const closedSessions = new Set<string>();
  let active = 0;
  let maxActive = 0;
  let mismatches = 0;

  const spawnProcess = (
    executable: string,
    args: string[],
    spawnOpts: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: ["pipe", "pipe", "pipe"];
    }
  ) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const call = { executable, args, cwd: spawnOpts.cwd, env: spawnOpts.env, signals: [] as Array<NodeJS.Signals | number | undefined> };
    calls.push(call);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const sessionId = `copilot-probe-${calls.length}`;
    let selectedModel = models[0]!.id;
    let selectedEffort = models[0]!.defaultEffort;
    let modelSwitches = 0;
    let exited = false;
    let serverConnection: { close(): void } | undefined;
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill(signal?: NodeJS.Signals | number) {
        call.signals.push(signal);
        this.killed = true;
        if (signal === "SIGTERM" && opts.ignoreTerm) return true;
        if (!exited) {
          exited = true;
          active -= 1;
          serverConnection?.close();
          queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
        }
        return true;
      },
    });
    serverConnection = agent({ name: "fake-copilot-acp" })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      }))
      .onRequest(methods.agent.session.new, () => {
        openedSessions.add(sessionId);
        return {
          sessionId,
          configOptions: configOptions(models, selectedModel, selectedEffort),
        };
      })
      .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
        if (params.configId !== "model") {
          return { configOptions: configOptions(models, selectedModel, selectedEffort) };
        }
        const target = String(params.value);
        if (target === opts.failModel) throw new Error(`forced probe failure for ${target}`);
        if (target === opts.hangModel) await new Promise(() => {});
        if (target === opts.mismatchOnceModel && mismatches === 0) {
          mismatches += 1;
          return { configOptions: configOptions(models, selectedModel, selectedEffort) };
        }
        selectedModel = target;
        const fixture = models.find((model) => model.id === selectedModel)!;
        // This deliberately models the mutable-session bug: only the first
        // switch in a session establishes the target model's real default.
        // Later switches carry the prior selection whenever it is supported.
        if (modelSwitches === 0 || !fixture.choices.includes(selectedEffort)) {
          selectedEffort = fixture.defaultEffort;
        }
        modelSwitches += 1;
        if (target === opts.emptyModel) return { configOptions: [] };
        return { configOptions: configOptions(models, selectedModel, selectedEffort) };
      })
      .onRequest(methods.agent.session.close, ({ params }) => {
        closedSessions.add(params.sessionId);
        return {};
      })
      .connect(
        ndJsonStream(
          Writable.toWeb(stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(stdin) as ReadableStream<Uint8Array>
        )
      );
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  };

  return {
    models,
    spawnProcess,
    calls,
    openedSessions,
    closedSessions,
    get active() { return active; },
    get maxActive() { return maxActive; },
  };
}

function probeChecksum(probe: CopilotCatalogProbe): string {
  return createHash("sha256").update(JSON.stringify(probe)).digest("hex");
}

async function candidateChecksum(probe: CopilotCatalogProbe): Promise<string> {
  const profile = makeCopilotProfile({
    cliPath: process.execPath,
    configDir: "/credential/scope",
    defaultModel: "configured-fallback",
    catalogProbe: async () => probe,
  });
  const candidate = await profile.catalog.fetch();
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: candidate.schemaVersion,
    scope: candidate.scope,
    models: candidate.models,
  })).digest("hex");
}

describe("Copilot isolated catalog probing (#234)", () => {
  it("collects all >25 models with order-invariant model-specific defaults", async () => {
    const forwardHarness = fakeCopilotSpawner();
    const reverseHarness = fakeCopilotSpawner();
    const common = {
      cliPath: "/configured/bin/copilot",
      cwd: "/credential/scope",
      env: { COPILOT_GITHUB_TOKEN: "credential-scope-token", PATH: "/bin" },
      timeoutMs: 2_000,
      overallTimeoutMs: 10_000,
      cleanupTimeoutMs: 100,
    };
    const forward = await probeCopilotCatalog({
      ...common,
      spawnProcess: forwardHarness.spawnProcess,
      probeOrder: "forward",
    });
    const reverse = await probeCopilotCatalog({
      ...common,
      spawnProcess: reverseHarness.spawnProcess,
      probeOrder: "reverse",
    });

    expect(forward.models).toHaveLength(30);
    expect(forward).toEqual(reverse);
    expect(probeChecksum(forward)).toBe(probeChecksum(reverse));
    expect(await candidateChecksum(forward)).toBe(await candidateChecksum(reverse));
    expect(forward.models.find((model) => model.modelId === "gpt-6-astra")).toMatchObject({
      effortChoices: ["low", "medium", "high", "xhigh"],
      effortDefault: "medium",
      priceCategory: "premium",
    });
    expect(forward.models.find((model) => model.modelId === "grok-4.6")).toMatchObject({
      effortChoices: ["low", "medium", "high"],
      effortDefault: "high",
    });
    expect(forward.models.find((model) => model.modelId === "gpt-5-mini")).toMatchObject({
      effortChoices: [],
      effortDefault: "default",
    });

    for (const harness of [forwardHarness, reverseHarness]) {
      expect(harness.calls).toHaveLength(31);
      expect(harness.maxActive).toBe(1);
      expect(harness.active).toBe(0);
      expect(harness.closedSessions).toEqual(harness.openedSessions);
      expect(harness.calls.every((call) => call.executable === "/configured/bin/copilot")).toBe(true);
      expect(harness.calls.every((call) => call.args.join(" ") === "--acp")).toBe(true);
      expect(harness.calls.every((call) => call.cwd === "/credential/scope")).toBe(true);
      expect(harness.calls.every((call) => call.env.COPILOT_GITHUB_TOKEN === "credential-scope-token")).toBe(true);
      expect(harness.calls.every((call) => call.signals.includes("SIGTERM"))).toBe(true);
    }
  });

  it("fails atomically and cleans every process/session on a partial probe error", async () => {
    const harness = fakeCopilotSpawner({ models: modelFixtures(10), failModel: "fixture-03" });
    await expect(probeCopilotCatalog({
      spawnProcess: harness.spawnProcess,
      timeoutMs: 1_000,
      overallTimeoutMs: 5_000,
      cleanupTimeoutMs: 50,
    })).rejects.toThrow(/forced probe failure|fixture-03/);
    expect(harness.calls).toHaveLength(7);
    expect(harness.active).toBe(0);
    expect(harness.closedSessions).toEqual(harness.openedSessions);
    expect(harness.calls.every((call) => call.signals.length > 0)).toBe(true);
  });

  it("retries an unacknowledged model in a new isolated process/session", async () => {
    const harness = fakeCopilotSpawner({
      models: modelFixtures(8),
      mismatchOnceModel: "fixture-03",
    });
    const probe = await probeCopilotCatalog({
      spawnProcess: harness.spawnProcess,
      timeoutMs: 1_000,
      overallTimeoutMs: 5_000,
      cleanupTimeoutMs: 50,
    });
    expect(probe.models).toHaveLength(8);
    expect(harness.calls).toHaveLength(10);
    expect(harness.maxActive).toBe(1);
    expect(harness.active).toBe(0);
    expect(harness.closedSessions).toEqual(harness.openedSessions);
  });

  it("bounds a hung probe, closes its session, and escalates process cleanup", async () => {
    const harness = fakeCopilotSpawner({
      models: modelFixtures(6),
      hangModel: "fixture-03",
      ignoreTerm: true,
    });
    await expect(probeCopilotCatalog({
      spawnProcess: harness.spawnProcess,
      timeoutMs: 60,
      overallTimeoutMs: 1_000,
      cleanupTimeoutMs: 20,
    })).rejects.toThrow(/timed out/);
    expect(harness.calls).toHaveLength(5);
    expect(harness.active).toBe(0);
    expect(harness.closedSessions).toEqual(harness.openedSessions);
    expect(harness.calls.every((call) => call.signals.includes("SIGTERM"))).toBe(true);
    expect(harness.calls.every((call) => call.signals.includes("SIGKILL"))).toBe(true);
  });

  it("rejects empty per-model output instead of returning a half-probed catalog", async () => {
    const harness = fakeCopilotSpawner({ models: modelFixtures(7), emptyModel: "fixture-03" });
    await expect(probeCopilotCatalog({
      spawnProcess: harness.spawnProcess,
      timeoutMs: 1_000,
      overallTimeoutMs: 5_000,
      cleanupTimeoutMs: 50,
    })).rejects.toThrow(/did not select|fixture-03/);
    expect(harness.calls).toHaveLength(7);
    expect(harness.active).toBe(0);
    expect(harness.closedSessions).toEqual(harness.openedSessions);
  });

  it("normalizes identical local and bridged candidates with complete provenance", async () => {
    const probe: CopilotCatalogProbe = {
      defaultModel: "gpt-6-astra",
      models: modelFixtures().map((model) => ({
        modelId: model.id,
        displayName: model.name,
        effortChoices: model.choices,
        effortDefault: model.defaultEffort,
        priceCategory: model.priceCategory,
      })),
    };
    const profile = makeCopilotProfile({
      cliPath: process.execPath,
      configDir: "/credential/scope",
      defaultModel: "configured-fallback",
      catalogProbe: async () => probe,
    });
    const local = await profile.catalog.fetch();
    const remote = await dispatchBridgeRpc("fetchModelCatalog", {}, profile.id, {
      adapters: new Map([[profile.id, profile]]),
      workspaceRoot: "/workspace",
      cwd: "/workspace",
      devMode: false,
    }) as typeof local;

    expect(remote.models).toEqual(local.models);
    expect(remote.models).toHaveLength(30);
    expect(remote.scope).toEqual(local.scope);
    expect(local.scope.credentialProfile).toBe("/credential/scope");
    expect(local.sourceVersion).toBe(`acp/${PROTOCOL_VERSION}`);
    expect(local.cliVersion).toMatch(/^v?\d+/);
    expect(Number.isFinite(Date.parse(local.fetchedAt))).toBe(true);
    expect(local.models.find((model) => model.id === "gpt-6-astra")?.pricingCategory).toBe("premium");
  });
});
