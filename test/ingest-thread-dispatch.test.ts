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
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ChoiceResultHub } from "../packages/core/src/core/choice/result.js";
import { ChoiceIngest } from "../packages/core/src/core/choice/ingest.js";
import { hashBridgeToken, mintBridgeToken } from "../packages/core/src/core/bridge-pairing.js";
import { planEndpointDispatch, type IngestEndpoint } from "../packages/core/src/core/choice/endpoint.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import {
  dispatchDirs,
  enqueueDispatchSpec,
  type DispatchSpec,
} from "../packages/core/src/core/dispatch/types.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { reconcileCompletedDoneFiles } from "../packages/core/src/core/dispatch/done-reconcile.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { ChannelRef, MessageRef } from "../packages/core/src/platforms/chat-adapter.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

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
    location: null,
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
  opts: {
    answer?: string;
    mode?: RuntimeMode;
    timeoutSeconds?: number;
    profile?: { id: string; defaultModel: string };
    catalogProfile?: { id: string; defaultModel: string };
    profileLocation?: string;
  } = {}
): {
  orch: Orchestrator;
  ensured: string[];
  runtimeFor: string[];
  profileLookups: Array<{ id: string; location?: string }>;
} {
  const ensured: string[] = [];
  const runtimeFor: string[] = [];
  const profileLookups: Array<{ id: string; location?: string }> = [];
  const rt = fakeRuntime(opts.answer ?? "answered in-thread", opts.mode ?? "ok");
  const router = {
    listProfiles: () => (opts.profile ? [opts.profile] : []),
    describeConfig: () => ({}),
    ensureSessionRecord: ({ channelRef }: { channelRef: string }) => {
      ensured.push(channelRef);
      return sessionRecord({ id: `discord:${channelRef}`, channelRef });
    },
    // Deliberately undefined: the isolated ingest path resolves a profile and
    // throws on a miss, so reaching it would fail this test loudly.
    getProfile: (id: string, location?: string) => {
      profileLookups.push({ id, location });
      return opts.profile?.id === id && (!opts.profileLocation || opts.profileLocation === location)
        ? opts.profile
        : undefined;
    },
    getOrStartRuntime: async (rec: SessionRecord | string) => {
      runtimeFor.push(typeof rec === "string" ? rec : rec.id);
      return rt;
    },
    reuseMcpServers: () => [],
    mintMcpServersForSession: () => [],
    revokeMcpSession: () => {},
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
    modelCatalog: fixtureModelCatalog(
      opts.catalogProfile
        ? [opts.catalogProfile as any]
        : opts.profile
          ? [opts.profile as any]
          : []
    ),
  });
  return { orch, ensured, runtimeFor, profileLookups };
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

  it("uses the frozen remote host and current catalog default for a remote-only isolated ingest", async () => {
    const profile = { id: "remote-only", defaultModel: "configured-old" };
    const row = endpoint({
      thread: null,
      location: "studio",
      agentId: profile.id,
      model: null,
      cwd: "/remote/repo",
    });
    store.insertIngestEndpoint(row);
    const spec = planEndpointDispatch({ endpoint: row, payload: "hi" });
    const { orch, profileLookups } = makeOrch(dataDir, store, {
      profile,
      catalogProfile: { id: profile.id, defaultModel: "catalog-current" },
      profileLocation: "studio",
    });
    const marked: Array<{ sessionId: string; location: string }> = [];
    orch.setBridgeHub({
      markSessionBridge: (sessionId: string, location: string) => {
        marked.push({ sessionId, location });
      },
      get: () => ({ mux: {} }),
      mcpServersForRemoteSpawn: () => undefined,
    } as any);
    let injected: any;
    (orch as any).injectTurn = async (_record: unknown, _prompt: string, opts: unknown) => {
      injected = opts;
      return { text: "remote score", stopReason: "end_turn" };
    };

    await orch.dispatchInjectTurn(spec);

    expect(profileLookups).toContainEqual({ id: "remote-only", location: "studio" });
    expect(marked).toEqual([{ sessionId: `dispatch:${spec.id}`, location: "studio" }]);
    expect(injected).toMatchObject({
      location: "studio",
      model: "catalog-current",
      strictModel: true,
    });
    expect(typeof injected.spawnFn).toBe("function");
  });
});

describe("#246 isolated ingest owns every terminal transition", () => {
  it("terminalizes catalog preflight failure and permits the next HTTP job and ordinary turn", async () => {
    const token = mintBridgeToken();
    const row = endpoint({
      tokenHash: hashBridgeToken(token),
      thread: null,
      agentId: "claude",
      model: null,
      resultSchema: {
        type: "object",
        required: ["answer"],
        properties: { answer: { type: "number" } },
      },
    });
    store.insertIngestEndpoint(row);
    const results = new ChoiceResultHub({ store, logger: silent });
    const broken = makeOrch(dataDir, store, {
      profile: { id: "claude", defaultModel: "default" },
      // A different catalog binding leaves claude@local genuinely unavailable.
      catalogProfile: { id: "other", defaultModel: "other-default" },
    });
    broken.orch.setChoiceResults(results);
    let preflightRevocations = 0;
    let preflightQuotaStarts = 0;
    let preflightQuotaCompletions = 0;
    (broken.orch as any).router.revokeMcpSession = () => { preflightRevocations++; };
    (broken.orch as any).quotaPoller = {
      recordTurnStart: () => { preflightQuotaStarts++; },
      turnCompleted: async () => { preflightQuotaCompletions++; },
    };
    const failedWatcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: (spec) => broken.orch.dispatchInjectTurn(spec),
    });
    const ingest = new ChoiceIngest({
      store,
      results,
      logger: silent,
      enqueue: (spec) => enqueueDispatchSpec(dataDir, spec),
      destLive: async () => "ok",
      authoringSession: () => sessionRecord(),
      publicBase: () => "http://127.0.0.1",
      waitMs: 2_000,
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    try {
      const admitted = await fetch(`http://127.0.0.1:${port}/ingest?wait=0`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "synthetic first job" }),
      });
      expect(admitted.status).toBe(202);
      const first = (await admitted.json()) as { jobId: string };

      await failedWatcher.start();
      failedWatcher.stop();
      expect(failedWatcher.inFlightCount).toBe(0);
      expect(broken.orch.resolveIngestJob(first.jobId)).toBeUndefined();
      const failedDone = JSON.parse(
        fs.readFileSync(path.join(dispatchDirs(dataDir).done, `${first.jobId}.json`), "utf8")
      ) as { status: string; error?: string };
      expect(failedDone).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/catalog has no default model/),
      });

      const failedPoll = await fetch(`http://127.0.0.1:${port}/ingest/jobs/${first.jobId}`, {
        headers,
      });
      expect(failedPoll.status).toBe(422);
      expect(await failedPoll.json()).toMatchObject({
        jobId: first.jobId,
        status: "missing",
        error: expect.stringMatching(/catalog has no default model/),
      });
      expect(store.getDelegation(first.jobId)).toMatchObject({
        kind: "ingest",
        status: "failed",
      });
      expect(preflightRevocations).toBe(1);
      expect(preflightQuotaStarts).toBe(1);
      expect(preflightQuotaCompletions).toBe(1);

      // Same durable endpoint, no replay of the first input: a fresh synthetic
      // POST completes after catalog readiness is restored.
      const admittedSecond = await fetch(`http://127.0.0.1:${port}/ingest?wait=0`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "synthetic second job" }),
      });
      expect(admittedSecond.status).toBe(202);
      const second = (await admittedSecond.json()) as { jobId: string };
      const healthy = makeOrch(dataDir, store, {
        profile: { id: "claude", defaultModel: "default" },
      });
      healthy.orch.setChoiceResults(results);
      (healthy.orch as unknown as {
        injectTurn: () => Promise<{ text: string; stopReason: string }>;
      }).injectTurn = async () => ({
        text: 'fixture transcript\n```seam-result\n{"answer":42}\n```',
        stopReason: "end_turn",
      });
      const healthyWatcher = new DispatchWatcher({
        dataDir,
        logger: silent,
        onDispatch: (spec) => healthy.orch.dispatchInjectTurn(spec),
      });
      await healthyWatcher.start();
      healthyWatcher.stop();
      expect(healthyWatcher.inFlightCount).toBe(0);

      const completedPoll = await fetch(
        `http://127.0.0.1:${port}/ingest/jobs/${second.jobId}`,
        { headers }
      );
      expect(completedPoll.status).toBe(200);
      expect(await completedPoll.json()).toEqual({ answer: 42 });

      const ordinaryHost = makeOrch(dataDir, store, {
        profile: { id: "claude", defaultModel: "default" },
      });
      const ordinary = await ordinaryHost.orch.dispatchInjectTurn({
        id: "ordinary-after-ingest-failure",
        target: THREAD,
        prompt: "ordinary synthetic turn",
        session: "live",
        kind: "handoff",
        createdUtc: new Date().toISOString(),
      });
      expect(ordinary.output).toContain("answered in-thread");
    } finally {
      failedWatcher.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    {
      name: "spawn exception",
      run: () => {
        throw new Error("spawn exploded");
      },
      error: /spawn exploded/,
      ledger: "failed",
    },
    {
      name: "execution error",
      run: async () => ({ text: "", error: "execution exploded" }),
      error: /execution exploded/,
      ledger: "failed",
    },
    {
      name: "timeout without a separate error",
      run: async () => ({ text: "", timedOut: true }),
      error: /timed out/,
      ledger: "timed_out",
    },
    {
      name: "cancellation without a separate error",
      run: async () => ({ text: "", cancelled: true }),
      error: /cancelled/,
      ledger: "failed",
    },
  ])("terminalizes $name and releases token/quota/session ownership", async ({ run, error, ledger }) => {
    const row = endpoint({ thread: null, agentId: "claude", model: null });
    store.insertIngestEndpoint(row);
    const spec = planEndpointDispatch({ endpoint: row, payload: "synthetic" });
    const results = new ChoiceResultHub({ store, logger: silent });
    const pending = expectJob(results, spec.id, row.resultSchema);
    const { orch } = makeOrch(dataDir, store, {
      profile: { id: "claude", defaultModel: "default" },
    });
    orch.setChoiceResults(results);
    let revocations = 0;
    let quotaStarts = 0;
    let quotaCompletions = 0;
    (orch as any).router.revokeMcpSession = (id: string) => {
      expect(id).toBe(spec.id);
      revocations++;
    };
    (orch as any).quotaPoller = {
      recordTurnStart: () => { quotaStarts++; },
      turnCompleted: async () => { quotaCompletions++; },
    };
    (orch as any).injectTurn = run;

    await expect(orch.dispatchInjectTurn(spec)).rejects.toThrow(error);
    await expect(pending).rejects.toThrow(error);
    expect(store.getChoiceResult(spec.id)).toMatchObject({
      status: "missing",
      error: expect.stringMatching(error),
    });
    expect(store.getDelegation(spec.id)?.status).toBe(ledger);
    expect(orch.resolveIngestJob(spec.id)).toBeUndefined();
    expect(revocations).toBe(1);
    expect(quotaStarts).toBe(1);
    expect(quotaCompletions).toBe(1);
  });

  it("preserves a submitted success when later token cleanup fails", async () => {
    const row = endpoint({ thread: null, agentId: "claude", model: null });
    store.insertIngestEndpoint(row);
    const spec = planEndpointDispatch({ endpoint: row, payload: "synthetic" });
    const results = new ChoiceResultHub({ store, logger: silent });
    const pending = expectJob(results, spec.id, row.resultSchema);
    const { orch } = makeOrch(dataDir, store, {
      profile: { id: "claude", defaultModel: "default" },
    });
    orch.setChoiceResults(results);
    (orch as any).injectTurn = async () => ({
      text: '```seam-result\n{"overallScore":4,"prose":"kept"}\n```',
      stopReason: "end_turn",
    });
    (orch as any).router.revokeMcpSession = () => {
      throw new Error("token cleanup exploded");
    };

    await expect(orch.dispatchInjectTurn(spec)).rejects.toThrow(/token cleanup exploded/);
    await expect(pending).resolves.toEqual({ overallScore: 4, prose: "kept" });
    expect(store.getChoiceResult(spec.id)).toMatchObject({
      status: "ok",
      body: { overallScore: 4, prose: "kept" },
      error: null,
    });
    expect(store.getDelegation(spec.id)?.status).toBe("failed");
    expect(orch.resolveIngestJob(spec.id)).toBeUndefined();
  });

  it("leaves result-store failure recoverable from done evidence instead of replaying", async () => {
    const row = endpoint({ thread: null, agentId: "claude", model: null });
    store.insertIngestEndpoint(row);
    const spec = planEndpointDispatch({ endpoint: row, payload: "synthetic" });
    const results = new ChoiceResultHub({ store, logger: silent });
    const pending = expectJob(results, spec.id, row.resultSchema);
    const { orch } = makeOrch(dataDir, store, {
      profile: { id: "claude", defaultModel: "default" },
    });
    orch.setChoiceResults(results);
    (orch as any).injectTurn = async () => ({ text: "completed without declaration", stopReason: "end_turn" });
    const originalFinish = store.finishChoiceResult.bind(store);
    (store as any).finishChoiceResult = () => {
      throw new Error("result store unavailable");
    };
    let executions = 0;
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async (queued) => {
        executions++;
        return orch.dispatchInjectTurn(queued);
      },
    });
    await enqueueDispatchSpec(dataDir, spec);
    await watcher.start();
    watcher.stop();
    expect(executions).toBe(1);
    expect(store.getChoiceResult(spec.id)?.status).toBe("pending");
    expect(store.getDelegation(spec.id)?.status).toBe("dispatched");
    expect(JSON.parse(
      fs.readFileSync(path.join(dispatchDirs(dataDir).done, `${spec.id}.json`), "utf8")
    )).toMatchObject({ status: "failed", error: "result store unavailable", kind: "ingest" });

    (store as any).finishChoiceResult = originalFinish;
    const repaired = await reconcileCompletedDoneFiles({
      dataDir,
      logger: silent,
      getDelegation: (id) => store.getDelegation(id),
      listRecoveryCandidates: (after, limit) => store.listNonTerminalDelegations(after, limit),
      replay: (done, route) => orch.replayCompletedDispatch(done, route),
    });
    expect(repaired.reconciled).toBe(1);
    await expect(pending).rejects.toThrow(/result store unavailable/);
    expect(store.getChoiceResult(spec.id)?.status).toBe("missing");
    expect(store.getDelegation(spec.id)?.status).toBe("failed");
    expect(executions).toBe(1);
  });

  it("repairs a done-backed pending HTTP result without replaying the input", async () => {
    const dispatchId = "failed-before-result-settlement";
    const endpointId = "ie_recovery";
    store.insertIngestEndpoint(endpoint({ id: endpointId, thread: null }));
    store.insertChoiceResult({
      dispatchId,
      choiceId: endpointId,
      status: "pending",
      body: null,
      error: null,
      schema: { type: "object" },
      createdUtc: "2026-09-09T00:00:00.000Z",
      finishedUtc: null,
    });
    store.recordDelegation({
      id: dispatchId,
      kind: "ingest",
      sourceRef: null,
      targetRef: null,
      worker: null,
      promptPreview: "private input is deliberately absent from this fixture",
      correlationId: endpointId,
      status: "dispatched",
    });
    fs.mkdirSync(dispatchDirs(dataDir).done, { recursive: true });
    fs.writeFileSync(
      path.join(dispatchDirs(dataDir).done, `${dispatchId}.json`),
      JSON.stringify({
        id: dispatchId,
        target: `ingest:${endpointId}`,
        status: "failed",
        error: "catalog preflight unavailable",
        kind: "ingest",
        correlationId: endpointId,
        finishedUtc: "2026-09-09T00:00:01.000Z",
      })
    );
    const { orch } = makeOrch(dataDir, store);
    const results = new ChoiceResultHub({ store, logger: silent });
    orch.setChoiceResults(results);
    let replayCalls = 0;

    const summary = await reconcileCompletedDoneFiles({
      dataDir,
      logger: silent,
      getDelegation: (id) => store.getDelegation(id),
      listRecoveryCandidates: (after, limit) => store.listNonTerminalDelegations(after, limit),
      replay: async (done, route) => {
        replayCalls++;
        await orch.replayCompletedDispatch(done, route);
      },
    });

    expect(replayCalls).toBe(1);
    expect(summary.reconciled).toBe(1);
    expect(store.getChoiceResult(dispatchId)).toMatchObject({
      status: "missing",
      error: "ingest dispatch failed: catalog preflight unavailable",
    });
    expect(store.getDelegation(dispatchId)?.status).toBe("failed");

    // Idempotent second boot: terminal ledger rows are outside the recovery
    // index, and the already-terminal HTTP result remains byte-for-byte equal.
    const before = store.getChoiceResult(dispatchId);
    const again = await reconcileCompletedDoneFiles({
      dataDir,
      logger: silent,
      getDelegation: (id) => store.getDelegation(id),
      listRecoveryCandidates: (after, limit) => store.listNonTerminalDelegations(after, limit),
      replay: async (done, route) => {
        replayCalls++;
        await orch.replayCompletedDispatch(done, route);
      },
    });
    expect(again.reconciled).toBe(0);
    expect(replayCalls).toBe(1);
    expect(store.getChoiceResult(dispatchId)).toEqual(before);
  });

  it("keeps uncertain artifact-free work pending and recovers a durable declared result", async () => {
    const uncertainId = "uncertain-no-done";
    store.insertChoiceResult({
      dispatchId: uncertainId,
      choiceId: "ie_thread1",
      status: "pending",
      body: null,
      error: null,
      schema: null,
      createdUtc: "2026-09-09T00:00:00.000Z",
      finishedUtc: null,
    });
    store.recordDelegation({
      id: uncertainId,
      kind: "ingest",
      sourceRef: null,
      targetRef: null,
      worker: null,
      promptPreview: "not replayed",
      correlationId: "ie_thread1",
      status: "dispatched",
    });
    const summary = await reconcileCompletedDoneFiles({
      dataDir,
      logger: silent,
      getDelegation: (id) => store.getDelegation(id),
      listRecoveryCandidates: (after, limit) => store.listNonTerminalDelegations(after, limit),
      replay: async () => {
        throw new Error("artifact-free work must not replay");
      },
    });
    expect(summary.reconciled).toBe(0);
    expect(store.getChoiceResult(uncertainId)?.status).toBe("pending");
    expect(store.getDelegation(uncertainId)?.status).toBe("dispatched");

    const successId = "declared-before-cleanup-failure";
    store.insertChoiceResult({
      dispatchId: successId,
      choiceId: "ie_thread1",
      status: "pending",
      body: null,
      error: null,
      schema: null,
      createdUtc: "2026-09-09T00:00:00.000Z",
      finishedUtc: null,
    });
    store.recordDelegation({
      id: successId,
      kind: "ingest",
      sourceRef: null,
      targetRef: null,
      worker: null,
      promptPreview: "already handled",
      correlationId: "ie_thread1",
      status: "dispatched",
    });
    const restarted = makeOrch(dataDir, store).orch;
    restarted.setChoiceResults(new ChoiceResultHub({ store, logger: silent }));
    await restarted.replayCompletedDispatch(
      {
        id: successId,
        target: "ingest:ie_thread1",
        status: "failed",
        output: 'durable output\n```seam-result\n{"answer":7}\n```',
        error: "cleanup failed after submit_result",
        kind: "ingest",
        correlationId: "ie_thread1",
        finishedUtc: "2026-09-09T00:00:02.000Z",
      },
      { action: "terminalize" }
    );
    expect(store.getChoiceResult(successId)).toMatchObject({
      status: "ok",
      body: { answer: 7 },
      error: null,
    });
    expect(store.getDelegation(successId)?.status).toBe("failed");
  });
});
