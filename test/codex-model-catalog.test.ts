import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { invokeAdapterRpc, makeCodexProfile } from "@seam/adapters";
import {
  ModelCatalogService,
  validateCandidate,
} from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const LIVE_MODELS = [
  {
    id: "gpt-6-astra",
    model: "gpt-6-astra",
    displayName: "GPT-6-Astra",
    description: "Frontier coding model.",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
      .map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    serviceTiers: [{ id: "priority", name: "Fast" }],
    isDefault: true,
  },
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol-runtime",
    displayName: "GPT-5.6-Sol",
    hidden: false,
    supportedReasoningEfforts: ["low", "high"]
      .map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
    defaultReasoningEffort: "low",
    inputModalities: ["text"],
    serviceTiers: [],
    isDefault: false,
  },
  {
    id: "internal-canary",
    model: "internal-canary",
    displayName: "Internal Canary",
    hidden: true,
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "high" }],
    defaultReasoningEffort: "high",
    inputModalities: ["text"],
    serviceTiers: [],
    isDefault: false,
  },
] as const;

function fixtureRuntime(root: string): { executable: string; callsPath: string } {
  const executable = path.join(root, "configured-codex-acp.mjs");
  const callsPath = path.join(root, "calls.jsonl");
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
const log = (event) => fs.appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(event) + "\\n");
log({ event: "start", args, cwd: process.cwd(), marker: process.env.CODEX_TEST_MARKER });
if (args.length === 1 && args[0] === "--version") {
  console.log("@agentclientprotocol/codex-acp 9.9.9");
  process.exit(0);
}
if (args.length === 0) process.exit(0);
if (args.join(" ") !== "cli app-server") process.exit(23);
process.on("exit", () => log({ event: "exit", args }));
process.on("SIGTERM", () => process.exit(0));
const mode = process.env.FAKE_CODEX_MODE_FILE
    ? fs.readFileSync(process.env.FAKE_CODEX_MODE_FILE, "utf8").trim()
    : "ok";
if (mode === "early-exit") process.exit(42);
const models = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_MODELS_FILE, "utf8"));
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "malformed") {
    process.stdout.write("{broken-json\\n");
    return;
  }
  if (mode === "timeout") return;
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "seam-catalog-collector/0.999.0 (fixture)" } }) + "\\n");
    return;
  }
  if (request.method === "model/list") {
    const empty = mode === "empty";
    const second = request.params?.cursor === "page-2";
    const data = empty ? [] : second ? models.slice(2) : models.slice(0, 2);
    const nextCursor = empty || second ? null : "page-2";
    const respond = () => process.stdout.write(JSON.stringify({ id: request.id, result: { data, nextCursor } }) + "\\n");
    if (mode === "slow-pages") setTimeout(respond, 300);
    else respond();
  }
});
`, "utf8");
  fs.chmodSync(executable, 0o755);
  return { executable, callsPath };
}

function setup(
  mode = "ok",
  signal?: AbortSignal,
  accountId = "fixture-account",
  catalogTimeoutMs = 1_500,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-live-catalog-"));
  roots.push(root);
  const runtime = fixtureRuntime(root);
  const modePath = path.join(root, "mode.txt");
  fs.writeFileSync(modePath, mode);
  const modelsPath = path.join(root, "models.json");
  fs.writeFileSync(modelsPath, JSON.stringify(LIVE_MODELS));
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { account_id: accountId },
  }));
  const cachePath = path.join(codexHome, "models_cache.json");
  fs.writeFileSync(cachePath, JSON.stringify({
    fetched_at: "1999-01-01T00:00:00Z",
    models: [
      {
        slug: "stale-cache-only",
        display_name: "Stale Cache Only",
        context_window: 111_000,
      },
      {
        slug: "gpt-6-astra",
        display_name: "Old Astra Name",
        context_window: 272_000,
        effective_context_window_percent: 95,
        supported_reasoning_levels: [{ effort: "low" }],
        default_reasoning_level: "low",
      },
    ],
  }));
  const profile = makeCodexProfile({
    cliPath: runtime.executable,
    defaultModel: "gpt-6-astra",
    sessionsRoot: path.join(codexHome, "sessions"),
    modelsCachePath: cachePath,
    staticModels: [
      { modelId: "stale-static-only", name: "Stale Static", contextLimit: 123_000 },
      { modelId: "gpt-5.6-sol", name: "Configured Sol", contextLimit: 200_000 },
    ],
    extraEnv: {
      CODEX_HOME: codexHome,
      CODEX_TEST_MARKER: "same-session-environment",
      FAKE_CODEX_CALLS: runtime.callsPath,
      FAKE_CODEX_MODE_FILE: modePath,
      FAKE_CODEX_MODELS_FILE: modelsPath,
    },
    catalogTimeoutMs,
    ...(signal ? { catalogAbortSignal: signal } : {}),
  });
  return { ...runtime, profile, root, modePath, modelsPath };
}

function calls(callsPath: string): Array<{
  event: "start" | "exit";
  args: string[];
  cwd?: string;
  marker?: string;
  pid?: number;
  ppid?: number;
}> {
  if (!fs.existsSync(callsPath)) return [];
  const contents = fs.readFileSync(callsPath, "utf8").trim();
  return contents ? contents.split("\n").map((line) => JSON.parse(line)) : [];
}

function executableOnPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is required for configured-runtime coverage`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function installedWrapperSetup(mode: "ok" | "timeout") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-path-catalog-"));
  roots.push(root);
  const codexPath = path.join(root, "codex-fixture.mjs");
  const callsPath = path.join(root, "nested-calls.jsonl");
  const modelsPath = path.join(root, "models.json");
  fs.writeFileSync(modelsPath, JSON.stringify([LIVE_MODELS[0]]));
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
const log = (event) => fs.appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(event) + "\\n");
log({ event: "start", args, pid: process.pid, ppid: process.ppid });
process.on("exit", () => log({ event: "exit", args, pid: process.pid, ppid: process.ppid }));
process.on("SIGTERM", () => process.exit(0));
if (args.join(" ") !== "app-server") process.exit(23);
const models = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_MODELS_FILE, "utf8"));
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (process.env.FAKE_CODEX_MODE === "timeout") return;
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "seam-catalog-collector/7.7.7 (CODEX_PATH fixture)" } }) + "\\n");
  } else if (request.method === "model/list") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { data: models, nextCursor: null } }) + "\\n");
  }
});
lines.on("close", () => process.exit(0));
`);
  fs.chmodSync(codexPath, 0o755);
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { account_id: "installed-wrapper-fixture" },
  }));
  const profile = makeCodexProfile({
    cliPath: executableOnPath("codex-acp"),
    defaultModel: "gpt-6-astra",
    sessionsRoot: path.join(codexHome, "sessions"),
    extraEnv: {
      CODEX_HOME: codexHome,
      CODEX_PATH: codexPath,
      FAKE_CODEX_CALLS: callsPath,
      FAKE_CODEX_MODELS_FILE: modelsPath,
      FAKE_CODEX_MODE: mode,
    },
    catalogTimeoutMs: 3_000,
  });
  return { profile, callsPath };
}

describe("Codex live model catalog", () => {
  it("uses the configured codex-acp app server and treats cache/static rows as exact-id enrichment only", async () => {
    const { profile, callsPath } = setup();
    const catalog = await profile.catalog.fetch();
    validateCandidate(catalog);

    expect(catalog.source).toBe("codex-acp-app-server");
    expect(catalog.cliVersion).toBe("@agentclientprotocol/codex-acp 9.9.9");
    expect(catalog.sourceVersion).toBe("codex-cli 0.999.0");
    expect(catalog.scope).toMatchObject({
      provider: "openai",
      credentialProfile: expect.stringMatching(/^account-[a-f0-9]{24}$/),
    });
    expect(catalog.scope).not.toHaveProperty("policy");
    expect(Number.isFinite(Date.parse(catalog.fetchedAt))).toBe(true);
    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
    expect(catalog.models.find((model) => model.default)?.id).toBe("gpt-6-astra");

    const astra = catalog.models[0]!;
    expect(astra.displayName).toBe("GPT-6-Astra");
    expect(astra.description).toBe("Frontier coding model.");
    expect(astra.aliases).not.toContain("legacy-default");
    expect(astra.context).toEqual({ native: 272_000, maximum: 272_000, effective: 258_400 });
    expect(astra.visionMode).toBe("native");
    expect(astra.serviceTiers).toEqual(["priority"]);
    expect(astra.effort).toMatchObject({
      selectionDefault: "medium",
      choices: ["low", "medium", "high", "xhigh", "max", "ultra"]
        .map((id) => ({ id, raw: id })),
    });
    expect(astra.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live-observation",
        source: "codex-app-server-model-list",
        runtimeVersion: "@agentclientprotocol/codex-acp 9.9.9 / codex-cli 0.999.0",
        resolvedModel: "gpt-6-astra",
        effort: {
          choices: ["low", "medium", "high", "xhigh", "max", "ultra"],
          selectionDefault: "medium",
          method: "model-list",
        },
      }),
      expect.objectContaining({
        kind: "enrichment",
        source: "codex-model-cache",
        observedAt: "1999-01-01T00:00:00Z",
        resolvedModel: "gpt-6-astra",
        context: { native: 272_000, maximum: 272_000, effective: 258_400, method: "exact-id" },
      }),
    ]));

    const sol = catalog.models[1]!;
    expect(sol.runtimeId).toBe("gpt-5.6-sol-runtime");
    expect(sol.aliases).toContain("gpt-5.6-sol-runtime");
    expect(sol.context).toEqual({ native: 200_000, maximum: 200_000, effective: 200_000 });
    expect(sol.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "enrichment", source: "codex-static-model-metadata" }),
    ]));
    expect(sol.effort).toMatchObject({
      selectionDefault: "low",
      choices: [{ id: "low", raw: "low" }, { id: "high", raw: "high" }],
    });
    expect(sol.bindings).toEqual([
      { model: "gpt-5.6-sol", effort: "low", rawModel: "gpt-5.6-sol-runtime", rawEffort: "low" },
      { model: "gpt-5.6-sol", effort: "high", rawModel: "gpt-5.6-sol-runtime", rawEffort: "high" },
    ]);

    const sessionChild = profile.spawn();
    await once(sessionChild, "close");
    expect(calls(callsPath)).toEqual([
      {
        event: "start",
        args: ["cli", "app-server"],
        cwd: process.cwd(),
        marker: "same-session-environment",
      },
      { event: "exit", args: ["cli", "app-server"] },
      {
        event: "start",
        args: ["--version"],
        cwd: process.cwd(),
        marker: "same-session-environment",
      },
      {
        event: "start",
        args: [],
        cwd: process.cwd(),
        marker: "same-session-environment",
      },
    ]);
  });

  it("runs the same configured host collector through the remote adapter RPC boundary", async () => {
    const { profile, callsPath } = setup();
    const result = await invokeAdapterRpc("fetchModelCatalog", {}, {
      adapter: profile,
      workspaceRoot: "/remote/workspaces",
    });
    const catalog = result as Awaited<ReturnType<typeof profile.catalog.fetch>>;
    validateCandidate(catalog);
    expect(catalog.models.some((model) => model.id === "gpt-6-astra")).toBe(true);
    expect(catalog.models.find((model) => model.default)?.id).toBe("gpt-6-astra");
    expect(calls(callsPath)[0]).toEqual({
      event: "start",
      args: ["cli", "app-server"],
      cwd: process.cwd(),
      marker: "same-session-environment",
    });
  });

  it("routes collection through the installed codex-acp CODEX_PATH and reaps wrapper plus app-server", async () => {
    const { profile, callsPath } = installedWrapperSetup("ok");
    const catalog = await profile.catalog.fetch();
    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
    const events = calls(callsPath);
    expect(events.map((event) => ({ event: event.event, args: event.args }))).toEqual([
      { event: "start", args: ["app-server"] },
      { event: "exit", args: ["app-server"] },
    ]);
    expect(processExists(events[0]!.pid!)).toBe(false);
    expect(processExists(events[0]!.ppid!)).toBe(false);
  });

  it("reaps the installed codex-acp wrapper and nested app-server after a deadline", async () => {
    const { profile, callsPath } = installedWrapperSetup("timeout");
    await expect(profile.catalog.fetch()).rejects.toThrow(/timed out after 3000ms/);
    const start = calls(callsPath).find((event) => event.event === "start")!;
    expect(start).toBeDefined();
    await vi.waitFor(() => expect(processExists(start.pid!)).toBe(false));
    await vi.waitFor(() => expect(processExists(start.ppid!)).toBe(false));
  }, 10_000);

  it("gives equivalent local and bridge-host runtimes the same semantic scope", () => {
    const local = setup();
    const remote = setup();
    expect(local.executable).not.toBe(remote.executable);
    expect(local.profile.catalog.scope()).toEqual(remote.profile.catalog.scope());
  });

  it("separates distinct Codex accounts without including host paths in scope identity", () => {
    const first = setup("ok", undefined, "account-a");
    const second = setup("ok", undefined, "account-b");
    expect(first.profile.catalog.scope().fingerprint).not.toBe(second.profile.catalog.scope().fingerprint);
    expect(first.profile.catalog.scope().credentialProfile).not.toBe(second.profile.catalog.scope().credentialProfile);
    expect(first.profile.catalog.scope().credentialProfile).not.toContain(first.root);
    expect(second.profile.catalog.scope().credentialProfile).not.toContain(second.root);
  });

  it("rejects a stale or misspelled configured default as drift", async () => {
    const { profile, root, executable, modelsPath, modePath, callsPath } = setup();
    const drifted = makeCodexProfile({
      cliPath: executable,
      defaultModel: "gpt-6-astrra",
      modelsCachePath: path.join(root, ".codex", "models_cache.json"),
      extraEnv: {
        CODEX_HOME: path.join(root, ".codex"),
        FAKE_CODEX_CALLS: callsPath,
        FAKE_CODEX_MODE_FILE: modePath,
        FAKE_CODEX_MODELS_FILE: modelsPath,
      },
      catalogTimeoutMs: 500,
    });
    await expect(drifted.catalog.fetch()).rejects.toThrow(/configuration drift must be corrected/);
    expect(profile.catalog.scope()).toEqual(drifted.catalog.scope());
  });

  it("redacts hostile wrapper-version stderr and paths from returned and durable failures", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hostile-version-path-"));
    roots.push(root);
    const executable = path.join(root, "hostile-codex-acp.mjs");
    const secret = "sk-hostile-wrapper-version-secret";
    fs.writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stderr.write("OPENAI_API_KEY=" + process.env.OPENAI_API_KEY + "\\n");
  process.exit(19);
}
process.exit(23);
`);
    fs.chmodSync(executable, 0o755);
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome);
    const profile = makeCodexProfile({
      cliPath: executable,
      defaultModel: "gpt-6-astra",
      sessionsRoot: path.join(codexHome, "sessions"),
      extraEnv: { CODEX_HOME: codexHome, OPENAI_API_KEY: secret },
      catalogProbe: async () => ({
        runtimeVersion: "codex-cli hostile-fixture",
        models: [LIVE_MODELS[0]],
      }),
    });
    const store = new ModelCatalogStore(path.join(root, "catalog.db"));
    const binding = { agentId: "codex", location: "local" };
    const service = new ModelCatalogService({
      store,
      logger: pino({ level: "silent" }) as unknown as Logger,
      bindings: () => [binding],
      fetch: () => profile.catalog.fetch(),
      scope: () => profile.catalog.scope(),
      refreshCron: "0 0 1 1 *",
    });
    try {
      const result = await service.refresh(binding);
      expect(result).toMatchObject({
        ok: false,
        result: "retained",
        error: "exited_early: Codex ACP wrapper version command exited (code=19, signal=none)",
      });
      const persisted = store.getRefreshStatus("codex@local");
      expect(persisted?.error).toBe(result.error);
      for (const exposed of [result.error, persisted?.error]) {
        expect(exposed).not.toContain(secret);
        expect(exposed).not.toContain(executable);
        expect(exposed).not.toContain(root);
      }
    } finally {
      service.stop();
      store.close();
    }
  });

  it.each([
    ["malformed", /malformed JSON/],
    ["empty", /no selectable models/],
    ["early-exit", /code=42/],
    ["timeout", /timed out/],
  ])("rejects %s app-server output so the catalog service retains its prior generation", async (mode, error) => {
    const { profile, callsPath } = setup(mode);
    await expect(profile.catalog.fetch()).rejects.toThrow(error);
    expect(calls(callsPath)).toContainEqual({ event: "exit", args: ["cli", "app-server"] });
  });

  it("uses one overall deadline across all model/list pages", async () => {
    const { profile, callsPath } = setup("slow-pages", undefined, "fixture-account", 500);
    await expect(profile.catalog.fetch()).rejects.toThrow(/timed out after 500ms/);
    expect(calls(callsPath)).toContainEqual({ event: "exit", args: ["cli", "app-server"] });
  });

  it("awaits app-server cleanup when collection is cancelled", async () => {
    const controller = new AbortController();
    const { profile, callsPath } = setup("timeout", controller.signal);
    const fetch = profile.catalog.fetch();
    await vi.waitFor(() => expect(calls(callsPath)).toContainEqual(expect.objectContaining({
      event: "start",
      args: ["cli", "app-server"],
    })));
    controller.abort();
    await expect(fetch).rejects.toThrow(/cancelled/);
    expect(calls(callsPath)).toContainEqual({ event: "exit", args: ["cli", "app-server"] });
  });

  it("rejects the whole live response when one selectable model is malformed", async () => {
    const { profile, modelsPath, callsPath } = setup();
    const malformed = structuredClone(LIVE_MODELS) as unknown as Array<Record<string, unknown>>;
    malformed[1]!.serviceTiers = [{ name: "missing-id" }];
    fs.writeFileSync(modelsPath, JSON.stringify(malformed));
    await expect(profile.catalog.fetch()).rejects.toThrow(/malformed serviceTiers/);
    expect(calls(callsPath)).toContainEqual({ event: "exit", args: ["cli", "app-server"] });
  });

  it("validates malformed hidden rows before filtering them out", async () => {
    const { profile, modelsPath, callsPath } = setup();
    const malformed = structuredClone(LIVE_MODELS) as unknown as Array<Record<string, unknown>>;
    malformed[2]!.serviceTiers = [{ name: "missing-id" }];
    fs.writeFileSync(modelsPath, JSON.stringify(malformed));
    await expect(profile.catalog.fetch()).rejects.toThrow(/malformed serviceTiers/);
    expect(calls(callsPath)).toContainEqual({ event: "exit", args: ["cli", "app-server"] });
  });

  it("does not change the static Ollama Cloud collector that shares the Codex harness", async () => {
    const { executable, callsPath, root } = setup();
    fs.writeFileSync(callsPath, "");
    const profile = makeCodexProfile({
      id: "ollama-cloud",
      cliPath: executable,
      defaultModel: "qwen:cloud",
      sessionsRoot: path.join(root, "ollama-sessions"),
      staticModels: [{ modelId: "qwen:cloud", name: "Qwen", contextLimit: 200_000 }],
    });
    const catalog = await profile.catalog.fetch();
    expect(catalog.source).toBe("validated-manifest");
    expect(catalog.models.map((model) => model.id)).toEqual(["qwen:cloud"]);
    expect(calls(callsPath).some((call) => call.args.join(" ") === "cli app-server")).toBe(false);
  });

  it("retains the previous Codex generation when the configured app server later fails", async () => {
    const { profile, root, modePath, modelsPath } = setup();
    const store = new ModelCatalogStore(path.join(root, "catalog.db"));
    const binding = { agentId: "codex", location: "local" };
    const service = new ModelCatalogService({
      store,
      logger: pino({ level: "silent" }) as unknown as Logger,
      bindings: () => [binding],
      fetch: () => profile.catalog.fetch(),
      scope: () => profile.catalog.scope(),
      refreshCron: "0 0 1 1 *",
    });
    try {
      const published = await service.refresh(binding);
      expect(published).toMatchObject({ result: "published", ok: true });
      const generationA = service.lookup(binding).snapshot?.generation;

      const modelsB = structuredClone(LIVE_MODELS) as unknown as Array<Record<string, unknown>>;
      modelsB[0]!.displayName = "GPT-6-Astra Updated";
      fs.writeFileSync(modelsPath, JSON.stringify(modelsB));
      const updated = await service.refresh(binding);
      expect(updated).toMatchObject({ result: "published", ok: true });
      const generationB = service.lookup(binding).snapshot?.generation;
      expect(generationB).toBe((generationA ?? 0) + 1);

      fs.writeFileSync(modePath, "malformed");
      await expect(service.refresh(binding)).resolves.toMatchObject({
        result: "retained",
        ok: false,
        generation: generationB,
        error: expect.stringMatching(/malformed JSON/),
      });
      expect(service.lookup(binding).snapshot?.generation).toBe(generationB);
      expect(service.model(binding, "gpt-6-astra")?.displayName).toBe("GPT-6-Astra Updated");
      expect(service.models(binding).some((model) => model.id === "gpt-6-astra")).toBe(true);
    } finally {
      service.stop();
      store.close();
    }
  }, 15_000);
});
