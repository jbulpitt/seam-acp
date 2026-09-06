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

type RuntimeMode = "ok" | "throws" | "hangs";

/** Minimal runtime. `throws` makes injectTurn return `{ error }` (it catches
 *  turn-level failures rather than throwing); `hangs` drives the timeout. */
function fakeRuntime(text: string, mode: RuntimeMode = "ok") {
  let handler: ((e: unknown) => void | Promise<void>) | undefined;
  return {
    onEvent(h: (e: unknown) => void | Promise<void>) {
      handler = h;
    },
    async prompt() {
      if (mode === "throws") throw new Error("agent blew up mid-turn");
      if (mode === "hangs") await new Promise(() => {});
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
  opts: { answer?: string; mode?: RuntimeMode; timeoutSeconds?: number } = {}
): { orch: Orchestrator; ensured: string[]; runtimeFor: string[] } {
  const ensured: string[] = [];
  const runtimeFor: string[] = [];
  const rt = fakeRuntime(opts.answer ?? "answered in-thread", opts.mode ?? "ok");
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
    TURN_TIMEOUT_SECONDS: opts.timeoutSeconds ?? 60,
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

/** The durable row + in-memory waiter a POST leaves behind before the dispatch
 *  runs. Returns the waiter promise; guarded so an unsettled rejection from a
 *  failure-path test cannot crash the run. */
function expectJob(results: ChoiceResultHub, dispatchId: string, schema: unknown = null): Promise<unknown> {
  store.insertChoiceResult({
    dispatchId,
    choiceId: "ie_thread1",
    status: "pending",
    body: null,
    error: null,
    schema,
    createdUtc: new Date().toISOString(),
    finishedUtc: null,
  });
  const p = results.expect({ dispatchId, choiceId: "ie_thread1", schema });
  p.catch(() => {});
  return p;
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
    const pending = expectJob(results, spec.id);

    await orch.dispatchInjectTurn(spec);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(store.getChoiceResult(spec.id)?.status).toBe("ok");
  });

  it("a resultSchema still forces submit_result even on a clean turn", async () => {
    const spec = planEndpointDispatch({ endpoint: endpoint(), payload: "hi" });
    const { orch } = makeOrch(dataDir, store);
    const results = new ChoiceResultHub({ store, logger: silent });
    orch.setChoiceResults(results);
    const pending = expectJob(results, spec.id, { type: "object" });

    await orch.dispatchInjectTurn(spec);

    await expect(pending).rejects.toThrow(/no declared result/);
    expect(store.getChoiceResult(spec.id)?.status).toBe("missing");
  });

  it("a submit_result during the turn still wins over the optional success", async () => {
    const spec = planEndpointDispatch({ endpoint: endpoint(), payload: "hi" });
    const { orch } = makeOrch(dataDir, store, {
      answer: 'here you go\n```seam-result\n{"answer":42}\n```',
    });
    const results = new ChoiceResultHub({ store, logger: silent });
    orch.setChoiceResults(results);
    const pending = expectJob(results, spec.id);

    await orch.dispatchInjectTurn(spec);

    await expect(pending).resolves.toEqual({ answer: 42 });
    expect(store.getChoiceResult(spec.id)?.body).toEqual({ answer: 42 });
  });
});

/**
 * The settlement-order bug: `turnEnded(..., resultOptional)` runs in a `finally`,
 * BEFORE `dispatchInjectTurn` evaluates `result.error` / `result.timedOut` and
 * throws. Handing it an unconditional `resultOptional` therefore recorded a
 * broken handoff as HTTP 200 `{ ok: true }` — durably, so a later
 * `GET /ingest/jobs/{id}` agreed — while the delegation was ledgered failed.
 */
describe("#224 a failed live-ingest turn is never a successful HTTP job", () => {
  it("result.error (the agent threw mid-turn) fails the job, not 200 {ok:true}", async () => {
    const spec = planEndpointDispatch({ endpoint: endpoint(), payload: "hi" });
    const { orch } = makeOrch(dataDir, store, { mode: "throws" });
    const results = new ChoiceResultHub({ store, logger: silent });
    orch.setChoiceResults(results);
    const pending = expectJob(results, spec.id);

    await expect(orch.dispatchInjectTurn(spec)).rejects.toThrow(/agent blew up mid-turn/);

    await expect(pending).rejects.toThrow(/agent blew up mid-turn/);
    const row = store.getChoiceResult(spec.id);
    expect(row?.status).toBe("missing");
    expect(row?.body).toBeNull();
    expect(row?.error).toMatch(/the dispatched turn failed: agent blew up mid-turn/);
    // The ledger and the HTTP job now agree on the verdict.
    expect(store.getDelegation(spec.id)?.status).toBe("failed");
  });

  it("a thrown dispatch (no result at all) fails the job", async () => {
    const spec = planEndpointDispatch({ endpoint: endpoint(), payload: "hi" });
    const { orch } = makeOrch(dataDir, store);
    const results = new ChoiceResultHub({ store, logger: silent });
    orch.setChoiceResults(results);
    const pending = expectJob(results, spec.id);
    // injectTurn catches turn-level failures, so force the one shape it cannot
    // report: an exception escaping before `result` is ever assigned.
    (orch as unknown as { injectTurn: () => Promise<never> }).injectTurn = () => {
      throw new Error("runtime acquisition exploded");
    };

    await expect(orch.dispatchInjectTurn(spec)).rejects.toThrow(/runtime acquisition exploded/);

    await expect(pending).rejects.toThrow(/failed before it produced a result/);
    expect(store.getChoiceResult(spec.id)?.status).toBe("missing");
  });

  it("a timed-out turn fails the job", async () => {
    const spec = planEndpointDispatch({ endpoint: endpoint(), payload: "hi" });
    const { orch } = makeOrch(dataDir, store, { mode: "hangs", timeoutSeconds: 0.05 });
    const results = new ChoiceResultHub({ store, logger: silent });
    orch.setChoiceResults(results);
    const pending = expectJob(results, spec.id);

    await expect(orch.dispatchInjectTurn(spec)).rejects.toThrow(/timed out/);

    await expect(pending).rejects.toThrow(/timed out/);
    const row = store.getChoiceResult(spec.id);
    expect(row?.status).toBe("missing");
    expect(row?.error).toMatch(/the dispatched turn timed out/);
    expect(store.getDelegation(spec.id)?.status).toBe("timed_out");
  });
});

/**
 * Alias cleanup. `submit_result` finds its waiter through session/channel
 * aliases, and a LIVE ingest binds the target THREAD as a channel alias. The
 * already-`ok` early return in `turnEnded` used to drop only the waiter, so the
 * thread stayed pointed at a finished dispatch — and the next POST queued onto
 * that same thread would resolve the previous job.
 */
describe("#224 turnEnded releases channel/session aliases on every path", () => {
  // Both assertions below check the REASON, not just `ok: false`. With the
  // alias still bound, a stray submit resolves the stale dispatch and is
  // refused as "already submitted (first call wins)" — an `ok: false` that
  // silently confirms the thread is still wired to a finished job.
  const NO_WAITER = /No ingest waiter for this turn/;

  it("a live ingest that already submitted leaves no alias on the thread", async () => {
    const spec = planEndpointDispatch({ endpoint: endpoint(), payload: "hi" });
    const { orch } = makeOrch(dataDir, store, {
      answer: 'done\n```seam-result\n{"answer":1}\n```',
    });
    const results = new ChoiceResultHub({ store, logger: silent });
    orch.setChoiceResults(results);
    const pending = expectJob(results, spec.id);

    await orch.dispatchInjectTurn(spec);
    await expect(pending).resolves.toEqual({ answer: 1 });

    // Nothing may still resolve through the thread or its session record.
    const viaChannel = results.submitFromChannel(THREAD, { answer: 2 });
    expect(viaChannel.ok).toBe(false);
    if (!viaChannel.ok) expect(viaChannel.error).toMatch(NO_WAITER);
    const viaSession = results.submitFromSession(`discord:${THREAD}`, { answer: 2 });
    expect(viaSession.ok).toBe(false);
    if (!viaSession.ok) expect(viaSession.error).toMatch(NO_WAITER);
    // …and the settled job keeps its first-call-wins body.
    expect(store.getChoiceResult(spec.id)?.body).toEqual({ answer: 1 });
  });

  it("an optional-success live ingest also releases the thread alias", async () => {
    // The `{ ok: true }` path already unbound; this pins the OTHER terminal
    // path — a job whose row was ok before turnEnded ran — to the same rule.
    const spec = planEndpointDispatch({ endpoint: endpoint(), payload: "hi" });
    const { orch } = makeOrch(dataDir, store);
    const results = new ChoiceResultHub({ store, logger: silent });
    orch.setChoiceResults(results);
    const pending = expectJob(results, spec.id);

    await orch.dispatchInjectTurn(spec);
    await expect(pending).resolves.toEqual({ ok: true });

    const stray = results.submitFromChannel(THREAD, { late: true });
    expect(stray.ok).toBe(false);
    if (!stray.ok) expect(stray.error).toMatch(NO_WAITER);
  });

  it("the next POST queued on that thread settles its OWN job", async () => {
    const results = new ChoiceResultHub({ store, logger: silent });
    const first = planEndpointDispatch({ endpoint: endpoint(), payload: "one" });
    const second = planEndpointDispatch({ endpoint: endpoint(), payload: "two" });

    const a = makeOrch(dataDir, store, { answer: 'a\n```seam-result\n{"n":1}\n```' });
    a.orch.setChoiceResults(results);
    const firstPending = expectJob(results, first.id);
    await a.orch.dispatchInjectTurn(first);
    await expect(firstPending).resolves.toEqual({ n: 1 });

    // The gap between two queued POSTs: the first has settled, the second has
    // not bound yet. The thread must point at nothing at all here.
    const inGap = results.submitFromChannel(THREAD, { n: 99 });
    expect(inGap.ok).toBe(false);
    if (!inGap.ok) expect(inGap.error).toMatch(NO_WAITER);

    const b = makeOrch(dataDir, store, { answer: 'b\n```seam-result\n{"n":2}\n```' });
    b.orch.setChoiceResults(results);
    const secondPending = expectJob(results, second.id);
    await b.orch.dispatchInjectTurn(second);

    await expect(secondPending).resolves.toEqual({ n: 2 });
    expect(store.getChoiceResult(first.id)?.body).toEqual({ n: 1 });
    expect(store.getChoiceResult(second.id)?.body).toEqual({ n: 2 });
  });
});

describe("#224 isolated ingest routing", () => {
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
