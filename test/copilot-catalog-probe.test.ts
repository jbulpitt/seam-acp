import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  agent,
  ClientSideConnection,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import {
  makeCopilotProfile,
  probeCopilotCatalog,
  type CopilotCatalogProbe,
} from "../packages/adapters/src/profiles/copilot.js";
import {
  CATALOG_SCOPE_LABEL_REDACTED,
  normalizeCatalogCandidate,
} from "../packages/adapters/src/catalog-evidence.js";
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
        id: "default-model",
        name: "Default Model",
        choices: ["low", "medium", "high"],
        defaultEffort: "medium",
        priceCategory: "standard",
      };
    }
    if (index === 1) {
      return {
        id: "contamination-seed",
        name: "Contamination Seed",
        choices: ["medium", "high"],
        defaultEffort: "high",
        priceCategory: "standard",
      };
    }
    if (index === 2) {
      return {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        choices: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        priceCategory: "premium",
      };
    }
    if (index === 3) {
      return {
        id: "grok-4.6",
        name: "Grok 4.6",
        choices: ["low", "medium", "high"],
        defaultEffort: "medium",
        priceCategory: "standard",
      };
    }
    if (index === 4) {
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
  emitChildError?: boolean;
  exitWithStderr?: string;
  ignoreKillModel?: string;
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
  const children: EventEmitter[] = [];
  const transports: PassThrough[][] = [];
  const forceStops: Array<() => void> = [];
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
    let forceStop!: (signal?: NodeJS.Signals | number) => void;
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      pid: 42_000 + calls.length,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      kill(signal?: NodeJS.Signals | number) {
        call.signals.push(signal);
        this.killed = true;
        if (selectedModel === opts.ignoreKillModel) return true;
        if (signal === "SIGTERM" && opts.ignoreTerm) return true;
        forceStop(signal);
        return true;
      },
    });
    forceStop = (signal) => {
        if (!exited) {
          exited = true;
          active -= 1;
          child.signalCode = typeof signal === "string" ? signal : "SIGTERM";
          serverConnection?.close();
          stdin.destroy();
          stdout.destroy();
          stderr.destroy();
          queueMicrotask(() => child.emit("exit", null, signal ?? "SIGTERM"));
        }
    };
    forceStops.push(() => forceStop("SIGKILL"));
    children.push(child);
    transports.push([stdin, stdout, stderr]);
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
    queueMicrotask(() => child.emit("spawn"));
    if (opts.emitChildError) {
      queueMicrotask(() => child.emit("error", new Error("forced post-spawn child error")));
    }
    if (opts.exitWithStderr) {
      queueMicrotask(() => {
        stderr.write(opts.exitWithStderr);
        forceStop("SIGTERM");
      });
    }
    return child as unknown as import("node:child_process").ChildProcessWithoutNullStreams;
  };

  return {
    models,
    spawnProcess,
    calls,
    openedSessions,
    closedSessions,
    get active() { return active; },
    get maxActive() { return maxActive; },
    get listenersRemoved() {
      return children.every((child) =>
        child.listenerCount("error") === 0 && child.listenerCount("exit") === 0);
    },
    get transportsDestroyed() {
      return transports.every((group) => group.every((stream) => stream.destroyed));
    },
    get stderrListenersRemoved() {
      return transports.every((group) => group[2]!.listenerCount("data") === 0);
    },
    forceCleanup() {
      for (const stop of forceStops) stop();
    },
  };
}

function probeChecksum(probe: CopilotCatalogProbe): string {
  return createHash("sha256").update(JSON.stringify(probe)).digest("hex");
}

async function reusedSessionDefaults(
  spawnProcess: ReturnType<typeof fakeCopilotSpawner>["spawnProcess"]
): Promise<Map<string, string>> {
  const child = spawnProcess("copilot", ["--acp"], {
    cwd: "/credential/scope",
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  const connection = new ClientSideConnection(
    () => ({
      async requestPermission() {
        return { outcome: { outcome: "cancelled" as const } };
      },
      async sessionUpdate() {},
    }),
    ndJsonStream(
      Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>
    )
  );
  let sessionId: string | undefined;
  try {
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const session = await connection.newSession({ cwd: "/credential/scope", mcpServers: [] });
    sessionId = session.sessionId;
    const initial = session.configOptions ?? [];
    const modelSelect = initial.find((option) => option.id === "model");
    if (modelSelect?.type !== "select") throw new Error("fake model select missing");
    const models = modelSelect.options.flatMap((option) =>
      "options" in option ? option.options : [option]
    );
    const defaults = new Map<string, string>();
    for (const model of models) {
      const options = model.value === modelSelect.currentValue
        ? initial
        : (await connection.setSessionConfigOption({
            sessionId,
            configId: "model",
            value: model.value,
          })).configOptions ?? [];
      const effort = options.find((option) => option.id === "reasoning_effort");
      defaults.set(model.value, effort?.type === "select" ? effort.currentValue : "default");
    }
    return defaults;
  } finally {
    if (sessionId) await connection.closeSession({ sessionId });
    child.kill("SIGTERM");
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    await connection.closed;
  }
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
  it("reproduces the reused-session outlier while isolated probes stay model-correct", async () => {
    const contaminatedHarness = fakeCopilotSpawner({ models: modelFixtures(6) });
    const contaminated = await reusedSessionDefaults(contaminatedHarness.spawnProcess);
    expect(contaminated.get("gpt-6-astra")).toBe("high");
    expect(contaminated.get("grok-4.6")).toBe("high");
    expect(contaminatedHarness.active).toBe(0);

    const isolatedHarness = fakeCopilotSpawner({ models: modelFixtures(6) });
    const isolated = await probeCopilotCatalog({
      spawnProcess: isolatedHarness.spawnProcess,
      timeoutMs: 1_000,
      overallTimeoutMs: 10_000,
      cleanupTimeoutMs: 50,
    });
    expect(isolated.models.find((model) => model.modelId === "gpt-6-astra")?.effortDefault)
      .toBe("medium");
    expect(isolated.models.find((model) => model.modelId === "grok-4.6")?.effortDefault)
      .toBe("medium");
    expect(isolatedHarness.active).toBe(0);
    expect(isolatedHarness.closedSessions).toEqual(isolatedHarness.openedSessions);
  });

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
      effortDefault: "medium",
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
      expect(harness.listenersRemoved).toBe(true);
      expect(harness.transportsDestroyed).toBe(true);
      expect(harness.stderrListenersRemoved).toBe(true);
      expect(harness.calls.every((call) => call.executable === "/configured/bin/copilot")).toBe(true);
      expect(harness.calls.every((call) => call.args.join(" ") === "--acp")).toBe(true);
      expect(harness.calls.every((call) => call.cwd === "/credential/scope")).toBe(true);
      expect(harness.calls.every((call) => call.env.COPILOT_GITHUB_TOKEN === "credential-scope-token")).toBe(true);
      expect(harness.calls.every((call) => call.signals.includes("SIGTERM"))).toBe(true);
    }
  });

  it("fails atomically and cleans every process/session on a partial probe error", async () => {
    const harness = fakeCopilotSpawner({ models: modelFixtures(10), failModel: "fixture-05" });
    await expect(probeCopilotCatalog({
      spawnProcess: harness.spawnProcess,
      timeoutMs: 1_000,
      overallTimeoutMs: 5_000,
      cleanupTimeoutMs: 50,
    })).rejects.toThrow(/forced probe failure|fixture-05/);
    expect(harness.calls).toHaveLength(7);
    expect(harness.active).toBe(0);
    expect(harness.closedSessions).toEqual(harness.openedSessions);
    expect(harness.listenersRemoved).toBe(true);
    expect(harness.transportsDestroyed).toBe(true);
    expect(harness.stderrListenersRemoved).toBe(true);
    expect(harness.calls.every((call) => call.signals.length > 0)).toBe(true);
  });

  it("retries an unacknowledged model in a new isolated process/session", async () => {
    const harness = fakeCopilotSpawner({
      models: modelFixtures(8),
      mismatchOnceModel: "fixture-05",
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
    expect(harness.listenersRemoved).toBe(true);
    expect(harness.transportsDestroyed).toBe(true);
    expect(harness.stderrListenersRemoved).toBe(true);
  });

  it("bounds a hung probe, closes its session, and escalates process cleanup", async () => {
    const harness = fakeCopilotSpawner({
      models: modelFixtures(6),
      hangModel: "fixture-05",
      ignoreTerm: true,
    });
    await expect(probeCopilotCatalog({
      spawnProcess: harness.spawnProcess,
      timeoutMs: 60,
      overallTimeoutMs: 1_000,
      cleanupTimeoutMs: 20,
    })).rejects.toThrow(/timed out/);
    expect(harness.calls).toHaveLength(7);
    expect(harness.active).toBe(0);
    expect(harness.closedSessions).toEqual(harness.openedSessions);
    expect(harness.listenersRemoved).toBe(true);
    expect(harness.transportsDestroyed).toBe(true);
    expect(harness.stderrListenersRemoved).toBe(true);
    expect(harness.calls.every((call) => call.signals.includes("SIGTERM"))).toBe(true);
    expect(harness.calls.every((call) => call.signals.includes("SIGKILL"))).toBe(true);
  });

  it("rejects empty per-model output instead of returning a half-probed catalog", async () => {
    const harness = fakeCopilotSpawner({ models: modelFixtures(7), emptyModel: "fixture-05" });
    await expect(probeCopilotCatalog({
      spawnProcess: harness.spawnProcess,
      timeoutMs: 1_000,
      overallTimeoutMs: 5_000,
      cleanupTimeoutMs: 50,
    })).rejects.toThrow(/did not select|fixture-05/);
    expect(harness.calls).toHaveLength(9);
    expect(harness.active).toBe(0);
    expect(harness.closedSessions).toEqual(harness.openedSessions);
    expect(harness.listenersRemoved).toBe(true);
    expect(harness.transportsDestroyed).toBe(true);
    expect(harness.stderrListenersRemoved).toBe(true);
  });

  it("does not retry while an unreaped per-model child may still be alive", async () => {
    const harness = fakeCopilotSpawner({
      models: modelFixtures(8),
      ignoreKillModel: "fixture-05",
    });
    await expect(probeCopilotCatalog({
      spawnProcess: harness.spawnProcess,
      timeoutMs: 100,
      overallTimeoutMs: 1_000,
      cleanupTimeoutMs: 10,
    })).rejects.toThrow(/did not exit after SIGKILL/);
    expect(harness.calls).toHaveLength(7);
    expect(harness.active).toBe(1);
    expect(harness.maxActive).toBe(1);
    expect(harness.calls.at(-1)?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(harness.listenersRemoved).toBe(true);
    harness.forceCleanup();
    await Promise.resolve();
    expect(harness.active).toBe(0);
    expect(harness.transportsDestroyed).toBe(true);
  });

  it("redacts configured credentials from child stderr failures", async () => {
    const secret = "synthetic-copilot-credential";
    const githubSecret = `${secret}-github-suffix`;
    const copilotSecret = `${githubSecret}-copilot-suffix`;
    const harness = fakeCopilotSpawner({
      exitWithStderr: `authentication failed for ${secret} ${githubSecret} ${copilotSecret}`,
    });
    let failure: unknown;
    try {
      await probeCopilotCatalog({
        spawnProcess: harness.spawnProcess,
        env: {
          GH_TOKEN: secret,
          GITHUB_TOKEN: githubSecret,
          COPILOT_GITHUB_TOKEN: copilotSecret,
        },
        timeoutMs: 100,
        overallTimeoutMs: 500,
        cleanupTimeoutMs: 10,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain("github-suffix");
    expect(String(failure)).not.toContain("copilot-suffix");
    expect(String(failure)).toContain("[redacted]");
    expect(harness.active).toBe(0);
    expect(harness.listenersRemoved).toBe(true);
    expect(harness.transportsDestroyed).toBe(true);
  });

  it("terminates a still-running process after a post-spawn child error", async () => {
    const harness = fakeCopilotSpawner({ emitChildError: true });
    await expect(probeCopilotCatalog({
      spawnProcess: harness.spawnProcess,
      timeoutMs: 100,
      overallTimeoutMs: 500,
      cleanupTimeoutMs: 10,
    })).rejects.toThrow(/forced post-spawn child error/);
    expect(harness.active).toBe(0);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.signals).toContain("SIGTERM");
    expect(harness.listenersRemoved).toBe(true);
    expect(harness.transportsDestroyed).toBe(true);
    expect(harness.stderrListenersRemoved).toBe(true);
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
    const local = normalizeCatalogCandidate(await profile.catalog.fetch());
    const remote = await dispatchBridgeRpc("fetchModelCatalog", {}, profile.id, {
      adapters: new Map([[profile.id, profile]]),
      workspaceRoot: "/workspace",
      cwd: "/workspace",
      devMode: false,
    }) as typeof local;

    expect(remote.models).toEqual(local.models);
    expect(remote.models).toHaveLength(30);
    expect(remote.scope).toEqual(local.scope);
    expect(local.scope.credentialProfile).toBe(CATALOG_SCOPE_LABEL_REDACTED);
    expect(local.sourceVersion).toBe(`acp/${PROTOCOL_VERSION}`);
    expect(local.cliVersion).toMatch(/^v?\d+/);
    expect(Number.isFinite(Date.parse(local.fetchedAt))).toBe(true);
    expect(local.models.find((model) => model.id === "gpt-6-astra")?.pricingCategory).toBe("premium");
  });
});
