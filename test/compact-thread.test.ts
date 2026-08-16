import { describe, it, expect } from "vitest";
import { pino } from "pino";
import { Orchestrator } from "../src/platforms/discord/orchestrator.js";
import type { Logger } from "../src/lib/logger.js";
import type { SessionRecord, StructuredPanel } from "../src/core/types.js";
import type { ChannelRef, MessageRef } from "../src/platforms/chat-adapter.js";
import type { DispatchSpec } from "../src/core/dispatch/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-c",
  platform: "discord",
  channelRef: "thread-c",
  parentRef: null,
  agentId: "claude",
  acpSessionId: "acp-active",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-01-01T00:00:00Z",
  updatedUtc: "2026-01-01T00:00:00Z",
  ...over,
});

/** A stubbed premium-compaction result — the shape formatPremiumReport +
 *  compactThread read (assembledSeed / stats / pinnedFacts). */
const fakeResult = () => ({
  assembledSeed: "## Assembled seed\nverbatim + pinned facts",
  stats: { chunks: 4 },
  pinnedFacts: { corrections: [], constraints: [], decisions: [], openTodos: [], activePaths: [], rules: [] },
});

/** Build an Orchestrator with just enough stubbed deps to exercise the compact
 *  primitive, plus recorders for the store writes it makes. The pipeline + seed
 *  are stubbed on the instance so the test never runs a real runtime. */
function makeOrch(over?: {
  profile?: unknown;
  cfg?: { model?: string; reasoningEffort?: string };
}) {
  const upserts: SessionRecord[] = [];
  const invalidated: Array<{ id: string; opts: unknown }> = [];
  const deletes: string[] = [];
  const profile =
    over?.profile !== undefined
      ? over.profile
      : { id: "claude", displayName: "Claude", sessionManager: { name: "fake-manager" } };

  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    getProfile: () => profile,
    invalidate: async (id: string, opts: unknown) => {
      invalidated.push({ id, opts });
    },
  };
  const store = {
    readConfig: () => over?.cfg ?? { model: "opus", reasoningEffort: "high" },
    upsert: (r: SessionRecord) => {
      upserts.push(r);
    },
    // A destructive method the primitive must NEVER call (non-destructiveness).
    deleteSession: (id: string) => {
      deletes.push(id);
    },
    recordDelegation: () => {},
    updateDelegationStatus: () => {},
  };
  const config = {
    DATA_DIR: "/tmp/none",
    REPOS_ROOT: "/repo",
    TURN_TIMEOUT_SECONDS: 60,
    DEFAULT_MODEL: "default",
    CHANNEL_PRESETS_FILE: undefined,
    SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
    channelPresets: {},
    threadPresets: {},
  };
  const orch = new Orchestrator({
    logger: silent,
    config: config as any,
    adapter: {} as any,
    router: router as any,
    store: store as any,
    renderer: {} as any,
  });

  // Stub the two heavy privates the primitive delegates to.
  const sessionCalls: any[] = [];
  const discordCalls: any[] = [];
  const seedCalls: any[] = [];
  (orch as any).runPremiumCompactionForSession = async (args: any) => {
    sessionCalls.push(args);
    return fakeResult();
  };
  (orch as any).runPremiumCompactionForDiscord = async (args: any) => {
    discordCalls.push(args);
    return fakeResult();
  };
  (orch as any).seedNewSession = async (args: any) => {
    seedCalls.push(args);
    return "sess-new";
  };

  return { orch, upserts, invalidated, deletes, sessionCalls, discordCalls, seedCalls };
}

describe("Orchestrator.compactThread", () => {
  it("seeds a new session and SWAPS the active binding when the compacted session was active", async () => {
    const t = makeOrch();
    const res = await t.orch.compactThread(record());

    // A brand-new session was seeded from the assembled summary...
    expect(t.seedCalls).toHaveLength(1);
    expect(t.seedCalls[0].summary).toContain("Assembled seed");
    // ...carrying the thread's own model/effort config.
    expect(t.seedCalls[0].model).toBe("opus");
    expect(t.seedCalls[0].effort).toBe("high");

    // Returned facts.
    expect(res.newSessionId).toBe("sess-new");
    expect(res.originalSessionId).toBe("acp-active");
    expect(res.wasActive).toBe(true);
    expect(res.stats.chunks).toBe(4);
    expect(res.reportMarkdown).toContain("Premium compaction report");

    // The thread was rebound to the new session (upsert + router invalidate).
    expect(t.upserts).toHaveLength(1);
    expect(t.upserts[0].acpSessionId).toBe("sess-new");
    // Only acpSessionId changed — the record otherwise preserved.
    expect(t.upserts[0].id).toBe("discord:thread-c");
    expect(t.upserts[0].agentId).toBe("claude");
    expect(t.invalidated).toHaveLength(1);
    expect(t.invalidated[0]).toEqual({ id: "discord:thread-c", opts: { clearAcpSession: false } });

    // Non-destructive: the original session was never deleted, and its id is
    // returned so it stays recoverable.
    expect(t.deletes).toHaveLength(0);
    expect(res.originalSessionId).not.toBe(res.newSessionId);

    // Default source ran the session-history pipeline, on the active session.
    expect(t.sessionCalls).toHaveLength(1);
    expect(t.sessionCalls[0].sessionId).toBe("acp-active");
    expect(t.discordCalls).toHaveLength(0);
  });

  it("does NOT swap the active binding when compacting a NON-active session", async () => {
    const t = makeOrch();
    const res = await t.orch.compactThread(record(), { sessionId: "acp-older" });

    expect(res.wasActive).toBe(false);
    expect(res.originalSessionId).toBe("acp-older");
    expect(res.newSessionId).toBe("sess-new");
    // A new session was still seeded (compaction ran)...
    expect(t.seedCalls).toHaveLength(1);
    // ...but the thread's active binding is untouched.
    expect(t.upserts).toHaveLength(0);
    expect(t.invalidated).toHaveLength(0);
    // Pipeline ran against the explicitly-targeted session.
    expect(t.sessionCalls[0].sessionId).toBe("acp-older");
  });

  it("runs the Discord-history pipeline when source is 'discord'", async () => {
    const t = makeOrch();
    await t.orch.compactThread(record(), { source: "discord" });
    expect(t.discordCalls).toHaveLength(1);
    expect(t.sessionCalls).toHaveLength(0);
  });

  it("refuses when the agent profile has no session manager", async () => {
    const t = makeOrch({ profile: { id: "x", displayName: "NoMgr", sessionManager: undefined } });
    await expect(t.orch.compactThread(record())).rejects.toThrow(/does not support session management/);
    expect(t.seedCalls).toHaveLength(0);
  });

  it("refuses when the thread has no active session and none is given", async () => {
    const t = makeOrch();
    await expect(t.orch.compactThread(record({ acpSessionId: "" }))).rejects.toThrow(/no active session/);
  });
});

// -------------------------------------------------------------------------
// Dispatch-kind branch: kind:"compact" runs the primitive (not an inject-turn)
// -------------------------------------------------------------------------

/** A spy adapter recording panel/file posts. */
function spyAdapter() {
  const calls = { sendPanel: [] as StructuredPanel[], editPanel: [] as StructuredPanel[], sendFile: [] as string[] };
  const adapter = {
    async sendPanel(_c: ChannelRef, panel: StructuredPanel): Promise<MessageRef> {
      calls.sendPanel.push(panel);
      return { channel: _c, id: `msg-${calls.sendPanel.length}` };
    },
    async editPanel(_ref: MessageRef, panel: StructuredPanel): Promise<void> {
      calls.editPanel.push(panel);
    },
    async sendFile(_c: ChannelRef, file: { data: Buffer; filename: string }): Promise<MessageRef> {
      calls.sendFile.push(file.filename);
      return { channel: _c, id: "file-1" };
    },
  };
  return { adapter, calls };
}

describe("Orchestrator.dispatchInjectTurn — compact branch", () => {
  const compactSpec = (over: Partial<DispatchSpec> = {}): DispatchSpec => ({
    id: "disp-1",
    target: "thread-target",
    prompt: "[seam-compact] compact thread thread-target (session history)",
    session: "live",
    kind: "compact",
    returnTo: "thread-actor",
    correlationId: "disp-1",
    createdUtc: "2026-01-01T00:00:00Z",
    ...over,
  });

  function makeDispatchOrch() {
    const { adapter, calls } = spyAdapter();
    const ledger: any[] = [];
    const statuses: string[] = [];
    const router = {
      listProfiles: () => [],
      describeConfig: () => ({}),
      ensureSessionRecord: ({ channelRef }: { channelRef: string }) =>
        record({ id: `discord:${channelRef}`, channelRef }),
    };
    const store = {
      recordDelegation: (e: any) => ledger.push(e),
      updateDelegationStatus: (_id: string, s: string) => statuses.push(s),
    };
    const config = {
      DATA_DIR: "/tmp/none",
      REPOS_ROOT: "/repo",
      DEFAULT_MODEL: "default",
      CHANNEL_PRESETS_FILE: undefined,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      channelPresets: {},
      threadPresets: {},
    };
    const orch = new Orchestrator({
      logger: silent,
      config: config as any,
      adapter: adapter as any,
      router: router as any,
      store: store as any,
      renderer: {} as any,
    });
    const compactArgs: any[] = [];
    let injectCalled = false;
    (orch as any).compactThread = async (rec: SessionRecord, opts: any) => {
      compactArgs.push({ rec, opts });
      return {
        newSessionId: "sess-new",
        originalSessionId: "acp-active",
        wasActive: true,
        reportMarkdown: "# Premium compaction report — acp-active",
        stats: { chunks: 4 },
      };
    };
    (orch as any).injectTurn = async () => {
      injectCalled = true;
      return { text: "", stopReason: "end_turn" };
    };
    return { orch, calls, ledger, statuses, compactArgs, injectCalled: () => injectCalled };
  }

  it("routes kind:compact to compactThread (never injectTurn) and posts a result card", async () => {
    const t = makeDispatchOrch();
    const out = await t.orch.dispatchInjectTurn(compactSpec());

    // The primitive ran with the target thread's record and the target channel.
    expect(t.compactArgs).toHaveLength(1);
    expect(t.compactArgs[0].rec.channelRef).toBe("thread-target");
    // No turn was injected — this is the compact branch, not the inject path.
    expect(t.injectCalled()).toBe(false);

    // Start indicator posted, then finalized into a done card, plus the report file.
    expect(t.calls.sendPanel.length).toBeGreaterThanOrEqual(1);
    expect(t.calls.editPanel.length).toBeGreaterThanOrEqual(1);
    expect(t.calls.sendFile.length).toBe(1);
    expect(out.output).toContain("sess-new");
  });

  it("ledgers the compaction actor→target explicitly", async () => {
    const t = makeDispatchOrch();
    await t.orch.dispatchInjectTurn(compactSpec({ returnTo: "thread-actor", target: "thread-target" }));
    expect(t.ledger).toHaveLength(1);
    expect(t.ledger[0]).toMatchObject({ kind: "compact", sourceRef: "thread-actor", targetRef: "thread-target" });
    // Lifecycle recorded through to completion.
    expect(t.statuses).toContain("running");
    expect(t.statuses).toContain("completed");
  });
});
