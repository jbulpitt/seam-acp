import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, readFile, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import {
  SECRET_TTL_MS,
  recordThreadSecretPath,
  writeThreadSecret,
  listThreadSecrets,
  secretHarnessRules,
  sweepExpiredSecrets,
  assertSecretName,
} from "../packages/core/src/core/thread-secrets.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import type { DeliveryNonceLookup } from "../packages/core/src/platforms/chat-adapter.js";

describe("thread secrets", () => {
  it("rejects a bad name", () => {
    expect(() => assertSecretName("has space")).toThrow();
    expect(() => assertSecretName("../etc")).toThrow();
  });

  it("writes a 0600 file and lists its path without exposing the value", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "seam-sec-"));
    try {
      const written = await writeThreadSecret(dataDir, "thread-1", "API_KEY", "s3cret");
      expect(written.name).toBe("API_KEY");
      expect((await stat(written.absPath)).mode & 0o777).toBe(0o600);
      const body = await readFile(written.absPath, "utf8");
      expect(body).toBe("s3cret");
      const listed = await listThreadSecrets(dataDir, "thread-1");
      expect(listed.map((s) => s.name)).toEqual(["API_KEY"]);
      const rules = secretHarnessRules(listed);
      expect(rules[0]).toContain(written.absPath);
      expect(rules[0]).not.toContain("s3cret");
      expect(rules[0]).toContain("deleted about an hour after upload");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("lists a remote host path without retaining the secret value", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "seam-sec-ref-"));
    const remotePath = "/home/ubuntu/.seam/thread-secrets/thread-1/API_KEY";
    try {
      await recordThreadSecretPath(dataDir, "thread-1", "API_KEY", remotePath, 12);
      const listed = await listThreadSecrets(dataDir, "thread-1");
      expect(listed).toEqual([
        expect.objectContaining({ name: "API_KEY", absPath: remotePath }),
      ]);
      const metadata = await readFile(
        path.join(dataDir, "secrets", "thread-1", "API_KEY.meta.json"),
        "utf8"
      );
      expect(metadata).toContain(remotePath);
      expect(metadata).not.toContain("s3cret");
      const expired = new Date(Date.now() - SECRET_TTL_MS - 1_000);
      await utimes(
        path.join(dataDir, "secrets", "thread-1", "API_KEY.meta.json"),
        expired,
        expired
      );
      await sweepExpiredSecrets(dataDir);
      expect(await listThreadSecrets(dataDir, "thread-1")).toEqual([]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("defers a remote upload before writing the secret on the bound bridge", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "seam-sec-upload-"));
    const store = new SessionStore(path.join(dataDir, "test.db"));
    const value = "remote-only-secret";
    const remotePath = "/home/ubuntu/.seam/thread-secrets/thread-1/TOKEN";
    try {
      const orch = new Orchestrator({
        logger: pino({ level: "silent" }) as never,
        modelCatalog: fixtureModelCatalog([]),
        store,
        router: { listProfiles: () => [] } as never,
        adapter: {} as never,
        renderer: discordRenderer as never,
        config: {
          DATA_DIR: dataDir,
          REPOS_ROOT: "/synthetic",
          DEFAULT_MODEL: "test",
          threadPresets: new Map([["thread-1", { location: "staging-remote" }]]),
          channelPresets: new Map(),
          bridgePresets: new Map(),
        } as never,
      });
      const writeSecret = vi.fn(async () => ({ path: remotePath }));
      orch.setBridgeHub({ writeSecret } as never);
      const deferReply = vi.fn(async () => { submit.deferred = true; });
      const editReply = vi.fn(async () => {});
      const submit = {
        deferred: false, ephemeral: true,
        user: { id: "user-1" },
        fields: {
          getTextInputValue: (name: string) => name === "name" ? "TOKEN" : value,
        },
        deferReply,
        editReply,
      };
      const interaction = {
        id: "upload-1",
        user: { id: "user-1" },
        showModal: vi.fn(async () => {}),
        awaitModalSubmit: vi.fn(async () => submit),
      };
      (orch as never as { channelRefFromInteraction: () => unknown }).channelRefFromInteraction =
        () => ({ platform: "discord", id: "thread-1" });

      await (orch as never as { cmdUploadSecret(i: unknown): Promise<void> })
        .cmdUploadSecret(interaction);

      expect(deferReply).toHaveBeenCalledOnce();
      expect(deferReply.mock.invocationCallOrder[0]).toBeLessThan(
        writeSecret.mock.invocationCallOrder[0]!
      );
      expect(writeSecret).toHaveBeenCalledWith(
        "staging-remote",
        "thread-1",
        "TOKEN",
        Buffer.from(value),
        expect.any(Number)
      );
      expect((await listThreadSecrets(dataDir, "thread-1"))[0]?.absPath).toBe(remotePath);
      const metadata = await readFile(
        path.join(dataDir, "secrets", "thread-1", "TOKEN.meta.json"),
        "utf8"
      );
      expect(metadata).not.toContain(value);
      expect(JSON.stringify(editReply.mock.calls)).not.toContain(value);
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("survives an interrupted turn and its following turn, then expires by TTL", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "seam-sec-turns-"));
    const store = new SessionStore(path.join(dataDir, "test.db"));
    try {
      const written = await writeThreadSecret(dataDir, "thread-1", "API_KEY", "s3cret");
      const now = new Date().toISOString();
      const record = {
        id: "discord:thread-1",
        platform: "discord",
        channelRef: "thread-1",
        parentRef: null,
        agentId: "codex",
        acpSessionId: "synthetic-session",
        repoPath: "/synthetic",
        configJson: "{}",
        createdUtc: now,
        updatedUtc: now,
      };
      store.upsert(record);

      let call = 0;
      const valuesRead: string[] = [];
      const prompts: string[] = [];
      const runtime = {
        onEvent: vi.fn(),
        getSessionInfo: () => ({ sessionId: "synthetic-session" }),
        getProcessId: () => undefined,
        getProviderIdentity: () => "synthetic-codex",
        getFastModeOutcome: () => undefined,
        getPromptCapabilities: () => ({}),
        prompt: vi.fn(async (prompt: string) => {
          prompts.push(prompt);
          valuesRead.push(await readFile(written.absPath, "utf8"));
          call += 1;
          return call === 1
            ? { stopReason: "cancelled", cancelled: true }
            : { stopReason: "end_turn" };
        }),
        idle: async () => {},
        cancel: async () => {},
      };
      const router = {
        listProfiles: () => [],
        describeConfig: () => ({
          agent: { value: "codex" },
          model: { value: "test" },
          effort: { value: null },
          cwd: { value: "/synthetic" },
          location: { value: "local" },
          fastMode: { value: false },
        }),
        ensureSessionRecord: () => ({ ...record }),
        getProfile: () => undefined,
        getOrStartRuntime: vi.fn(async () => runtime),
      };
      const adapter = {
        sendPanel: vi.fn(async (channel: { id: string }) => ({ channel, id: "panel" })),
        sendMessage: vi.fn(async (channel: { id: string }) => ({ channel, id: "message" })),
        sendFile: vi.fn(async () => {}),
        findMessageByNonce: vi.fn(async (): Promise<DeliveryNonceLookup> => ({ status: "absent" })),
        editPanel: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      };
      const orch = new Orchestrator({
        logger: pino({ level: "silent" }) as never,
        modelCatalog: fixtureModelCatalog([]),
        store,
        router: router as never,
        adapter: adapter as never,
        renderer: discordRenderer as never,
        config: {
          DATA_DIR: dataDir,
          REPOS_ROOT: "/synthetic",
          TURN_TIMEOUT_SECONDS: 60,
          DEFAULT_MODEL: "test",
          REPO_EMOJIS: new Map(),
          channelPresets: new Map(),
          threadPresets: new Map(),
        } as never,
      });
      const run = (text: string) =>
        (orch as unknown as { handleIncomingMessageInner(message: unknown): Promise<void> })
          .handleIncomingMessageInner({
            channel: { platform: "discord", id: "thread-1" },
            authorId: "user",
            authorIsBot: false,
            text,
          });

      await run("interrupted turn");
      expect(await readFile(written.absPath, "utf8")).toBe("s3cret");
      await run("answer to the follow-up");
      expect(valuesRead).toEqual(["s3cret", "s3cret"]);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain(written.absPath);
      expect(await listThreadSecrets(dataDir, "thread-1")).toHaveLength(1);

      const expired = new Date(Date.now() - SECRET_TTL_MS - 1_000);
      await utimes(written.absPath, expired, expired);
      await sweepExpiredSecrets(dataDir);
      expect(await listThreadSecrets(dataDir, "thread-1")).toEqual([]);
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
