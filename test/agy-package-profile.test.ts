import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PassThrough, type Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pino } from "pino";
import {
  AGY_ACP_UPSTREAM_COMMIT,
  AGY_ACP_UPSTREAM_VERSION,
  agyAcpReleaseArtifact,
  buildAgyAcpEnvironment,
  createAgyAcpOutputFilter,
  createAgyRuntimeStderrFilter,
  makeAgyProfile,
  parseAgyModelsOutput,
  probeAgyPackageCatalog,
  reconcileAgyAcpModels,
  verifyAgyRuntimeIdentity,
} from "@seam/adapters";
import {
  ModelCatalogService,
  validateCandidate,
} from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const fakeWrapper = "/opt/agy/bin/antigravity-acp";
const hash = agyAcpReleaseArtifact().sha256;
const AGY_COMMAND_CHILD = fileURLToPath(new URL("./fixtures/fake-agy-command.mjs", import.meta.url));

function fakeAcpProcess(
  models: Array<{ value: string; name: string }>,
  acknowledge = true,
  discoveredModels?: Array<{ value: string; name: string }>,
  discoveryDelayMs = 0,
  onDiscovery?: () => void
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  let current = models[0]?.value;
  let exited = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let available = models;
  let discoveryTimer: NodeJS.Timeout | undefined;
  const option = () => ({
    id: "model",
    name: "Model",
    description: "fake",
    category: "model",
    type: "select",
    currentValue: current,
    options: available,
  });
  readline.createInterface({ input: stdin }).on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: { value?: string };
    };
    let result: object = {};
    if (message.method === "initialize") {
      result = {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "fake-antigravity-acp", version: "1.1.0" },
        authMethods: [],
      };
    } else if (message.method === "session/new") {
      result = { sessionId: "fake-session", configOptions: [option()] };
      if (discoveredModels) {
        const publishDiscovery = () => {
          onDiscovery?.();
          available = discoveredModels;
          current = discoveredModels[0]?.value;
          stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "fake-session",
              update: { sessionUpdate: "config_option_update", configOptions: [option()] },
            },
          })}\n`);
        };
        if (discoveryDelayMs > 0) discoveryTimer = setTimeout(publishDiscovery, discoveryDelayMs);
        else queueMicrotask(publishDiscovery);
      }
    } else if (message.method === "session/set_config_option") {
      if (acknowledge) current = message.params?.value;
      result = { configOptions: [option()] };
    }
    if (message.id !== undefined) {
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    }
  });
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    get exitCode() { return exitCode; },
    get signalCode() { return signalCode; },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (exited) return false;
      exited = true;
      if (discoveryTimer) clearTimeout(discoveryTimer);
      signalCode = signal;
      queueMicrotask(() => emitter.emit("exit", exitCode, signalCode));
      return true;
    },
  });
  queueMicrotask(() => emitter.emit("spawn"));
  return child as unknown as ChildProcessWithoutNullStreams;
}

function options(over: Record<string, unknown> = {}) {
  return {
    acpPath: fakeWrapper,
    agyBin: "/opt/agy/bin/agy",
    agyVersion: "agy 1.1.20",
    agySha256: "a".repeat(64),
    defaultModel: "gemini-3.7-pro-high",
    stateDir: pathForState(),
    conversationsDir: "/srv/agy/conversations",
    cwd: "/srv/workspaces",
    credentialScope: "antigravity-oauth:primary",
    wrapperVersion: AGY_ACP_UPSTREAM_VERSION,
    wrapperSha256: hash,
    permissionRiskAcknowledged: true,
    verifyWrapper: () => {},
    verifyRuntime: () => {},
    ...over,
  };
}

function pathForState(): string {
  return `${os.homedir()}/.agy-acp`;
}

async function filterOutput(filter: Transform, chunks: string[]): Promise<string> {
  let output = "";
  filter.setEncoding("utf8");
  filter.on("data", (chunk: string) => { output += chunk; });
  for (const chunk of chunks) filter.write(chunk);
  filter.end();
  await new Promise<void>((resolve, reject) => {
    filter.once("end", resolve);
    filter.once("error", reject);
  });
  return output;
}

describe("package-backed agy profile", () => {
  it("requires explicit permission-risk acceptance", () => {
    expect(() => makeAgyProfile(options({ permissionRiskAcknowledged: false })))
      .toThrow(/dangerously-skip-permissions/);
  });

  it("constructs exact no-download local/bridge launch metadata without credentials", () => {
    const profile = makeAgyProfile(options());
    expect(profile.id).toBe("agy");
    expect(profile.describe().runtime).toEqual(expect.objectContaining({
      executable: fakeWrapper,
      argv: [],
      cwd: "/srv/workspaces",
      environment: {
        AGY_BIN: "/opt/agy/bin/agy",
        AGY_SKIP_DOWNLOAD: "1",
        AGY_CONVERSATIONS_DIR: "/srv/agy/conversations",
      },
      credentialScope: "antigravity-oauth:primary",
      provenance: expect.objectContaining({
        version: AGY_ACP_UPSTREAM_VERSION,
        commit: AGY_ACP_UPSTREAM_COMMIT,
      }),
      dependencies: [{
        executable: "/opt/agy/bin/agy",
        version: "agy 1.1.20",
        sha256: "a".repeat(64),
      }],
    }));
    expect(JSON.stringify(profile.describe().runtime)).not.toMatch(/token|secret|credential=/i);
    expect(buildAgyAcpEnvironment({}, options())).toMatchObject({
      AGY_BIN: "/opt/agy/bin/agy",
      AGY_SKIP_DOWNLOAD: "1",
      AGY_CONVERSATIONS_DIR: "/srv/agy/conversations",
    });
    expect(buildAgyAcpEnvironment({
      HOME: "/srv/agy",
      PATH: "/usr/bin",
      DISCORD_BOT_TOKEN: "must-not-reach-agy",
      GOOGLE_API_KEY: "must-not-reach-agy-either",
    }, options())).toEqual({
      HOME: "/srv/agy",
      PATH: "/usr/bin",
      AGY_BIN: "/opt/agy/bin/agy",
      AGY_SKIP_DOWNLOAD: "1",
      AGY_CONVERSATIONS_DIR: "/srv/agy/conversations",
    });
  });

  it("bounds and redacts child diagnostics and propagated ACP errors", async () => {
    const secret = "configured-child-secret-value-123456789";
    const env = { HOME: "/srv/agy", AGY_BIN: "/opt/agy/agy", TEST_SECRET: secret };
    const stderr = await filterOutput(
      createAgyRuntimeStderrFilter(env),
      ["failure token=configured-child-", "secret-value-123456789\n"]
    );
    expect(stderr).not.toContain(secret);
    expect(stderr).toContain("[redacted]");

    const wire = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: `agy failed: ${secret}`, data: { cause: secret } },
    });
    const acp = await filterOutput(createAgyAcpOutputFilter(env), [`${wire}\n`]);
    expect(acp).not.toContain(secret);
    expect(JSON.parse(acp).error).toEqual({
      code: -32603,
      message: "agy failed: [redacted]",
      data: { cause: "[redacted]" },
    });

    const flood = await filterOutput(
      createAgyRuntimeStderrFilter(env),
      ["x".repeat(300_000)]
    );
    expect(flood).toBe("[agy diagnostic truncated]\n");
  });

  it("uses #236 TERM-to-KILL-and-reap lifecycle for a TERM-ignoring direct command", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-command-"));
    const signalLog = path.join(dir, "signals.log");
    try {
      await expect(probeAgyPackageCatalog({
        acpPath: fakeWrapper,
        agyBin: process.execPath,
        agyVersion: "agy-test 1.0",
        agyArgsPrefix: [AGY_COMMAND_CHILD],
        cwd: dir,
        env: {
          ...process.env,
          FAKE_AGY_MODE: "ignore-sigterm",
          FAKE_AGY_SIGNAL_LOG: signalLog,
        },
        timeoutMs: 200,
        defaultModel: "model-a",
      })).rejects.toMatchObject({ code: "timeout" });
      const log = fs.readFileSync(signalLog, "utf8");
      expect(log).toContain("SIGTERM-IGNORED");
      const pid = Number(/^PID (\d+)$/m.exec(log)?.[1]);
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an executable wrapper sibling unless it resolves to exact digest-pinned AGY_BIN", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-sibling-"));
    const wrapper = path.join(dir, "antigravity-acp");
    const configuredDir = path.join(dir, "configured");
    const configured = path.join(configuredDir, "agy");
    const sibling = path.join(dir, process.platform === "win32" ? "agy.exe" : "agy");
    fs.mkdirSync(configuredDir);
    fs.writeFileSync(wrapper, "wrapper");
    fs.writeFileSync(configured, "configured-runtime");
    fs.writeFileSync(sibling, "hostile-sibling");
    fs.chmodSync(wrapper, 0o755);
    fs.chmodSync(configured, 0o755);
    fs.chmodSync(sibling, 0o755);
    const digest = createHash("sha256").update(fs.readFileSync(configured)).digest("hex");
    try {
      expect(() => verifyAgyRuntimeIdentity(wrapper, configured, digest))
        .toThrow(/prefer an executable sibling/);
      fs.rmSync(sibling);
      fs.symlinkSync(configured, sibling);
      expect(() => verifyAgyRuntimeIdentity(wrapper, configured, digest)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps more than 25 exact model-baked variants separate with default-only effort", async () => {
    const models = Array.from({ length: 28 }, (_, i) => ({
      modelId: i === 7 ? "gemini-3.7-pro-high" : `raw-model-${i}`,
      displayName: `Raw Model ${i}`,
    }));
    const profile = makeAgyProfile(options({
      catalogProbe: async () => ({
        agyVersion: "agy 1.1.20",
        wrapperVersion: "antigravity-acp 1.1.0",
        models,
      }),
    }));
    const candidate = await profile.catalog.fetch();
    validateCandidate(candidate);
    expect(candidate.models).toHaveLength(28);
    expect(candidate.models.filter((row) => row.default).map((row) => row.id))
      .toEqual(["gemini-3.7-pro-high"]);
    for (const row of candidate.models) {
      expect(row.runtimeId).toBe(row.id);
      expect(row.aliases).toEqual([]);
      expect(row.effort).toMatchObject({
        mechanism: "modelBaked",
        choices: [{ id: "default" }],
        selectionDefault: "default",
      });
      expect(row.bindings).toEqual([{ model: row.id, effort: "default", rawModel: row.id }]);
      expect(row.evidence?.[0]).toMatchObject({
        kind: "live-observation",
        source: "agy-models+antigravity-acp-selection",
        resolvedModel: row.id,
      });
    }
  });

  it("rejects empty and missing-default candidates atomically", async () => {
    const empty = makeAgyProfile(options({ catalogProbe: async () => ({ agyVersion: "agy 1.1.20", models: [] }) }));
    await expect(empty.catalog.fetch()).rejects.toThrow(/empty/);
    const drift = makeAgyProfile(options({
      catalogProbe: async () => ({ agyVersion: "agy 1.1.20", models: [{ modelId: "other", displayName: "Other" }] }),
    }));
    await expect(drift.catalog.fetch()).rejects.toThrow(/does not resolve/);
  });

  it("rejects drift in the exact underlying AGY runtime version", async () => {
    const drift = makeAgyProfile(options({
      catalogProbe: async () => ({
        agyVersion: "agy 1.1.21",
        models: [{ modelId: "gemini-3.7-pro-high", displayName: "Gemini High" }],
      }),
    }));
    await expect(drift.catalog.fetch()).rejects.toThrow(/AGY_BIN version mismatch/);
  });

  it("retains the Seam LKG when a later AGY discovery is empty", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-lkg-"));
    const store = new ModelCatalogStore(path.join(dir, "catalog.db"));
    let models: Array<{ modelId: string; displayName: string }> = [
      { modelId: "gemini-3.7-pro-high", displayName: "Gemini High" },
      { modelId: "claude-thinking", displayName: "Claude Thinking" },
    ];
    const profile = makeAgyProfile(options({ catalogProbe: async () => ({ agyVersion: "agy 1.1.20", models }) }));
    const binding = { agentId: "agy", location: "local" };
    const service = new ModelCatalogService({
      store,
      logger: pino({ level: "silent" }) as unknown as Logger,
      bindings: () => [binding],
      scope: () => profile.catalog.scope(),
      fetch: () => profile.catalog.fetch(),
      isOnline: () => true,
      refreshCron: "0 0 1 1 *",
    });
    try {
      expect(await service.refresh(binding)).toMatchObject({ result: "published", ok: true });
      models = [];
      expect(await service.refresh(binding)).toMatchObject({ result: "retained", ok: false });
      expect(service.models(binding).map((row) => row.id)).toEqual([
        "gemini-3.7-pro-high",
        "claude-thinking",
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses exact raw ids and rejects duplicate/empty discovery", () => {
    expect(parseAgyModelsOutput("gemini-pro-high Gemini Pro High\nclaude-thinking Claude Thinking\n"))
      .toEqual([
        { modelId: "gemini-pro-high", displayName: "Gemini Pro High" },
        { modelId: "claude-thinking", displayName: "Claude Thinking" },
      ]);
    expect(() => parseAgyModelsOutput("\n")).toThrow(/no models/);
    expect(() => parseAgyModelsOutput("same One\nsame Two\n")).toThrow(/repeats/);
  });
});

describe("fresh agy discovery is reconciled against ACP", () => {
  const direct = [
    { modelId: "gemini-3.7-pro-high", displayName: "direct one" },
    { modelId: "claude-thinking", displayName: "direct two" },
  ];

  it("accepts an exact post-discovery update and acknowledges every selection serially", async () => {
    const rows = await reconcileAgyAcpModels({
      acpPath: fakeWrapper,
      cwd: "/tmp",
      env: {},
      direct,
      defaultModel: direct[0]!.modelId,
      timeoutMs: 5_000,
      spawnOverride: () => fakeAcpProcess(
        direct.map((row) => ({ value: row.modelId, name: `cached ${row.displayName}` })),
        true,
        direct.map((row) => ({ value: row.modelId, name: row.displayName }))
      ),
    });
    expect(rows.map((row) => row.modelId)).toEqual(direct.map((row) => row.modelId));
  });

  it("rejects matching startup cache followed by divergent post-discovery rows", async () => {
    let discoverySent = false;
    await expect(reconcileAgyAcpModels({
      acpPath: fakeWrapper,
      cwd: "/tmp",
      env: {},
      direct,
      defaultModel: direct[0]!.modelId,
      timeoutMs: 150,
      spawnOverride: () => fakeAcpProcess(
        direct.map((row) => ({ value: row.modelId, name: `stale ${row.displayName}` })),
        true,
        [{ value: "actual-runtime-only", name: "Actual runtime" }],
        25,
        () => { discoverySent = true; }
      ),
    })).rejects.toThrow(/reconcile|timeout/);
    expect(discoverySent).toBe(true);
  });

  it("retains LKG when matching startup cache is followed by divergent discovery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-stale-lkg-"));
    const store = new ModelCatalogStore(path.join(dir, "catalog.db"));
    let attempt = 0;
    const profile = makeAgyProfile(options({
      catalogProbe: async () => {
        attempt += 1;
        const rows = await reconcileAgyAcpModels({
          acpPath: fakeWrapper,
          cwd: "/tmp",
          env: {},
          direct,
          defaultModel: direct[0]!.modelId,
          timeoutMs: 150,
          spawnOverride: () => fakeAcpProcess(
            direct.map((row) => ({ value: row.modelId, name: `stale ${row.displayName}` })),
            true,
            attempt === 1
              ? direct.map((row) => ({ value: row.modelId, name: row.displayName }))
              : [{ value: "actual-runtime-only", name: "Actual runtime" }],
            20
          ),
        });
        return { agyVersion: "agy 1.1.20", models: rows };
      },
    }));
    const binding = { agentId: "agy", location: "local" };
    const service = new ModelCatalogService({
      store,
      logger: pino({ level: "silent" }) as unknown as Logger,
      bindings: () => [binding],
      scope: () => profile.catalog.scope(),
      fetch: () => profile.catalog.fetch(),
      isOnline: () => true,
      refreshCron: "0 0 1 1 *",
    });
    try {
      expect(await service.refresh(binding)).toMatchObject({ result: "published", ok: true });
      expect(await service.refresh(binding)).toMatchObject({ result: "retained", ok: false });
      expect(service.models(binding).map((row) => row.id)).toEqual(direct.map((row) => row.modelId));
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a startup fallback and waits for a matching discovery update", async () => {
    const rows = await reconcileAgyAcpModels({
      acpPath: fakeWrapper,
      cwd: "/tmp",
      env: {},
      direct,
      defaultModel: direct[0]!.modelId,
      timeoutMs: 5_000,
      spawnOverride: () => fakeAcpProcess(
        [{ value: "gemini-3.6-flash-medium", name: "hardcoded fallback" }],
        true,
        direct.map((row) => ({ value: row.modelId, name: row.displayName }))
      ),
    });
    expect(rows.map((row) => row.modelId)).toEqual(direct.map((row) => row.modelId));
  });

  it("rejects startup cache/fallback disagreement and model non-acknowledgement", async () => {
    await expect(reconcileAgyAcpModels({
      acpPath: fakeWrapper,
      cwd: "/tmp",
      env: {},
      direct,
      defaultModel: direct[0]!.modelId,
      timeoutMs: 100,
      spawnOverride: () => fakeAcpProcess([{ value: "fallback", name: "Fallback" }]),
    })).rejects.toThrow(/reconcile|timeout/);

    await expect(reconcileAgyAcpModels({
      acpPath: fakeWrapper,
      cwd: "/tmp",
      env: {},
      direct,
      defaultModel: direct[0]!.modelId,
      timeoutMs: 5_000,
      spawnOverride: () => fakeAcpProcess(
        direct.map((row) => ({ value: row.modelId, name: row.displayName })),
        false,
        direct.map((row) => ({ value: row.modelId, name: row.displayName }))
      ),
    })).rejects.toThrow(/did not acknowledge/);
  });
});
