import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGY_CSRF_FLAG,
  fetchAgyUserStatus,
  makeAgyProfile,
  runBoundedProbe,
  subscribeToAgyStream,
  type AgentProfile,
} from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createManagedAgyFixture, type ManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";

const fixtures = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));
const fakeCli = path.join(fixtures, "fake-native-agy.mjs");
const logger = pino({ level: "silent" }) as unknown as Logger;
const cleanups: Array<() => void | Promise<void>> = [];

interface Invocation {
  pid?: number;
  scenario?: string;
  prompt?: string;
  conversationId?: string;
  resumedConversation?: string | null;
  args?: string[];
  csrfFingerprint?: string | null;
  rpc?: string;
  csrfStatus?: "missing" | "wrong" | "match";
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function rows(log: string): Invocation[] {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

function subject(extraEnv: Record<string, string> = {}): {
  root: string;
  log: string;
  managed: ManagedAgyFixture;
  profile: AgentProfile;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-csrf-"));
  const log = path.join(root, "invocations.ndjson");
  const managed = createManagedAgyFixture({
    source: fakeCli,
    version: "agy fixture 1.1.28",
    credentialScope: `antigravity-oauth:${randomUUID()}`,
    cwd: root,
    approvedEnvironment: {
      SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtures,
      SEAM_AGY_CAPABILITY_INVOCATIONS: log,
      ...extraEnv,
    },
  });
  const profile = makeAgyProfile({
    runtime: managed.runtime,
    dataDir: root,
    defaultModel: "fixture-native-model",
    exposeGlobalStaging: false,
  });
  cleanups.push(() => {
    managed.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, log, managed, profile };
}

function frame(flag: number, value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function authServer(expectedToken: string): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const supplied = request.headers["x-codeium-csrf-token"];
    response.statusCode = 200;
    response.setHeader("content-type", "application/connect+json");
    if (supplied !== expectedToken) {
      response.end(frame(2, { error: {
        code: "unauthenticated",
        message: supplied === undefined ? "missing CSRF token" : "invalid CSRF token",
      } }));
      return;
    }
    response.end(Buffer.concat([
      frame(0, { update: { status: "CASCADE_RUN_STATUS_RUNNING" } }),
      frame(2, {}),
    ]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, port: (server.address() as AddressInfo).port };
}

describe.sequential("#503 child-owned AGY CSRF authentication", () => {
  it("uses the matching header and reads HTTP-200 Connect rejection envelopes for missing and wrong controls", async () => {
    const token = "test-owned-csrf-capability-503";
    const { port } = await authServer(token);

    const statuses: string[] = [];
    for await (const update of subscribeToAgyStream({
      port,
      conversationId: "fixture",
      csrfToken: token,
    })) {
      if (update.status) statuses.push(update.status);
    }
    expect(statuses).toEqual(["CASCADE_RUN_STATUS_RUNNING"]);

    await expect((async () => {
      for await (const _ of subscribeToAgyStream({ port, conversationId: "fixture" })) { /* drain */ }
    })()).rejects.toMatchObject({
      streamCode: "unauthenticated",
      streamMessage: "missing CSRF token",
    });
    await expect((async () => {
      for await (const _ of subscribeToAgyStream({
        port,
        conversationId: "fixture",
        csrfToken: "wrong-csrf-capability",
      })) { /* drain */ }
    })()).rejects.toMatchObject({
      streamCode: "unauthenticated",
      streamMessage: "invalid CSRF token",
    });
  });

  it("authenticates stream and metadata with a fresh token on continuation", async () => {
    const f = subject({ SEAM_AGY_CSRF_MODE: "enforce" });
    const runtime = new AgentRuntime({ profile: f.profile, logger, spawnFn: f.profile.spawn.bind(f.profile) });
    cleanups.push(() => runtime.dispose().catch(() => {}));
    await runtime.start();
    await runtime.newSession({ cwd: f.root, model: "fixture-native-model", strictModel: true });
    await expect(runtime.prompt("capability-turn-one")).resolves.toMatchObject({ stopReason: "end_turn" });
    await expect(runtime.prompt("capability-turn-two")).resolves.toMatchObject({ stopReason: "end_turn" });
    await runtime.idle();

    const observed = rows(f.log);
    const turns = observed.filter((row) => row.pid && row.prompt?.startsWith("capability-turn"));
    expect(turns).toHaveLength(2);
    expect(turns.map((row) => row.csrfFingerprint)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(turns[0]?.csrfFingerprint).not.toBe(turns[1]?.csrfFingerprint);
    expect(turns[1]).toMatchObject({
      conversationId: "11111111-1111-4111-8111-111111111111",
      resumedConversation: "11111111-1111-4111-8111-111111111111",
    });
    const logFiles = turns.map((row) => row.args?.[row.args.indexOf("--log-file") + 1]);
    expect(logFiles[0]).toBeTypeOf("string");
    expect(logFiles[1]).toBeTypeOf("string");
    expect(logFiles[0]).not.toBe(logFiles[1]);
    expect(turns.every((row) => row.args?.includes(`${AGY_CSRF_FLAG}=[redacted]`))).toBe(true);

    const rpc = observed.filter((row) => row.scenario === "csrf-rpc");
    expect(rpc.some((row) => row.rpc === "GetAvailableModels")).toBe(true);
    expect(rpc.filter((row) => row.rpc === "StreamAgentStateUpdates")).toHaveLength(2);
    expect(rpc.every((row) => row.csrfStatus === "match")).toBe(true);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(f.root, "agy-sessions.json"), "utf8"),
    ) as { schemaVersion: number; backend: string; sessions: Record<string, Record<string, unknown>> };
    expect(Object.keys(persisted).sort()).toEqual(["backend", "schemaVersion", "sessions"]);
    const allowedSessionKeys = new Set([
      "backend", "cascadeId", "cwd", "maxStepIndex", "modelId", "updatedAt",
    ]);
    for (const record of Object.values(persisted.sessions)) {
      expect(Object.keys(record).every((key) => allowedSessionKeys.has(key))).toBe(true);
    }
    const durable = JSON.stringify(persisted);
    for (const turn of turns) expect(durable).not.toContain(turn.csrfFingerprint!);
  }, 20_000);

  it("keeps concurrent children on distinct launch/header pairs and private logs", async () => {
    const f = subject({ SEAM_AGY_CSRF_MODE: "enforce" });
    const first = new AgentRuntime({ profile: f.profile, logger, spawnFn: f.profile.spawn.bind(f.profile) });
    const second = new AgentRuntime({ profile: f.profile, logger, spawnFn: f.profile.spawn.bind(f.profile) });
    cleanups.push(() => Promise.all([first.dispose().catch(() => {}), second.dispose().catch(() => {})]).then(() => {}));
    await Promise.all([first.start(), second.start()]);
    await Promise.all([
      first.newSession({ cwd: f.root, model: "fixture-native-model", strictModel: true }),
      second.newSession({ cwd: f.root, model: "fixture-native-model-low", strictModel: true }),
    ]);
    await Promise.all([
      first.prompt("capability-model-a"),
      second.prompt("capability-model-b"),
    ]);
    await Promise.all([first.idle(), second.idle()]);

    const launches = rows(f.log).filter((row) => row.pid && row.prompt?.startsWith("capability-model-"));
    expect(launches).toHaveLength(2);
    expect(new Set(launches.map((row) => row.csrfFingerprint)).size).toBe(2);
    const logs = launches.map((row) => row.args?.[row.args.indexOf("--log-file") + 1]);
    expect(new Set(logs).size).toBe(2);
    const requestRows = rows(f.log).filter((row) =>
      row.scenario === "csrf-rpc" && launches.some((launch) => launch.csrfFingerprint === row.csrfFingerprint));
    expect(requestRows.filter((row) => row.rpc === "StreamAgentStateUpdates")).toHaveLength(2);
    expect(requestRows.every((row) => row.csrfStatus === "match")).toBe(true);
  }, 20_000);

  it("keeps stdout catalog discovery independent of LS availability and authenticates the finite quota RPC", async () => {
    const catalog = subject({
      SEAM_AGY_CSRF_MODE: "enforce",
      SEAM_AGY_MODELS_NO_LS: "1",
    });
    const candidate = await catalog.profile.catalog.fetch();
    expect(candidate.models.map((model) => model.id)).toEqual([
      "fixture-native-model",
      "fixture-native-model-low",
    ]);
    const catalogLaunch = rows(catalog.log).find((row) => row.pid && row.args?.includes("models"));
    expect(catalogLaunch).toMatchObject({ csrfFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(catalogLaunch?.args).toContain(`${AGY_CSRF_FLAG}=[redacted]`);
    expect(catalogLaunch?.args).not.toContain("-p");

    const quota = subject({
      SEAM_AGY_CSRF_MODE: "enforce",
      SEAM_AGY_QUOTA_500S: "0",
    });
    await expect(fetchAgyUserStatus(quota.managed.runtime)).resolves.toMatchObject({
      groups: [expect.objectContaining({ displayName: "Fixture plan" })],
    });
    const quotaRows = rows(quota.log);
    const quotaLaunch = quotaRows.find((row) => row.pid && row.args?.includes("models"));
    const quotaRpc = quotaRows.find((row) => row.rpc === "RetrieveUserQuotaSummary");
    expect(quotaLaunch).toMatchObject({ csrfFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(quotaLaunch?.args).not.toContain("-p");
    expect(quotaRpc).toMatchObject({
      csrfStatus: "match",
      csrfFingerprint: quotaLaunch?.csrfFingerprint,
    });
  }, 20_000);

  it("detects unsupported flags only on a prompt-free child and never retries the real prompt", async () => {
    const f = subject({ SEAM_AGY_CSRF_FLAG_MODE: "unsupported" });
    const candidate = await f.profile.catalog.fetch();
    expect(candidate.models).toHaveLength(2);

    const runtime = new AgentRuntime({ profile: f.profile, logger, spawnFn: f.profile.spawn.bind(f.profile) });
    cleanups.push(() => runtime.dispose().catch(() => {}));
    await runtime.start();
    await runtime.newSession({ cwd: f.root, model: "fixture-native-model", strictModel: true });
    await expect(runtime.prompt("capability-turn-one")).resolves.toMatchObject({ stopReason: "end_turn" });
    await runtime.idle();

    const launches = rows(f.log).filter((row) => row.pid);
    const models = launches.filter((row) => row.args?.includes("models"));
    expect(models).toHaveLength(2);
    expect(models.map((row) => row.csrfFingerprint)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      null,
    ]);
    expect(models.every((row) => !row.args?.some((arg) => ["-p", "--print", "--prompt"].includes(arg)))).toBe(true);
    const prompts = launches.filter((row) => row.prompt === "capability-turn-one");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.csrfFingerprint).toBeNull();
    expect(prompts[0]?.args).not.toContain(`${AGY_CSRF_FLAG}=[redacted]`);
  }, 20_000);

  it("redacts an echoed per-child capability from the shared runner, stream error, log and durable catalog state", async () => {
    const explicitToken = "csrf-explicit-redaction-value";
    await expect(runBoundedProbe({
      executable: process.execPath,
      args: ["-e", `process.stderr.write(${JSON.stringify(explicitToken)}); process.exit(9)`],
      sensitiveValues: [explicitToken],
      timeoutMs: 2_000,
      run: async (handle) => handle.exited,
    })).rejects.toSatisfy((error: unknown) => {
      expect(String(error)).toContain("[redacted]");
      expect(String(error)).not.toContain(explicitToken);
      return true;
    });

    const streamToken = "csrf-stream-redaction-value";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(frame(2, {
      error: { code: "unauthenticated", message: `invalid CSRF token ${streamToken}` },
    })));
    const streamError = await (async () => {
      for await (const _ of subscribeToAgyStream({
        port: 1,
        conversationId: "fixture",
        csrfToken: streamToken,
      })) { /* drain */ }
    })().then(() => undefined, (error: unknown) => error);
    expect(String(streamError)).toContain("[redacted]");
    expect(String(streamError)).not.toContain(streamToken);
    vi.restoreAllMocks();

    const f = subject({ SEAM_AGY_CSRF_FLAG_MODE: "echo-fail" });
    const prepare = f.managed.runtime.prepare.bind(f.managed.runtime);
    let generatedToken = "";
    vi.spyOn(f.managed.runtime, "prepare").mockImplementation((args, cwd, options) => {
      const value = args.find((arg) => arg.startsWith(`${AGY_CSRF_FLAG}=`));
      generatedToken = value?.slice(AGY_CSRF_FLAG.length + 1) ?? generatedToken;
      return prepare(args, cwd, options);
    });
    const store = new ModelCatalogStore(path.join(f.root, "catalog.db"));
    cleanups.push(() => store.close());
    const captured: unknown[][] = [];
    const captureLogger = {
      info: (...args: unknown[]) => captured.push(args),
      warn: (...args: unknown[]) => captured.push(args),
    } as unknown as Logger;
    const binding = { agentId: "agy", location: "local" };
    const service = new ModelCatalogService({
      store,
      logger: captureLogger,
      bindings: () => [binding],
      fetch: () => f.profile.catalog.fetch(),
      scope: () => f.profile.catalog.scope(),
      refreshCron: "0 0 1 1 *",
    });
    cleanups.push(() => service.stop());
    const consoleRows: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { consoleRows.push(args); });
    const result = await service.refresh(binding);
    expect(generatedToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const exposed = JSON.stringify({
      result,
      durable: store.getRefreshStatus("agy@local"),
      captured,
      consoleRows,
    });
    expect(exposed).not.toContain(generatedToken);
    expect(exposed).not.toContain("synthetic child rejected csrf capability");
  }, 20_000);
});
