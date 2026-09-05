import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import {
  dispatchDisplayPrompt,
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
  const rows = new Map<string, SessionRecord>([[oldRecord.id, oldRecord]]);
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    ensureSessionRecord: () => oldRecord,
    getProfile: () => undefined,
    invalidate: vi.fn(async () => {
      log.push("invalidate");
    }),
    getOrStartRuntime: vi.fn(async (record: SessionRecord) => {
      log.push(`runtime:${record.agentId}/${record.acpSessionId}`);
      return runtime;
    }),
  };
  const store = {
    get: (id: string) => rows.get(id) ?? null,
    upsert: (rec: SessionRecord) => {
      rows.set(rec.id, { ...rec });
    },
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
  return { orchestrator, oldRecord, newRecord, router, store, sent, log, rows };
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

  it("without rebuild does not call Reconstruct and still seeds the manifest", async () => {
    const h = harness(dir);
    const rebuild = vi.fn();
    (h.orchestrator as any).reconstructSessionFromDiscord = rebuild;
    h.orchestrator.setSelfMigrationHandler(async () => ({
      ok: true as const,
      record: h.newRecord,
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      newSessionId: "acp-new",
      warnings: [],
    }));

    await expect(h.orchestrator.dispatchInjectTurn(migrationSpec())).resolves.toMatchObject({
      output: "Manifest accepted.",
    });
    expect(rebuild).not.toHaveBeenCalled();
    expect(h.log.some((entry) => entry.startsWith("prompt:") && entry.includes(migrationSpec().prompt))).toBe(true);
  });

  it("rebuild:true applies identity, rebuilds from Discord, then injects the manifest", async () => {
    const h = harness(dir);
    const rebuild = vi.fn(async (args: { record: SessionRecord; observedAtStart: string }) => {
      h.log.push(`rebuild:${args.observedAtStart}`);
      expect(args.record.agentId).toBe("codex");
      expect(args.observedAtStart).toBe("acp-new");
      const attached = { ...h.newRecord, acpSessionId: "acp-rebuilt" };
      h.store.upsert(attached);
      return {
        newSessionId: "acp-rebuilt",
        attachment: { status: "attached" },
        seed: { text: "RECONSTRUCTION_SEED from Discord history" },
        destination: { agentId: "codex", model: "gpt-5.6-sol", contextWindow: 400_000 },
      };
    });
    (h.orchestrator as any).reconstructSessionFromDiscord = rebuild;
    const migrate = vi.fn(async () => {
      h.log.push("migration:activate");
      h.store.upsert(h.newRecord);
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

    const spec: DispatchSpec = {
      ...migrationSpec(),
      rebuild: true,
      originPrompt: migrationSpec().prompt,
    };
    await expect(h.orchestrator.dispatchInjectTurn(spec)).resolves.toMatchObject({
      output: "Manifest accepted.",
    });

    expect(migrate).toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledTimes(1);
    const rebuilt = await rebuild.mock.results[0]!.value;
    expect(rebuilt.seed.text).toContain("RECONSTRUCTION_SEED");
    expect(rebuilt.seed.text).not.toContain(spec.prompt);
    const promptIndex = h.log.findIndex(
      (entry) => entry.startsWith("prompt:") && entry.includes(spec.prompt)
    );
    expect(promptIndex).toBeGreaterThan(-1);
    expect(h.log.indexOf("migration:activate")).toBeLessThan(h.log.indexOf("rebuild:acp-new"));
    expect(h.log.indexOf("rebuild:acp-new")).toBeLessThan(promptIndex);
    expect(h.sent.some((text) => text.includes("rebuilt from Discord"))).toBe(true);
    expect(h.router.getOrStartRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ acpSessionId: "acp-rebuilt" })
    );
  });

  it("rebuild failure does not fire the manifest and restores the prior session", async () => {
    const h = harness(dir);
    const rebuild = vi.fn(async () => {
      h.log.push("rebuild:fail");
      throw new Error("destination window unresolved");
    });
    (h.orchestrator as any).reconstructSessionFromDiscord = rebuild;
    h.orchestrator.setSelfMigrationHandler(async () => {
      h.store.upsert(h.newRecord);
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

    await expect(
      h.orchestrator.dispatchInjectTurn({ ...migrationSpec(), rebuild: true })
    ).rejects.toThrow(/destination window unresolved/);

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(h.router.invalidate).toHaveBeenCalledWith("discord:thread-self", { clearStartFailure: true });
    expect(h.store.get("discord:thread-self")?.acpSessionId).toBe("acp-old");
    expect(h.store.get("discord:thread-self")?.agentId).toBe("claude");
    expect(h.router.getOrStartRuntime).not.toHaveBeenCalled();
    expect(h.log.some((entry) => entry.startsWith("prompt:"))).toBe(false);
    expect(h.sent.some((text) => text.includes("continuing on the prior agent/model"))).toBe(true);
  });

  it("MUTATION: follow-up card excerpt is the manifest, not harness text", () => {
    const spec: DispatchSpec = {
      ...migrationSpec(),
      rebuild: true,
      originPrompt: migrationSpec().prompt,
    };
    expect(dispatchDisplayPrompt(spec)).toBe(migrationSpec().prompt);
    expect(dispatchDisplayPrompt(spec)).not.toMatch(/seam-harness/i);
    expect(dispatchDisplayPrompt(spec)).not.toContain("RECONSTRUCTION_SEED");
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
    expect(parseDispatchSpec(
      "migration-1",
      JSON.stringify({ ...migrationSpec(), rebuild: true, originPrompt: migrationSpec().prompt })
    )).toMatchObject({ rebuild: true, originPrompt: migrationSpec().prompt });
    expect(() => parseDispatchSpec(
      "migration-1",
      JSON.stringify({ ...migrationSpec(), kind: "handoff", rebuild: true, migration: undefined })
    )).toThrow(/rebuild is accepted only for kind migrate_self/);
  });
});
