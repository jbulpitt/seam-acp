/**
 * #224 — a headless ingest endpoint with a `thread` fires as a LIVE handoff.
 *
 * The gap this closes: `kind: "ingest"` used to mean "isolated silent scoring"
 * unconditionally, so `dispatchInjectTurn` routed every ingest spec into
 * `dispatchIngestEndpoint`'s synthetic session record. A thread endpoint keeps
 * `kind: "ingest"` (the HTTP waiter and the ledger classify on it) but must
 * take the ordinary live path instead — the target thread's own session, its
 * identity, no report-back.
 *
 * These run the real `Orchestrator.dispatchInjectTurn` against a real
 * `SessionStore`, so "which path ran" is observed from the ledger row and the
 * session the runtime was started for, not from source text.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ChoiceResultHub } from "../packages/core/src/core/choice/result.js";
import { planEndpointDispatch, type IngestEndpoint } from "../packages/core/src/core/choice/endpoint.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { ChannelRef, MessageRef } from "../packages/core/src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const THREAD = "1516907849349857421";

const sessionRecord = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-1",
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "chan-1",
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-01-01T00:00:00Z",
  updatedUtc: "2026-01-01T00:00:00Z",
  ...over,
});

function endpoint(over: Partial<IngestEndpoint> = {}): IngestEndpoint {
  return {
    id: "ie_thread1",
    tokenHash: "hash",
    name: "site-questions",
    cwd: null,
    agentId: null,
    model: null,
    effort: null,
    wrapper: "Answer the visitor.",
    resultSchema: null,
    corsOrigins: null,
    uniqueStudent: false,
    notifyThread: null,
    thread: THREAD,
    preset: null,
    status: "open",
    createdBy: "discord:thread-1",
    createdUtc: "2026-08-22T00:00:00.000Z",
    authoringChannelRef: "thread-1",
    authoringParentRef: "chan-1",
    platform: "discord",
    ...over,
  };
}

/** Minimal runtime that answers immediately and stops cleanly. */
function fakeRuntime(text: string) {
  let handler: ((e: unknown) => void | Promise<void>) | undefined;
  return {
    onEvent(h: (e: unknown) => void | Promise<void>) {
      handler = h;
    },
    async prompt() {
      await handler?.({ kind: "agent-text", text });
      return { stopReason: "end_turn" };
    },
    async idle() {},
    getSessionInfo() {
      return { sessionId: "acp-live" };
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

function makeOrch(
  dataDir: string,
  store: SessionStore,
  opts: { answer?: string } = {}
): { orch: Orchestrator; ensured: string[]; runtimeFor: string[] } {
  const ensured: string[] = [];
  const runtimeFor: string[] = [];
  const rt = fakeRuntime(opts.answer ?? "answered in-thread");
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    ensureSessionRecord: ({ channelRef }: { channelRef: string }) => {
      ensured.push(channelRef);
      return sessionRecord({ id: `discord:${channelRef}`, channelRef });
    },
    // Deliberately undefined: the isolated ingest path resolves a profile and
    // throws on a miss, so reaching it would fail this test loudly.
    getProfile: () => undefined,
    getOrStartRuntime: async (rec: SessionRecord | string) => {
      runtimeFor.push(typeof rec === "string" ? rec : rec.id);
      return rt;
    },
  };
  const config = {
    DATA_DIR: dataDir,
    REPOS_ROOT: "/repo",
    TURN_TIMEOUT_SECONDS: 60,
    DEFAULT_MODEL: "default",
    DEFAULT_AGENT: "claude",
    CHANNEL_PRESETS_FILE: undefined,
    SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
    SEAM_DISPATCH_OUTPUT_STYLE: "messages",
    SEAM_DISPATCH_STATUS_PANEL: false,
    REPO_EMOJIS: new Map<string, string>(),
    channelPresets: {},
    threadPresets: {},
  };
  const orch = new Orchestrator({
    logger: silent,
    config: config as never,
    adapter: spyAdapter() as never,
    router: router as never,
    store: store as never,
    renderer: discordRenderer as never,
  });
  return { orch, ensured, runtimeFor };
}

let dataDir: string;
let dbDir: string;
let store: SessionStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-224-data-"));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-224-db-"));
  store = new SessionStore(path.join(dbDir, "t.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

/** Specs the runtime enqueued for itself (a report-back would land here). */
function pendingDispatches(): string[] {
  const dir = path.join(dataDir, "dispatch", "pending");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

describe("#224 live-thread ingest dispatch", () => {
  it("injects into the target thread's own session, not a synthetic isolated one", async () => {
    const spec = planEndpointDispatch({ endpoint: endpoint(), payload: "a visitor question" });
    expect(spec.session).toBe("live");

    const { orch, ensured, runtimeFor } = makeOrch(dataDir, store);
    const out = await orch.dispatchInjectTurn(spec);

    // The live path ensures + runs the TARGET thread's session. The isolated
    // ingest path builds a synthetic record keyed on the dispatch id and never
    // touches either of these.
    expect(ensured).toContain(THREAD);
    expect(runtimeFor).toContain(`discord:${THREAD}`);
    expect(runtimeFor).not.toContain(spec.id);
    expect(orch.resolveIngestJob(spec.id)).toBeUndefined();
    expect(out.output).toContain("answered in-thread");
  });

  it("ledgers as an ingest aimed at the thread, and reports back to nobody", async () => {
    const spec = planEndpointDispatch({ endpoint: endpoint(), payload: "hi" });
    const { orch } = makeOrch(dataDir, store);
    await orch.dispatchInjectTurn(spec);

    const row = store.getDelegation(spec.id);
    expect(row?.kind).toBe("ingest");
    // The isolated path ledgers targetRef = notifyThread ?? null; the live one
    // ledgers the thread it actually ran in.
    expect(row?.targetRef).toBe(THREAD);
    expect(row?.status).toBe("completed");
    expect(spec.returnTo).toBeUndefined();
    expect(pendingDispatches()).toHaveLength(0);
  });

  it("turn end without submit_result settles the HTTP waiter as success", async () => {
    const spec = planEndpointDispatch({ endpoint: endpoint(), payload: "hi" });
    const { orch } = makeOrch(dataDir, store);
    const results = new ChoiceResultHub({ store, logger: silent });
    orch.setChoiceResults(results);
    store.insertChoiceResult({
      dispatchId: spec.id,
      choiceId: "ie_thread1",
      status: "pending",
      body: null,
      error: null,
      schema: null,
      createdUtc: new Date().toISOString(),
      finishedUtc: null,
    });
    const pending = results.expect({ dispatchId: spec.id, choiceId: "ie_thread1", schema: null });

    await orch.dispatchInjectTurn(spec);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(store.getChoiceResult(spec.id)?.status).toBe("ok");
  });

  it("an isolated ingest spec still takes the synthetic path (no regression)", async () => {
    const spec: DispatchSpec = planEndpointDispatch({
      endpoint: endpoint({ thread: null, agentId: "claude" }),
      payload: "hi",
    });
    expect(spec.session).toBe("isolated");

    const { orch, ensured } = makeOrch(dataDir, store);
    // The synthetic path resolves an agent profile; this fake router has none,
    // so it throws there — which is exactly the branch we want to prove it took.
    await expect(orch.dispatchInjectTurn(spec)).rejects.toThrow(/unknown agent|claude/);
    expect(ensured).toHaveLength(0);
  });
});
