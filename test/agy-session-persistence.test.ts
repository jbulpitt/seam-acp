import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgyProfile } from "@seam/adapters";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import {
  AGY_SESSION_BACKEND,
  AGY_SESSION_STORE_VERSION,
  AgySessionStore,
} from "../packages/adapters/src/agy-session-store.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createManagedAgyFixture, type ManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";

const fixtures = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));
const logger = pino({ level: "silent" }) as unknown as Logger;
const storeWriter = fileURLToPath(new URL("./fixtures/agy-session-store-writer.mjs", import.meta.url));

interface Harness {
  root: string;
  managed: ManagedAgyFixture;
  runtimes: AgentRuntime[];
}

const harnesses: Harness[] = [];

function makeHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r7-"));
  const managed = createManagedAgyFixture({
    source: path.join(fixtures, "fake-native-agy.mjs"),
    version: "agy fixture 1.1.28",
    cwd: root,
    approvedEnvironment: {
      SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtures,
      SEAM_AGY_CAPABILITY_INVOCATIONS: path.join(root, "invocations.jsonl"),
    },
  });
  const harness = { root, managed, runtimes: [] };
  harnesses.push(harness);
  return harness;
}

async function newRuntime(harness: Harness): Promise<AgentRuntime> {
  const profile = profileFor(harness);
  const runtime = new AgentRuntime({
    logger,
    profile,
  });
  harness.runtimes.push(runtime);
  await runtime.start();
  return runtime;
}

function profileFor(harness: Harness) {
  return makeAgyProfile({
    runtime: harness.managed.runtime,
    dataDir: harness.root,
    defaultModel: "Fixture Native Model",
    exposeGlobalStaging: false,
  });
}

function runStoreWriter(file: string, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [storeWriter, file, sessionId], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`store writer failed code=${code} signal=${signal}: ${stderr}`));
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) {
    for (const runtime of harness.runtimes) await runtime.dispose().catch(() => {});
    harness.managed.cleanup();
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

describe.sequential("AGY R7 session persistence", () => {
  it("keeps the prior complete snapshot when atomic rename is interrupted (#263)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r7-store-"));
    const file = path.join(root, "agy-sessions.json");
    const store = new AgySessionStore(file);
    try {
      await store.put("prior-session", {
        cascadeId: "11111111-1111-4111-8111-111111111111",
        maxStepIndex: 7,
        cwd: "/sanitized/workspace",
        modelId: "fixture-native-model",
      });
      const prior = fs.readFileSync(file, "utf8");
      vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(
        new Error("synthetic crash before atomic rename"),
      );

      await expect(store.put("interrupted-session", {
        maxStepIndex: -1,
        cwd: "/sanitized/workspace",
        modelId: "fixture-native-model-low",
      })).rejects.toThrow("AGY session persistence failed (write_failed)");
      expect(fs.readFileSync(file, "utf8")).toBe(prior);
      expect(fs.readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      const parsed = JSON.parse(prior);
      expect(parsed).toMatchObject({
        schemaVersion: AGY_SESSION_STORE_VERSION,
        backend: AGY_SESSION_BACKEND,
      });
      expect(parsed.sessions).toHaveProperty("prior-session");
      expect(parsed.sessions).not.toHaveProperty("interrupted-session");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not publish a replacement before its bytes are durably synced (#263)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r7-sync-"));
    const file = path.join(root, "agy-sessions.json");
    const store = new AgySessionStore(file);
    try {
      await store.put("prior-session", {
        maxStepIndex: -1,
        cwd: "/sanitized/workspace",
        modelId: "fixture-native-model",
      });
      const prior = fs.readFileSync(file, "utf8");
      const probe = await fsPromises.open(file, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
      await probe.close();
      vi.spyOn(fileHandlePrototype, "sync").mockRejectedValueOnce(
        new Error("synthetic crash before file fsync"),
      );

      await expect(store.put("unsynced-session", {
        maxStepIndex: -1,
        cwd: "/san/workSpace",
        modelId: "fixture-native-model-low",
      })).rejects.toThrow("AGY session persistence failed (write_failed)");
      expect(fs.readFileSync(file, "utf8")).toBe(prior);
      expect(fs.readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes independent OS-process writers without dropping either session (#263)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r7-process-"));
    const file = path.join(root, "agy-sessions.json");
    try {
      await Promise.all([
        runStoreWriter(file, "process-a"),
        runStoreWriter(file, "process-b"),
      ]);
      const sessions = await new AgySessionStore(file).list();
      expect(Object.keys(sessions).sort()).toEqual(["process-a", "process-b"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("quarantines corrupt input without replacing its only recoverable bytes (#263)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r7-corrupt-"));
    const file = path.join(root, "agy-sessions.json");
    const corrupt = "{ truncated sanitized fixture";
    fs.writeFileSync(file, corrupt);
    try {
      await expect(new AgySessionStore(file).put("new-session", {
        maxStepIndex: -1,
        cwd: "/sanitized/workspace",
        modelId: "fixture-native-model",
      })).rejects.toThrow("AGY session persistence failed (corrupt)");
      expect(fs.readFileSync(file, "utf8")).toBe(corrupt);
      const quarantine = fs.readdirSync(root).find((name) => name.includes(".corrupt-"));
      expect(quarantine).toBeTruthy();
      expect(fs.readFileSync(path.join(root, quarantine!), "utf8")).toBe(corrupt);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("advertises and honors explicit list/resume/close/delete lifecycle operations (#263)", async () => {
    const harness = makeHarness();
    const child = profileFor(harness).spawn();
    const connection = new ClientSideConnection(
      () => ({
        async requestPermission() {
          return { outcome: { outcome: "cancelled" as const } };
        },
        async sessionUpdate() {},
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    try {
      const initialized = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      expect(initialized.agentCapabilities).toMatchObject({
        loadSession: true,
        sessionCapabilities: {
          list: {},
          delete: {},
          resume: {},
          close: {},
        },
      });
      const created = await connection.newSession({
        cwd: harness.root,
        mcpServers: [],
      });
      const other = await connection.newSession({
        cwd: harness.root,
        mcpServers: [],
      });
      await expect(connection.listSessions({ cwd: harness.root })).resolves.toMatchObject({
        sessions: expect.arrayContaining([
          expect.objectContaining({ sessionId: created.sessionId, cwd: harness.root }),
          expect.objectContaining({ sessionId: other.sessionId, cwd: harness.root }),
        ]),
      });

      await expect(connection.closeSession({ sessionId: created.sessionId })).resolves.toEqual({});
      await expect(connection.closeSession({ sessionId: created.sessionId })).resolves.toEqual({});
      await expect(connection.resumeSession({
        sessionId: created.sessionId,
        cwd: harness.root,
        mcpServers: [],
      })).resolves.toHaveProperty("configOptions");
      await expect(connection.cancel({ sessionId: created.sessionId })).resolves.toBeUndefined();
      await expect(connection.cancel({ sessionId: created.sessionId })).resolves.toBeUndefined();
      await expect(connection.deleteSession({ sessionId: created.sessionId })).resolves.toEqual({});
      await expect(connection.listSessions({ cwd: harness.root })).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionId: other.sessionId })],
      });
      await expect(connection.loadSession({
        sessionId: created.sessionId,
        cwd: harness.root,
        mcpServers: [],
      })).rejects.toThrow("unknown AGY session");

      await connection.closeSession({ sessionId: other.sessionId });
      const mappingFile = path.join(harness.root, "agy-sessions.json");
      const document = JSON.parse(fs.readFileSync(mappingFile, "utf8"));
      document.sessions[other.sessionId].cascadeId = "../not-an-owned-conversation";
      fs.writeFileSync(mappingFile, `${JSON.stringify(document, null, 2)}\n`);
      await expect(connection.deleteSession({ sessionId: other.sessionId }))
        .rejects.toThrow("not an owned UUID");
      expect(JSON.parse(fs.readFileSync(mappingFile, "utf8")).sessions)
        .toHaveProperty(other.sessionId);
    } finally {
      child.kill();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      await Promise.race([
        connection.closed.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  }, 30_000);

  it("refuses a seam.db-only session id instead of silently creating another conversation (#263)", async () => {
    const harness = makeHarness();
    const owner = await newRuntime(harness);
    const known = await owner.newSession({
      cwd: harness.root,
      model: "fixture-native-model",
      strictModel: true,
    });
    const divergent = await newRuntime(harness);

    await expect(divergent.loadSession({
      sessionId: "seam-db-only-session",
      cwd: harness.root,
      model: "fixture-native-model",
      strictModel: true,
    })).rejects.toThrow("unknown AGY session seam-db-only-session");

    const unaffected = await newRuntime(harness);
    await expect(unaffected.loadSession({
      sessionId: known.sessionId,
      cwd: harness.root,
      model: "fixture-native-model",
      strictModel: true,
    })).resolves.toMatchObject({ sessionId: known.sessionId });
    await expect(unaffected.prompt("capability-turn-one"))
      .resolves.toMatchObject({ stopReason: "end_turn" });
  }, 20_000);

  it.each(["ephemeral", "conversation"] as const)("fails one %s session loudly when its conversation binding cannot be committed (#263)", async recoveryScope => {
    const harness = makeHarness();
    const failing = await newRuntime(harness);
    const exposed: string[] = [];
    failing.onEvent((event) => {
      if (event.kind === "agent-text" || event.kind === "agent-thought" || event.kind === "tool-start") {
        exposed.push(event.kind);
      }
    });
    await failing.newSession({
      cwd: harness.root,
      model: "fixture-native-model",
      strictModel: true,
    });
    const mappingFile = path.join(harness.root, "agy-sessions.json");
    const prior = fs.readFileSync(mappingFile, "utf8");
    const realRename = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, "rename").mockImplementationOnce(async () => {
      throw new Error("synthetic crash before atomic rename");
    });

    // #448's conversation owner can make one follow-up attempt, but the
    // adapter has retired this identity. It must NOT start another native turn.
    // Ephemeral work reports the first failure without attempting recovery.
    const failure = await failing.prompt("capability-turn-one", undefined, { recoveryScope }).catch(error => error);
    if (recoveryScope === "ephemeral") expect(failure.message).toContain("AGY session persistence failed");
    else expect(failure).toMatchObject({ data: { errorKind: "session_gone", details: expect.stringMatching(/unknown.*session/i) } });
    // The provider conversation id is committed before stream subscription;
    // if that commit fails, this one session is refused before any output can
    // be exposed while independent sessions remain available below.
    expect(exposed).toEqual([]);
    const invocations = fs.readFileSync(path.join(harness.root, "invocations.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    expect(invocations.filter(row => row.prompt === "capability-turn-one")).toHaveLength(1);
    rename.mockImplementation(realRename);
    expect(fs.readFileSync(mappingFile, "utf8")).toBe(prior);

    // Blast radius: the failed session is refused, while an independent
    // session on the same adapter/runtime remains usable.
    const healthy = await newRuntime(harness);
    await healthy.newSession({
      cwd: harness.root,
      model: "fixture-native-model-low",
      strictModel: true,
    });
    await expect(healthy.prompt("capability-turn-one"))
      .resolves.toMatchObject({ stopReason: "end_turn" });
  }, 20_000);
});
