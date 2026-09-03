import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import {
  parseDispatchSpec,
  type DispatchSpec,
} from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "discord:thread-self",
    platform: "discord",
    channelRef: "thread-self",
    parentRef: "channel-1",
    agentId: "claude",
    acpSessionId: "acp-old",
    repoPath: "/repo",
    configJson: JSON.stringify({ model: "claude-old" }),
    createdUtc: "2026-09-01T00:00:00.000Z",
    updatedUtc: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function migrationSpec(): DispatchSpec {
  return {
    id: "migration-1",
    target: "thread-self",
    prompt: "Continue from the parser implementation and run every verification gate.",
    session: "live",
    kind: "migrate_self",
    migration: {
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      previousAgent: "claude",
      previousModel: "claude-old",
      previousSessionId: "acp-old",
    },
    correlationId: "migration-1",
    createdUtc: "2026-09-01T00:00:01.000Z",
  };
}

function harness(dir: string) {
  const log: string[] = [];
  const oldRecord = session();
  const newRecord = session({
    agentId: "codex",
    acpSessionId: "acp-new",
    configJson: JSON.stringify({ model: "gpt-5.6-sol", reasoningEffort: "high" }),
  });
  let handler: ((event: { kind: string; text: string }) => Promise<void> | void) | undefined;
  const runtime = {
    onEvent(next: typeof handler) { handler = next; },
    async prompt(prompt: string) {
      log.push(`prompt:${prompt}`);
      await handler?.({ kind: "agent-text", text: "Manifest accepted." });
      return { stopReason: "end_turn" };
    },
    async idle() {},
    getSessionInfo: () => ({ sessionId: "acp-new" }),
  };
  const sent: string[] = [];
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    ensureSessionRecord: () => oldRecord,
    getProfile: () => undefined,
    getOrStartRuntime: vi.fn(async (record: SessionRecord) => {
      log.push(`runtime:${record.agentId}/${record.acpSessionId}`);
      return runtime;
    }),
  };
  const store = {
    getPresetByName: () => null,
    recordDelegation: () => {},
    // #170: dispatchInjectTurn now looks the spec up by exact id before
    // recording, so a pre-claimed report-back is not re-inserted. These
    // specs are never pre-ledgered, so the lookup finds nothing.
    getDelegation: () => null,
    updateDelegationStatus: () => {},
    getReportBackByCorrelation: () => null,
    tryRecordReportBack: (value: unknown) => value,
    getParkedByChannel: () => null,
  };
  const adapter = {
    async sendMessage(_channel: unknown, text: string) {
      sent.push(text);
      log.push(`message:${text}`);
      return { channel: { platform: "discord", id: "thread-self" }, id: `m-${sent.length}` };
    },
  };
  const orchestrator = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: "/repo",
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "default",
      CHANNEL_PRESETS_FILE: undefined,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      SEAM_DISPATCH_OUTPUT_STYLE: "messages",
      SEAM_DISPATCH_STATUS_PANEL: false,
      channelPresets: new Map(),
      threadPresets: new Map(),
      bridgePresets: new Map(),
    } as any,
    adapter: adapter as any,
    router: router as any,
    store: store as any,
    renderer: {} as any,
  });
  return { orchestrator, oldRecord, newRecord, router, sent, log };
}

describe("migrate_self staged dispatch", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-migrate-self-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("waits for the invoking turn, then sends the manifest first on the replacement session", async () => {
    const h = harness(dir);
    const gate = deferred();
    const active = (h.orchestrator as any).queueOnChannel("thread-self", async () => {
      h.log.push("caller:start");
      await gate.promise;
      h.log.push("caller:end");
    }) as Promise<void>;
    const migrate = vi.fn(async () => {
      h.log.push("migration:activate");
      return {
        ok: true as const,
        record: h.newRecord,
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        newSessionId: "acp-new",
        warnings: [],
      };
    });
    h.orchestrator.setSelfMigrationHandler(migrate);

    const dispatched = h.orchestrator.dispatchInjectTurn(migrationSpec());
    await vi.waitFor(() => expect(h.log).toContain("caller:start"));
    expect(migrate).not.toHaveBeenCalled();
    expect(h.router.getOrStartRuntime).not.toHaveBeenCalled();

    gate.resolve();
    await active;
    await expect(dispatched).resolves.toMatchObject({ output: "Manifest accepted." });

    expect(migrate).toHaveBeenCalledWith(h.oldRecord, migrationSpec().migration);
    expect(h.router.getOrStartRuntime).toHaveBeenCalledWith(h.newRecord);
    expect(h.log.indexOf("caller:end")).toBeLessThan(h.log.indexOf("migration:activate"));
    const promptIndex = h.log.findIndex(
      (entry) => entry.startsWith("prompt:") && entry.includes(migrationSpec().prompt)
    );
    expect(promptIndex).toBeGreaterThan(-1);
    expect(h.log.indexOf("migration:activate")).toBeLessThan(
      promptIndex
    );
    expect(h.sent).toContain("🔀 Migrated to codex / gpt-5.6-sol — continuing");
  });

  it("does not run the manifest when activation fails and reports the prior session remains", async () => {
    const h = harness(dir);
    const migrate = vi.fn(async () => ({ ok: false as const, error: "replacement unavailable" }));
    h.orchestrator.setSelfMigrationHandler(migrate);

    await expect(h.orchestrator.dispatchInjectTurn(migrationSpec())).rejects.toThrow(
      "replacement unavailable"
    );

    expect(h.router.getOrStartRuntime).not.toHaveBeenCalled();
    expect(h.sent.some((text) => text.includes("continuing on the prior agent/model"))).toBe(true);
  });

  it("accepts migration authority only on live migrate_self specs", () => {
    expect(parseDispatchSpec("migration-1", JSON.stringify(migrationSpec()))).toMatchObject({
      kind: "migrate_self",
      session: "live",
      migration: { agent: "codex", model: "gpt-5.6-sol" },
    });
    expect(() => parseDispatchSpec(
      "migration-1",
      JSON.stringify({ ...migrationSpec(), migration: undefined })
    )).toThrow(/requires a validated migration target snapshot/);
    expect(() => parseDispatchSpec(
      "migration-1",
      JSON.stringify({ ...migrationSpec(), kind: "handoff" })
    )).toThrow(/accepted only for kind migrate_self/);
    expect(() => parseDispatchSpec(
      "migration-1",
      JSON.stringify({ ...migrationSpec(), session: "isolated" })
    )).toThrow(/must use the live session/);
  });
});
