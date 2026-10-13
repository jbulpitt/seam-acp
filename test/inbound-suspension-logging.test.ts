import { testSessionRouter } from "./helpers/session-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { DispatchSuspendedError, inboundAttemptId } from "../packages/core/src/core/dispatch/attempt-store.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ChannelQueueFencedError, Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

async function receive(error: Error, recovered = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "seam-inbound-log-"));
  const store = new SessionStore(path.join(dir, "sessions.db"));
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write(line: string) { lines.push(line); } });
  const now = new Date().toISOString();
  const record = { id: "discord:worker", platform: "discord", channelRef: "worker", parentRef: null,
    agentId: "codex", acpSessionId: "recorded-acp", repoPath: dir, configJson: "{}",
    createdUtc: now, updatedUtc: now };
  store.upsert(record);
  store.turnAttempts.registerOwner("fixture-owner");
  const host = new Orchestrator({ logger, store, modelCatalog: fixtureModelCatalog([]),
    config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60,
      channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map() } as never,
    router: testSessionRouter({ listProfiles: () => [], ensureSessionRecord: () => record,
      describeConfig: () => ({ agent: { value: "codex" }, model: { value: "fixture-model" },
        role: { value: null }, disableThreadPrefix: { value: false },
        effort: { value: null }, location: { value: "local" }, cwd: { value: dir } }),
    }) as never,
    adapter: {} as never, renderer: {} as never,
  });
  const message: IncomingMessage = { messageId: "901", channel: { platform: "discord", id: "worker" },
    authorId: "user", authorIsBot: false, text: "original brief" };
  let suspended: ReturnType<typeof store.turnAttempts.get>;
  const inner = vi.fn(async () => {
    const attempt = store.turnAttempts.claim({ id: inboundAttemptId(message.messageId!),
      target: "worker", prompt: message.text, session: "live", createdUtc: now },
      "fixture-identity", "fixture-owner", "inbound");
    if (error instanceof DispatchSuspendedError && error.suspension === "defect") {
      store.turnAttempts.markStalled(attempt.id, error.reason);
    } else {
      store.turnAttempts.suspend(attempt.id, "fixture-owner");
    }
    suspended = store.turnAttempts.get(attempt.id);
    throw error;
  });
  Object.assign(host, {
    tryConsumeConfigEditorRiderUpload: async () => false,
    wouldParkForOfflineBridge: () => false,
    tryParkForOfflineBridge: async () => false,
    handleIncomingMessageInner: inner,
  });
  try {
    if (recovered) {
      store.admitInbound({ messageId: message.messageId!, platform: message.channel.platform,
        channelRef: message.channel.id, parentRef: null, sessionRecordId: record.id,
        authorId: message.authorId, authorName: null, text: message.text, attachments: [], createdUtc: now });
      const row = store.getInbound(message.messageId!)!;
      await (host as unknown as { startRecoveredInbound(admission: typeof row): Promise<void> })
        .startRecoveredInbound(row);
    } else {
      await (host as unknown as { handleIncomingMessage(msg: IncomingMessage): Promise<void> })
        .handleIncomingMessage(message);
    }
    expect(inner).toHaveBeenCalledTimes(1);
    expect(store.turnAttempts.get(inboundAttemptId(message.messageId!))).toEqual(suspended!);
    expect(store.getInbound(message.messageId!)?.state).toBe("running");
    return lines.map(line => JSON.parse(line));
  } finally {
    await host.loadPlugins();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("inbound suspension logging", () => {
  it.each([
    ["shutdown", "restart cutoff reached before execution began"],
    ["superseded", "generation 3 was replaced by generation 4"],
  ] as const)("logs %s at info with its reason, leaving the attempt suspended", async (kind, reason) => {
    const error = DispatchSuspendedError[kind]("inbound-901", reason);
    const logs = await receive(error);
    expect(logs.filter(log => log.level >= 50)).toEqual([]);
    expect(logs.find(log => log.suspension === kind)).toMatchObject({
      level: 30, channelId: "worker", reason,
      err: { type: "DispatchSuspendedError", reason, suspension: kind },
    });
  });

  it("keeps a defect at error with its original cause", async () => {
    const reason = "recorded provider identity is corrupt";
    const logs = await receive(DispatchSuspendedError.defect("inbound-901", reason));
    expect(logs.filter(log => log.level >= 50)).toEqual([
      expect.objectContaining({ level: 50, channelId: "worker", msg: "error in handleIncomingMessageInner",
        err: expect.objectContaining({ type: "DispatchSuspendedError", message: reason, reason, suspension: "defect" }) }),
    ]);
  });

  it("keeps an ordinary error at error with its cause", async () => {
    const logs = await receive(new Error("SQLITE_BUSY"));
    expect(logs.filter(log => log.level >= 50)).toEqual([
      expect.objectContaining({ level: 50, msg: "error in handleIncomingMessageInner",
        err: expect.objectContaining({ message: "SQLITE_BUSY" }) }),
    ]);
  });

  it("keeps an obsolete channel queue fence silent", async () => {
    const logs = await receive(new ChannelQueueFencedError("worker", 0));
    expect(logs.filter(log => log.channelId === "worker" && log.level >= 30)).toEqual([]);
  });
});

describe("recovered inbound suspension logging", () => {
  it("logs only shutdown at info with its reason, leaving the attempt suspended", async () => {
    const reason = "restart cutoff reached before this turn finished";
    const logs = await receive(DispatchSuspendedError.shutdown("inbound-901", reason), true);
    expect(logs.filter(log => log.level >= 50)).toEqual([]);
    expect(logs.find(log => log.suspension === "shutdown")).toMatchObject({
      level: 30, channelRef: "worker", messageId: "901", reason,
      err: { type: "DispatchSuspendedError", reason, suspension: "shutdown" },
    });
  });

  it.each([
    ["superseded", "a newer attempt generation owns this turn"],
    ["retryable", "provider acquisition failed before the prompt"],
    ["defect", "recorded provider identity is corrupt"],
  ] as const)("keeps %s at error with its reason", async (kind, reason) => {
    const logs = await receive(DispatchSuspendedError[kind]("inbound-901", reason), true);
    expect(logs.filter(log => log.level >= 50)).toEqual([
      expect.objectContaining({ level: 50, channelRef: "worker", messageId: "901",
        msg: "recovered inbound turn failed",
        err: expect.objectContaining({ type: "DispatchSuspendedError", reason, suspension: kind }) }),
    ]);
  });

  it("keeps a retryable suspension's transport cause at error", async () => {
    const reason = "provider acquisition failed before the prompt";
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:4444");
    const logs = await receive(DispatchSuspendedError.retryable("inbound-901", reason, cause), true);
    const entry = logs.find(log => log.msg === "recovered inbound turn failed");
    expect(entry).toMatchObject({ level: 50,
      err: { reason, suspension: "retryable", message: expect.stringContaining(cause.message) } });
  });

  it("keeps an ordinary error at error with its cause", async () => {
    const logs = await receive(new Error("SQLITE_BUSY"), true);
    expect(logs.filter(log => log.level >= 50)).toEqual([
      expect.objectContaining({ level: 50, msg: "recovered inbound turn failed",
        err: expect.objectContaining({ message: "SQLITE_BUSY" }) }),
    ]);
  });

  it("keeps an obsolete channel queue fence silent", async () => {
    const logs = await receive(new ChannelQueueFencedError("worker", 0), true);
    expect(logs.filter(log => log.channelRef === "worker" && log.level >= 30)).toEqual([]);
  });
});
