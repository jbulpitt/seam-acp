/**
 * #170 — `dispatchInjectTurn` must not re-record a spec that is already in the
 * ledger.
 *
 * Two upstream paths write the row before the dispatcher ever sees the spec:
 * a report-back's #77 correlation claim (`claimAndEnqueueReportBack` ledgers
 * under the same `spec.id` *before* enqueueing), and crash recovery
 * re-dispatching a spec that was ledgered on its first run. Re-inserting either
 * violates the partial unique index from #77, so the best-effort warn fired on
 * the SUCCESS path of essentially every report-back — 458 warnings in six days,
 * drowning the signal a genuine ledger failure needs to send.
 *
 * These tests run against a REAL `SessionStore`, so the constraint being
 * dodged is the actual one, and they assert on captured log records rather
 * than on source text.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { ChannelRef, MessageRef } from "../packages/core/src/platforms/chat-adapter.js";

interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}

/** Captures what the orchestrator actually logged, at every level. */
function capturingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const at =
    (level: LogRecord["level"]) =>
    (obj: unknown, msg?: string): void => {
      if (typeof obj === "string") records.push({ level, obj: {}, msg: obj });
      else records.push({ level, obj: (obj ?? {}) as Record<string, unknown>, msg: msg ?? "" });
    };
  const logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("error"),
    trace: at("debug"),
    child: () => logger,
    level: "debug",
  };
  return { logger: logger as unknown as Logger, records };
}

const sessionRecord = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-w",
  platform: "discord",
  channelRef: "thread-w",
  parentRef: null,
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-01-01T00:00:00Z",
  updatedUtc: "2026-01-01T00:00:00Z",
  ...over,
});

/** Minimal runtime that answers immediately and stops cleanly. */
function fakeRuntime() {
  let handler: ((e: unknown) => void | Promise<void>) | undefined;
  return {
    onEvent(h: (e: unknown) => void | Promise<void>) {
      handler = h;
    },
    async prompt() {
      await handler?.({ kind: "agent-text", text: "done" });
      return { stopReason: "end_turn" };
    },
    async idle() {},
    getSessionInfo() {
      return { sessionId: "acp-1" };
    },
    async dispose() {},
  };
}

function spyAdapter() {
  let n = 0;
  return {
    async sendPanel(channel: ChannelRef): Promise<MessageRef> {
      return { channel, id: `panel-${++n}` };
    },
    async editPanel(): Promise<void> {},
    async sendMessage(channel: ChannelRef): Promise<MessageRef> {
      return { channel, id: `msg-${++n}` };
    },
    async editMessage(): Promise<void> {},
    async sendFile(channel: ChannelRef): Promise<MessageRef> {
      return { channel, id: `file-${++n}` };
    },
  };
}

function makeOrch(dataDir: string, store: SessionStore, logger: Logger): Orchestrator {
  const rt = fakeRuntime();
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    ensureSessionRecord: ({ channelRef }: { channelRef: string }) =>
      sessionRecord({ id: `discord:${channelRef}`, channelRef }),
    getProfile: () => undefined,
    getOrStartRuntime: async () => rt,
  };
  const config = {
    DATA_DIR: dataDir,
    REPOS_ROOT: "/repo",
    TURN_TIMEOUT_SECONDS: 60,
    DEFAULT_MODEL: "default",
    CHANNEL_PRESETS_FILE: undefined,
    SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
    SEAM_DISPATCH_OUTPUT_STYLE: "messages",
    SEAM_DISPATCH_STATUS_PANEL: false,
    REPO_EMOJIS: new Map<string, string>(),
    channelPresets: {},
    threadPresets: {},
  };
  return new Orchestrator({
    logger,
    config: config as never,
    adapter: spyAdapter() as never,
    router: router as never,
    store: store as never,
    renderer: discordRenderer as never,
  });
}

const spec = (over: Partial<DispatchSpec> = {}): DispatchSpec => ({
  id: "disp-1",
  target: "thread-w",
  prompt: "do the thing",
  session: "live",
  kind: "handoff",
  correlationId: "corr-1",
  createdUtc: "2026-01-01T00:00:00Z",
  ...over,
});

const ledgerWarns = (records: LogRecord[]) =>
  records.filter((r) => r.level === "warn" && r.msg === "dispatch: ledger record failed");
const skipDebugs = (records: LogRecord[]) =>
  records.filter((r) => r.msg.startsWith("dispatch: already ledgered"));

let dataDir: string;
let dbDir: string;
let store: SessionStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-170-data-"));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-170-db-"));
  store = new SessionStore(path.join(dbDir, "t.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("#170 dispatchInjectTurn skips an already-ledgered spec", () => {
  it("a pre-claimed report-back records one row and logs no ledger warning", async () => {
    // Exactly what claimAndEnqueueReportBack writes before enqueueing.
    store.tryRecordReportBack({
      id: "disp-rb",
      kind: "report_back",
      sourceRef: "thread-src",
      targetRef: "thread-w",
      promptPreview: "the answer",
      correlationId: "corr-rb",
      status: "dispatched",
    });

    const { logger, records } = capturingLogger();
    const orch = makeOrch(dataDir, store, logger);
    await orch.dispatchInjectTurn(spec({ id: "disp-rb", kind: "report_back", correlationId: "corr-rb" }));

    expect(ledgerWarns(records)).toHaveLength(0);
    expect(skipDebugs(records)).toHaveLength(1);
    // Still exactly one row for the correlation — the claim's.
    const rows = store.listDelegationsByCorrelation?.("corr-rb") ?? [];
    expect(store.getDelegation("disp-rb")).not.toBeNull();
    if (rows.length) expect(rows).toHaveLength(1);
  });

  it("that surviving row still transitions dispatched → running → completed", async () => {
    store.tryRecordReportBack({
      id: "disp-rb2",
      kind: "report_back",
      correlationId: "corr-rb2",
      status: "dispatched",
      sourceRef: "thread-src",
      targetRef: "thread-w",
      promptPreview: "the answer",
    });
    expect(store.getDelegation("disp-rb2")?.status).toBe("dispatched");

    const { logger } = capturingLogger();
    const orch = makeOrch(dataDir, store, logger);
    await orch.dispatchInjectTurn(spec({ id: "disp-rb2", kind: "report_back", correlationId: "corr-rb2" }));

    // The claim row carries the id the dispatcher keys its updates on, so the
    // whole life-cycle still lands on it.
    expect(store.getDelegation("disp-rb2")?.status).toBe("completed");
  });

  it("a brand-new handoff still records its row (the skip is not over-broad)", async () => {
    const { logger, records } = capturingLogger();
    const orch = makeOrch(dataDir, store, logger);
    await orch.dispatchInjectTurn(spec({ id: "disp-new", kind: "handoff", correlationId: "corr-new" }));

    const row = store.getDelegation("disp-new");
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("handoff");
    expect(row?.status).toBe("completed");
    expect(skipDebugs(records)).toHaveLength(0);
    expect(ledgerWarns(records)).toHaveLength(0);
  });

  it("a brand-new wake still records its row", async () => {
    const { logger, records } = capturingLogger();
    const orch = makeOrch(dataDir, store, logger);
    await orch.dispatchInjectTurn(spec({ id: "disp-wake", kind: "wake", correlationId: "corr-wake" }));

    expect(store.getDelegation("disp-wake")?.kind).toBe("wake");
    expect(ledgerWarns(records)).toHaveLength(0);
    expect(skipDebugs(records)).toHaveLength(0);
  });

  it("re-dispatching an already-ledgered id is a quiet no-op (crash recovery)", async () => {
    const { logger: l1 } = capturingLogger();
    await makeOrch(dataDir, store, l1).dispatchInjectTurn(spec({ id: "disp-again", kind: "wake" }));
    expect(store.getDelegation("disp-again")).not.toBeNull();

    // Second delivery of the SAME spec — what crash recovery does.
    const { logger: l2, records: r2 } = capturingLogger();
    await makeOrch(dataDir, store, l2).dispatchInjectTurn(spec({ id: "disp-again", kind: "wake" }));

    expect(ledgerWarns(r2)).toHaveLength(0);
    expect(skipDebugs(r2)).toHaveLength(1);
  });

  it("a GENUINE ledger failure still warns — a different id colliding on a claimed correlation", async () => {
    // #77 claims the correlation under one id …
    store.tryRecordReportBack({
      id: "claim-id",
      kind: "report_back",
      correlationId: "corr-shared",
      status: "dispatched",
      sourceRef: "s",
      targetRef: "t",
      promptPreview: "p",
    });

    // … and a DIFFERENT spec id tries to claim the same correlation. There is
    // no row for this id, so the insert is attempted and genuinely fails.
    const { logger, records } = capturingLogger();
    const orch = makeOrch(dataDir, store, logger);
    await orch.dispatchInjectTurn(spec({ id: "other-id", kind: "report_back", correlationId: "corr-shared" }));

    const warns = ledgerWarns(records);
    expect(warns).toHaveLength(1);
    expect(skipDebugs(records)).toHaveLength(0);
    const err = warns[0].obj.err as { message?: string } | undefined;
    expect(err?.message).toBe("UNIQUE constraint failed: delegation_log.correlation_id");
  });

  it("the dispatch still delivers when the ledger row is skipped (no message loss)", async () => {
    store.tryRecordReportBack({
      id: "disp-deliver",
      kind: "report_back",
      correlationId: "corr-deliver",
      status: "dispatched",
      sourceRef: "s",
      targetRef: "thread-w",
      promptPreview: "p",
    });
    const { logger } = capturingLogger();
    const orch = makeOrch(dataDir, store, logger);
    const result = await orch.dispatchInjectTurn(
      spec({ id: "disp-deliver", kind: "report_back", correlationId: "corr-deliver" })
    );
    expect(result.output).toContain("done");
    expect(result.stopReason).toBe("end_turn");
  });
});
