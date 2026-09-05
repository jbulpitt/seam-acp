/**
 * #179 — every long-running job launched from the session browser card.
 *
 * Two defects, both only visible at COMPLETION time:
 *
 *  A. attachment. The binding decision was a boolean captured before a pipeline
 *     that can run for ten minutes, so a thread left unbound by an agent switch
 *     got a resumable seed with nothing pointing at it, a binding changed
 *     during the run could be clobbered, and the browser kept rendering the
 *     stale snapshot afterwards.
 *
 *  B. card lifecycle. Each job was launched unawaited and then wrote its result
 *     with a raw `editReply({ components: [backRow] })`. If the 10-minute
 *     collector expired first, that repainted a live-looking control onto an
 *     already-expired card — one whose only possible answer is Discord's
 *     interaction error (#159's invariant, broken from the late-writer side).
 *
 * These tests drive the REAL `cmdSessions` collector: the real handler, the
 * real `CardLifecycle`, the real attach decision, the real settle path.
 *
 * DETERMINISM. There are no timers and no `setTimeout(0)` flushes here. Two
 * explicit gates do all the sequencing:
 *
 *   `h.started`  — resolves when the job's stubbed pipeline is entered, i.e.
 *                  after the progress card has been painted;
 *   `h.settle()` — `orchestrator.settleCardJobs()`, which resolves only once
 *                  every tracked card job AND any collector-expiry render has
 *                  finished. That is production code (`runCardJob`), not a test
 *                  affordance: these jobs used to be untracked `void (async …)`,
 *                  which is precisely why the only way to observe them was a
 *                  timer.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";

/**
 * Three branches read a prompt template from a hard-coded absolute path. Stub
 * just that read so the tests do not depend on the machine they run on;
 * everything else still reaches the real filesystem.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      readFile: async (target: unknown, enc: unknown) =>
        String(target).endsWith("compact.md")
          ? "COMPACTION TEMPLATE"
          : (actual.promises.readFile as (a: unknown, b: unknown) => Promise<string>)(target, enc),
    },
  };
});

/** Controls the throwaway runtime the summary / migrate / import jobs spawn. */
const runtime = {
  gate: null as null | Promise<void>,
  onStart: null as null | (() => void),
  text: "THE GENERATED SUMMARY BODY",
  fail: null as null | Error,
};

vi.mock("../packages/core/src/agents/agent-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AgentRuntime: class FakeAgentRuntime {
      private handler: ((e: { kind: string; text: string }) => void) | undefined;
      async start(): Promise<void> {}
      async newSession(): Promise<void> {}
      onEvent(h: (e: { kind: string; text: string }) => void): void {
        this.handler = h;
      }
      async prompt(): Promise<{ stopReason: string }> {
        runtime.onStart?.();
        if (runtime.gate) await runtime.gate;
        if (runtime.fail) throw runtime.fail;
        this.handler?.({ kind: "agent-text", text: runtime.text });
        return { stopReason: "end_turn" };
      }
      async dispose(): Promise<void> {}
      getSessionInfo(): { sessionId: string } {
        return { sessionId: "temp-session" };
      }
    },
  };
});

const {
  Orchestrator,
  CARD_FALLBACK_TEXT,
  CARD_RESULT_PARKED_NOTICE,
  CARD_RESULT_REJECTED_NOTICE,
} = await import("../packages/core/src/platforms/discord/orchestrator.js");
const { CARD_RESULT_BODY_MAX_BYTES } = await import(
  "../packages/core/src/core/card-result-vault.js"
);
const { hasEnabledComponents } = await import(
  "../packages/core/src/platforms/discord/collector-lifecycle.js"
);
const { describeAttachOutcome, planSessionAttachment } = await import(
  "../packages/core/src/core/session-attach.js"
);
const { MessageFlags } = await import("discord.js");
type SessionRecord = import("../packages/core/src/core/types.js").SessionRecord;
type Logger = import("../packages/core/src/lib/logger.js").Logger;

const silent = pino({ level: "silent" }) as unknown as Logger;

/** One scratch DATA_DIR per test file run; the result vault lives under it. */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-179-card-"));
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing awaits the rejection until the job does; keep Node quiet meanwhile.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * Drain the microtask queue. Deterministic — every await in the paths under
 * test is on an already-resolved promise, so this is ordering, not timing.
 * Deliberately NOT `setTimeout`: a macrotask hop would let real I/O interleave
 * and turn an ordering assertion back into a race.
 */
const microtasks = async (turns = 25) => {
  for (let n = 0; n < turns; n++) await Promise.resolve();
};

const summaryRow = (sessionId: string) => ({
  sessionId,
  createdAt: 1_700_000_000_000,
  lastActivityAt: 1_700_000_100_000,
  previewLines: [{ sender: "human" as const, text: "hello" }],
});

/**
 * Stand-in for a `discord.js` InteractionCollector: `stop()` is one-way, fires
 * `end` once, and a click after a stop is never delivered — which is exactly
 * the property that makes a repainted control unanswerable.
 */
class FakeCollector {
  stopped: string | null = null;
  private endListeners: Array<(collected: unknown, reason: string) => void> = [];
  private collectListeners: Array<(evt: unknown) => Promise<void>> = [];

  constructor(
    private readonly edit: (payload: unknown) => Promise<void>,
    private readonly modal: () => unknown,
    private readonly onDefer: () => void = () => {}
  ) {}

  on(event: "end" | "collect", listener: (...args: never[]) => unknown): this {
    if (event === "end") this.endListeners.push(listener as never);
    else this.collectListeners.push(listener as never);
    return this;
  }

  private ends: unknown[] = [];

  stop(reason = "user"): void {
    if (this.stopped !== null) return;
    this.stopped = reason;
    for (const l of this.endListeners) this.ends.push(l(undefined, reason));
  }

  /**
   * Resolves once the `end` listeners have finished. The lifecycle's expiry
   * render is one of them, and it is what strips the controls — so this is the
   * gate for "the card has actually expired", separate from "the JOB is done".
   */
  async expired(): Promise<void> {
    await Promise.allSettled(this.ends);
  }

  /** Deliver a click. `false` means the collector would have refused it. */
  async click(customId: string, values?: string[]): Promise<boolean> {
    if (this.stopped !== null) return false;
    const evt = {
      customId,
      user: { id: "op" },
      isStringSelectMenu: () => Boolean(values),
      values: values ?? [],
      // Acking the click is itself a round trip to Discord — a window in which
      // the operator can still press another button.
      deferUpdate: async () => {
        this.onDefer();
      },
      editReply: async (payload: unknown) => {
        await this.edit(payload);
      },
      followUp: async () => {},
      reply: async () => {},
      deleteReply: async () => {},
      showModal: async () => {},
      awaitModalSubmit: async () => this.modal(),
    };
    for (const l of this.collectListeners) await l(evt);
    return true;
  }
}

interface HarnessOpts {
  bound?: string;
  sessions?: string[];
  /** Who is driving the browser — retrieval is keyed on this. */
  userId?: string;
  /** DATA_DIR, so two harnesses can share one result vault. */
  dataDir?: string;
  /** Hold the Nth render (1-based), so a click can land inside a repaint. */
  holdRenderNo?: number;
  holdUntil?: Promise<void>;
  /** Runs while the click is being ACKed — before any repaint exists. */
  onDeferUpdate?: (bound: { value: string }) => void;
  /** Kill the interaction token after the browser is open (Discord's 15 min). */
  killTokenAfterOpen?: boolean;
  /** Inject Discord follow-up latency/failure at the delivery boundary. */
  followUp?: (payload: any) => Promise<void>;
  onCasRead?: (cell: { value: string }) => void;
  /** Destination agent id. Default claude (has a compaction model in this harness). */
  agentId?: string;
  /** When false, the router has no usable AGY profile (Discord premium hidden). */
  agy?: boolean;
}

function makeHarness(opts: HarnessOpts = {}) {
  const bound = { value: opts.bound ?? "acp-source" };
  const record: SessionRecord = {
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: null,
    agentId: opts.agentId ?? "claude",
    acpSessionId: bound.value,
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
  };

  let listed = (opts.sessions ?? ["acp-source", "acp-other"]).map(summaryRow);
  const transcript = deferred<string>();
  const manager = {
    listSessions: async () => listed,
    getHistoryPath: () => "/tmp/history.jsonl",
    getTranscript: async () => transcript.promise,
    deleteSession: async () => {},
    cloneSession: async () => {},
  };
  const profile = {
    id: opts.agentId ?? "claude",
    displayName: "Claude",
    sessionManager: manager,
  };
  const target = { id: "codex", displayName: "Codex", sessionManager: manager };
  const agy =
    opts.agy === false
      ? undefined
      : {
          id: "agy",
          displayName: "Antigravity",
          sessionManager: manager,
          listPickerModels: async () => [
            { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
          ],
        };

  const invalidated: Array<{ id: string; opts: unknown }> = [];
  const upserts: SessionRecord[] = [];
  const router = {
    listProfiles: () => (agy ? [profile, target, agy] : [profile, target]),
    describeConfig: () => ({}),
    getProfile: (id?: string) => {
      if (id === "agy") return agy;
      if (id === "codex") return target;
      return profile;
    },
    ensureSessionRecord: () => record,
    invalidate: async (id: string, o: unknown) => void invalidated.push({ id, opts: o }),
  };

  const casCalls: Array<{ expected: string; next: string; ok: boolean }> = [];
  const store = {
    get: () => ({ ...record, acpSessionId: bound.value }),
    compareAndSwapAcpSession: (_id: string, expected: string, next: string) => {
      opts.onCasRead?.(bound);
      const ok = bound.value === expected;
      if (ok) bound.value = next;
      casCalls.push({ expected, next, ok });
      return ok;
    },
    readConfig: () => ({ model: "opus", reasoningEffort: "high" }),
    upsert: (r: SessionRecord) => {
      upserts.push(r);
      bound.value = r.acpSessionId;
    },
    recordDelegation: () => {},
    updateDelegationStatus: () => {},
  };

  /** Every payload the operator would actually see, in order. */
  const renders: any[] = [];
  const threadMessages: string[] = [];
  const threadFiles: Array<{ filename: string; body: string }> = [];
  const tokenDead = { value: false };
  let rendersSeen = 0;
  const paint = async (payload: unknown) => {
    rendersSeen++;
    // The card's real edits are round trips. Holding the FIRST one models the
    // window between admitting a click and its progress card landing — the
    // window in which the operator can still press Attach.
    if (opts.holdUntil && rendersSeen === (opts.holdRenderNo ?? 2)) await opts.holdUntil;
    if (tokenDead.value) throw new Error("Unknown Webhook");
    renders.push(payload);
  };

  const modalSubmission = {
    fields: { getTextInputValue: () => "/repo/target" },
    user: { id: "op" },
    reply: async () => {},
    deferUpdate: async () => {},
    editReply: async (payload: unknown) => {
      await paint(payload);
    },
  };

  const collector = new FakeCollector(paint, () => modalSubmission, () =>
    opts.onDeferUpdate?.(bound)
  );
  /** The card's real `CardLifecycle`, captured as `cmdSessions` builds it. */
  let lifecycle!: import("../packages/core/src/platforms/discord/collector-lifecycle.js").CardLifecycle;
  const msg = { createMessageComponentCollector: () => collector };

  /** Ephemeral follow-ups: the PRIVATE surface, visible only to the invoker. */
  const followUps: any[] = [];
  const interaction = {
    channelId: "thread-1",
    channel: null,
    user: { id: opts.userId ?? "op" },
    deferReply: async () => {},
    editReply: async (payload: any) => {
      await paint(payload);
      return msg;
    },
    followUp: async (payload: any) => {
      await opts.followUp?.(payload);
      followUps.push(payload);
      return { id: "fu1" };
    },
    deleteReply: async () => {},
    options: { getSubcommand: () => "sessions" },
  };

  const adapter = {
    sendMessage: async (_c: unknown, body: string) => {
      threadMessages.push(body);
      return { channel: _c, id: "m1" };
    },
    sendFile: async (_c: unknown, file: { data: Buffer; filename: string }) => {
      threadFiles.push({ filename: file.filename, body: file.data.toString("utf8") });
      return { channel: _c, id: "f1" };
    },
  };

  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: opts.dataDir ?? dataDir,
      REPOS_ROOT: "/repo",
      DEFAULT_MODEL: "default",
      CLAUDE_COMPACTION_MODEL: "claude-opus-4.8",
      REPO_EMOJIS: new Map<string, string>(),
      CHANNEL_PRESETS_FILE: undefined,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      channelPresets: {},
      threadPresets: {},
    } as any,
    adapter: adapter as any,
    router: router as any,
    store: store as any,
    renderer: {} as any,
  });

  // The compaction / rebuild pipelines are held open by explicit deferreds and
  // signal entry, so the test never has to guess that a job has started.
  const pipeline = deferred<any>();
  const entered = deferred<void>();
  const compactCalls: any[] = [];
  (orch as any).compactThread = async (rec: SessionRecord, o: any) => {
    compactCalls.push({ rec, opts: o });
    entered.resolve();
    return pipeline.promise;
  };
  (orch as any).buildDefaultCompactionSeed = async () => {
    entered.resolve();
    return pipeline.promise;
  };
  (orch as any).rebuildSessionFromThread = async () => {
    entered.resolve();
    return pipeline.promise;
  };
  const seedCalls: any[] = [];
  (orch as any).seedNewSession = async (a: any) => {
    seedCalls.push(a);
    return "acp-new";
  };
  (orch as any).applyThreadName = async () => {};
  // Capture the REAL lifecycle `cmdSessions` builds — not a stand-in — so a
  // test can issue a render through exactly the path production uses.
  const attachReal = (orch as any).attachListLifecycle.bind(orch);
  (orch as any).attachListLifecycle = (...args: unknown[]) => {
    lifecycle = attachReal(...args);
    return lifecycle;
  };
  // The runtime-backed jobs (summary / migrate / import) signal entry here.
  runtime.onStart = () => entered.resolve();

  /**
   * Resolves the moment the job reaches `settleLongJobCard` — i.e. it has
   * finished everything else (including the report file write, which is real
   * I/O) and is about to issue its RESULT edit. A production entry point, not a
   * drain: the whole question under test is what happens between "about to
   * render" and "rendered".
   */
  const settleEntered = deferred<void>();
  const realSettleLongJobCard = (orch as any).settleLongJobCard.bind(orch);
  (orch as any).settleLongJobCard = (o: unknown) => {
    settleEntered.resolve();
    return realSettleLongJobCard(o);
  };

  const attachViaPrimitive = (newId = "acp-new") =>
    (orch as any).attachCompactedSession({
      record,
      sourceId: "acp-source",
      newId,
      observedAtStart: opts.bound ?? "acp-source",
      intent: "attach",
    }) as Promise<{ attached: boolean; reason: string }>;

  return {
    orch,
    open: async () => {
      await (orch as any).cmdSessions(interaction);
      if (opts.killTokenAfterOpen) tokenDead.value = true;
    },
    /** Resolves once the launched job has entered its (stubbed) pipeline. */
    started: entered.promise,
    /** THE completion gate: every tracked card job and expiry render is done. */
    settle: () => (orch as any).settleCardJobs() as Promise<void>,
    killToken: () => void (tokenDead.value = true),
    collector,
    /** Edits STARTED, including any still in flight. */
    rendersSeen: () => rendersSeen,
    /** Resolves when the job is about to issue its result edit. */
    aboutToRenderResult: settleEntered.promise,
    get lifecycle() {
      return lifecycle;
    },
    renders,
    followUps,
    threadMessages,
    threadFiles,
    invalidated,
    upserts,
    casCalls,
    bound,
    record,
    pipeline,
    transcript,
    compactCalls,
    seedCalls,
    attachViaPrimitive,
    last: () => renders[renders.length - 1],
    addSession: (id: string) => void (listed = [...listed, summaryRow(id)]),
  };
}

/** Flatten every embed in a render payload into searchable text. */
function text(payload: any): string {
  return (
    (payload?.embeds ?? [])
      .map((e: any) => `${e?.data?.title ?? ""}\n${e?.data?.description ?? ""}`)
      .join("\n") + `\n${payload?.content ?? ""}`
  );
}

function customIds(payload: any): string[] {
  const ids: string[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const id = node.data?.custom_id ?? node.customId ?? node.custom_id;
    if (typeof id === "string") ids.push(id);
    if (node.components) walk(node.components);
    if (node.data?.components) walk(node.data.components);
  };
  walk(payload?.components);
  return ids;
}

const PREMIUM = ["sessions:premium", "sessions:premium_discord"] as const;
const ALL_COMPACT = ["sessions:compact", ...PREMIUM] as const;

beforeEach(() => {
  runtime.gate = null;
  runtime.fail = null;
  runtime.onStart = null;
  runtime.text = "THE GENERATED SUMMARY BODY";
});

/** Resolve whichever pipeline the clicked button uses, with a success value. */
async function finishCompaction(h: ReturnType<typeof makeHarness>, customId: string) {
  h.addSession("acp-new");
  if (customId === "sessions:compact") {
    // This branch owns its own attach decision (it seeds inline), so the test
    // must NOT run one for it — doing so would consume the CAS and make the
    // real decision look like a lost race.
    h.pipeline.resolve({ seed: "SEED", keptTurns: 3, summarizedTurns: 7, pinnedCount: 2 });
    await h.settle();
    return null;
  }
  // The premium pair delegates to `compactThread`, which is stubbed here; run
  // the REAL primitive so the result it returns is a real decision.
  const attachment = await h.attachViaPrimitive();
  h.pipeline.resolve({
    newSessionId: "acp-new",
    originalSessionId: "acp-source",
    wasActive: attachment.attached && attachment.reason === "swapped",
    attachment,
    reportMarkdown: "# report",
    stats: { chunks: 3 },
  });
  await h.settle();
  return attachment;
}

// ---------------------------------------------------------------------------
// A. Attachment — decided at completion, from authoritative state
// ---------------------------------------------------------------------------

describe("#179 compaction attaches its result", () => {
  it.each(ALL_COMPACT)("%s: an ACTIVE source session is swapped to the new one", async (id) => {
    const h = makeHarness({ bound: "acp-source" });
    await h.open();
    await h.collector.click(id);
    await h.started;

    const attachment = await finishCompaction(h, id);
    if (attachment) expect(attachment).toEqual({ attached: true, reason: "swapped" });
    expect(h.casCalls).toEqual([{ expected: "acp-source", next: "acp-new", ok: true }]);
    expect(h.bound.value).toBe("acp-new");
    expect(text(h.last())).toContain("now bound to");
  });

  it.each(ALL_COMPACT)("%s: an UNBOUND thread is attached, not left disconnected", async (id) => {
    // The reported flow: an agent switch cleared the ACP binding, then the
    // operator compacted a session picked from the list.
    const h = makeHarness({ bound: "" });
    await h.open();
    await h.collector.click(id);
    await h.started;

    const attachment = await finishCompaction(h, id);
    if (attachment) expect(attachment).toEqual({ attached: true, reason: "bound-unbound" });
    expect(h.casCalls).toEqual([{ expected: "", next: "acp-new", ok: true }]);
    expect(h.bound.value).toBe("acp-new");
    expect(text(h.last())).toContain("had no active session");
  });

  it.each(ALL_COMPACT)("%s: a rebinding during the run is preserved and stated", async (id) => {
    const h = makeHarness({ bound: "acp-source" });
    await h.open();
    await h.collector.click(id);
    await h.started;
    h.bound.value = "acp-chosen-during-run"; // the operator moved on

    const attachment = await finishCompaction(h, id);
    if (attachment) expect(attachment).toEqual({ attached: false, reason: "rebound-elsewhere" });
    expect(h.casCalls).toHaveLength(0);
    expect(h.bound.value).toBe("acp-chosen-during-run");
    expect(text(h.last())).toContain("Left unattached");
  });

  it("sessions:compact reads its 'before' BEFORE the pipeline, not after", async () => {
    // The plain button seeds inline, so it captures `observedAtStart` itself.
    // Here the operator DETACHES mid-run and the shared `record` follows — the
    // same object the browser holds for its whole life. A completion-time read
    // would see ""=="" , call it "no change", and re-bind the thread the
    // operator had just disconnected.
    const h = makeHarness({ bound: "acp-source" });
    await h.open();
    await h.collector.click("sessions:compact");
    await h.started;

    h.bound.value = "";
    h.record.acpSessionId = "";

    h.addSession("acp-new");
    h.pipeline.resolve({ seed: "SEED", keptTurns: 1, summarizedTurns: 1, pinnedCount: 0 });
    await h.settle();

    expect(h.casCalls).toHaveLength(0); // nothing was written…
    expect(h.bound.value).toBe(""); // …so the detach stands
    expect(text(h.last())).toContain("Left unattached");
  });

  it("premium_discord runs the Discord pipeline; both premium buttons ask to attach", async () => {
    const a = makeHarness();
    await a.open();
    await a.collector.click("sessions:premium_discord");
    await a.started;
    expect(a.compactCalls[0].opts).toMatchObject({
      source: "discord",
      sessionId: "acp-source",
      attachIntent: "attach",
    });

    const b = makeHarness();
    await b.open();
    await b.collector.click("sessions:premium");
    await b.started;
    expect(b.compactCalls[0].opts.source).toBeUndefined();
    expect(b.compactCalls[0].opts.attachIntent).toBe("attach");
  });

  it("shows Discord premium when AGY is available even if the destination has no compaction model", async () => {
    const h = makeHarness({ agentId: "no-such-agent" });
    await h.open();
    const ids = customIds(h.last());
    expect(ids).toContain("sessions:premium_discord");
    expect(ids).not.toContain("sessions:premium");
    expect(ids).not.toContain("sessions:compact");
  });

  it("hides Discord premium when AGY is missing even if the destination can compact", async () => {
    const h = makeHarness({ agy: false });
    await h.open();
    const ids = customIds(h.last());
    expect(ids).not.toContain("sessions:premium_discord");
    expect(ids).toContain("sessions:premium");
    expect(ids).toContain("sessions:compact");
  });

  it("re-reads the binding for EVERY render, not just after its own compaction", async () => {
    const h = makeHarness({ bound: "acp-source" });
    await h.open();
    expect(text(h.last())).toContain("Active Session in this channel");

    h.bound.value = "acp-other"; // changed elsewhere; no compaction involved
    await h.collector.click("sessions:next");

    const shown = text(h.last());
    expect(shown).toContain("acp-other");
    expect(shown).toContain("Active Session in this channel");
  });

  it("the browser marks the ACTUALLY persisted session active after a compaction", async () => {
    const h = makeHarness({ bound: "acp-source" });
    await h.open();
    await h.collector.click("sessions:premium");
    await h.started;
    await finishCompaction(h, "sessions:premium");

    expect(await h.collector.click("sessions:summary_back")).toBe(true);
    const rebuilt = text(h.last());
    expect(rebuilt).toContain("acp-new");
    expect(rebuilt).toContain("Active Session in this channel");
  });
});

// ---------------------------------------------------------------------------
// B. Every job, every exit: a live card keeps controls, an expired one does not
// ---------------------------------------------------------------------------

describe("#179 compaction exits", () => {
  it.each(ALL_COMPACT)("%s: SUCCESS on a live card keeps a working Back", async (id) => {
    const h = makeHarness();
    await h.open();
    await h.collector.click(id);
    await h.started;
    await finishCompaction(h, id);

    expect(hasEnabledComponents(h.last().components)).toBe(true);
    expect(JSON.stringify(h.last().components)).toContain("sessions:summary_back");
    expect(h.collector.stopped).toBeNull();
    expect(await h.collector.click("sessions:summary_back")).toBe(true);
  });

  it.each(ALL_COMPACT)("%s: SUCCESS after expiry settles component-free", async (id) => {
    const h = makeHarness();
    await h.open();
    await h.collector.click(id);
    await h.started;

    h.collector.stop("time"); // the 10-minute collector gives up mid-run…
    await h.collector.expired(); // …and its expiry render is awaited exactly
    expect(hasEnabledComponents(h.last().components)).toBe(false);

    await finishCompaction(h, id);

    const final = h.last();
    expect(text(final)).toContain("acp-new"); // the result still arrives
    expect(hasEnabledComponents(final.components)).toBe(false);
    expect(final.content).toContain("run `/seam info sessions` again");
    expect(JSON.stringify(final.components ?? [])).not.toContain("sessions:summary_back");
    expect(await h.collector.click("sessions:summary_back")).toBe(false);
  });

  it.each(ALL_COMPACT)("%s: FAILURE on a live card keeps a working Back", async (id) => {
    const h = makeHarness();
    await h.open();
    await h.collector.click(id);
    await h.started;
    h.pipeline.reject(new Error("pipeline exploded"));
    await h.settle();

    expect(text(h.last())).toContain("pipeline exploded");
    expect(hasEnabledComponents(h.last().components)).toBe(true);
  });

  it.each(ALL_COMPACT)("%s: FAILURE after expiry settles component-free", async (id) => {
    const h = makeHarness();
    await h.open();
    await h.collector.click(id);
    await h.started;
    h.collector.stop("time");
    await h.collector.expired();

    h.pipeline.reject(new Error("pipeline exploded"));
    await h.settle();

    expect(text(h.last())).toContain("pipeline exploded");
    expect(hasEnabledComponents(h.last().components)).toBe(false);
  });

  it("progress frames cannot repaint an expired card", async () => {
    const h = makeHarness();
    await h.open();
    await h.collector.click("sessions:premium");
    await h.started;
    h.collector.stop("time");
    await h.collector.expired();

    const afterExpiry = h.renders.length;
    const onProgress = h.compactCalls[0].opts.onProgress as (m: string) => void;
    for (let n = 0; n < 5; n++) onProgress(`step ${n}`);

    // Gate on the JOB finishing, not on a timer: exactly one further render
    // lands — the completion card. None of the five progress frames did, so the
    // expiry notice was never overwritten by something that reads as live.
    await finishCompaction(h, "sessions:premium");
    expect(h.renders.length).toBe(afterExpiry + 1);
    expect(hasEnabledComponents(h.last().components)).toBe(false);
  });
});

describe("#179 sessions:rebuild exits", () => {
  const run = async (h: ReturnType<typeof makeHarness>) => {
    await h.open();
    await h.collector.click("sessions:rebuild");
    await h.started;
  };

  it("SUCCESS on a live card keeps its Close button", async () => {
    const h = makeHarness();
    await run(h);
    h.pipeline.resolve({ newSessionId: "acp-rebuilt", summary: "rebuilt summary" });
    await h.settle();

    expect(text(h.last())).toContain("acp-rebuilt");
    expect(hasEnabledComponents(h.last().components)).toBe(true);
    expect(JSON.stringify(h.last().components)).toContain("sessions:close");
  });

  it("SUCCESS after expiry settles component-free", async () => {
    const h = makeHarness();
    await run(h);
    h.collector.stop("time");
    await h.collector.expired();
    h.pipeline.resolve({ newSessionId: "acp-rebuilt", summary: "rebuilt summary" });
    await h.settle();

    expect(text(h.last())).toContain("acp-rebuilt");
    expect(hasEnabledComponents(h.last().components)).toBe(false);
    expect(JSON.stringify(h.last().components ?? [])).not.toContain("sessions:close");
  });

  it("FAILURE on a live card keeps Back", async () => {
    const h = makeHarness();
    await run(h);
    h.pipeline.reject(new Error("rebuild boom"));
    await h.settle();
    expect(text(h.last())).toContain("rebuild boom");
    expect(hasEnabledComponents(h.last().components)).toBe(true);
  });

  it("FAILURE after expiry settles component-free", async () => {
    const h = makeHarness();
    await run(h);
    h.collector.stop("time");
    await h.collector.expired();
    h.pipeline.reject(new Error("rebuild boom"));
    await h.settle();
    expect(text(h.last())).toContain("rebuild boom");
    expect(hasEnabledComponents(h.last().components)).toBe(false);
  });
});

describe("#179 sessions:summary exits", () => {
  const run = async (h: ReturnType<typeof makeHarness>) => {
    await h.open();
    await h.collector.click("sessions:summary");
    h.transcript.resolve("### User\nhello\n\n### Assistant\nhi");
    await h.started;
  };

  it("SUCCESS on a live card keeps Back", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    gate.resolve();
    await h.settle();

    expect(text(h.last())).toContain("THE GENERATED SUMMARY BODY");
    expect(hasEnabledComponents(h.last().components)).toBe(true);
  });

  it("SUCCESS after expiry still shows the summary, component-free", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    h.collector.stop("time");
    await h.collector.expired();
    gate.resolve();
    await h.settle();

    expect(text(h.last())).toContain("THE GENERATED SUMMARY BODY");
    expect(hasEnabledComponents(h.last().components)).toBe(false);
  });

  it("FAILURE on a live card keeps Back", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    runtime.fail = new Error("summary boom");
    gate.resolve();
    await h.settle();
    expect(text(h.last())).toContain("summary boom");
    expect(hasEnabledComponents(h.last().components)).toBe(true);
  });

  it("FAILURE after expiry settles component-free", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    h.collector.stop("time");
    await h.collector.expired();
    runtime.fail = new Error("summary boom");
    gate.resolve();
    await h.settle();
    expect(text(h.last())).toContain("summary boom");
    expect(hasEnabledComponents(h.last().components)).toBe(false);
  });
});

describe("#179 sessions:migrate exits", () => {
  const run = async (h: ReturnType<typeof makeHarness>) => {
    await h.open();
    await h.collector.click("sessions:migrate_target", ["codex"]);
    h.transcript.resolve("### User\nhello\n\n### Assistant\nhi");
    await h.started;
  };

  it("SUCCESS is terminal, component-free, and stops the collector", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    gate.resolve();
    await h.settle();

    expect(text(h.last())).toContain("Migrated Successfully");
    // A migration rebinds the thread — there is nothing left to go Back to.
    expect(hasEnabledComponents(h.last().components)).toBe(false);
    expect(h.collector.stopped).not.toBeNull();
  });

  it("SUCCESS after expiry is still delivered, still component-free", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    h.collector.stop("time");
    await h.collector.expired();
    gate.resolve();
    await h.settle();

    expect(text(h.last())).toContain("Migrated Successfully");
    expect(hasEnabledComponents(h.last().components)).toBe(false);
  });

  it("FAILURE on a live card keeps Back", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    runtime.fail = new Error("migrate boom");
    gate.resolve();
    await h.settle();
    expect(text(h.last())).toContain("migrate boom");
    expect(hasEnabledComponents(h.last().components)).toBe(true);
  });

  it("FAILURE after expiry settles component-free", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    h.collector.stop("time");
    await h.collector.expired();
    runtime.fail = new Error("migrate boom");
    gate.resolve();
    await h.settle();
    expect(hasEnabledComponents(h.last().components)).toBe(false);
  });
});

describe("#179 sessions:import_to_cwd exits", () => {
  const run = async (h: ReturnType<typeof makeHarness>) => {
    await h.open();
    await h.collector.click("sessions:import_to_cwd");
    h.transcript.resolve("### User\nhello\n\n### Assistant\nhi");
    await h.started;
  };

  it("SUCCESS on a live card keeps Back", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    gate.resolve();
    await h.settle();
    expect(hasEnabledComponents(h.last().components)).toBe(true);
    expect(JSON.stringify(h.last().components)).toContain("sessions:summary_back");
  });

  it("SUCCESS after expiry settles component-free", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    h.collector.stop("time");
    await h.collector.expired();
    gate.resolve();
    await h.settle();
    expect(hasEnabledComponents(h.last().components)).toBe(false);
  });

  it("FAILURE on a live card keeps Back", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    runtime.fail = new Error("import boom");
    gate.resolve();
    await h.settle();
    expect(text(h.last())).toContain("import boom");
    expect(hasEnabledComponents(h.last().components)).toBe(true);
  });

  it("FAILURE after expiry settles component-free", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await run(h);
    h.collector.stop("time");
    await h.collector.expired();
    runtime.fail = new Error("import boom");
    gate.resolve();
    await h.settle();
    expect(hasEnabledComponents(h.last().components)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B2. Render ordering, and the admission-time "before"
// ---------------------------------------------------------------------------

describe("#179 renders serialize; the result is the last word", () => {
  it("the result edit cannot even BEGIN while an earlier one is in flight", async () => {
    // Two independent REST edits: under per-route backoff the earlier one can
    // finish last, and the operator's final view becomes a stale "compacting…".
    // The fix is that they are not independent — one FIFO per card — so the
    // observable property is that the result edit does not START until the
    // progress edit it was queued behind has landed.
    const held = deferred<void>();
    const h = makeHarness({ holdRenderNo: 3, holdUntil: held.promise });
    await h.open();
    await h.collector.click("sessions:premium");
    await h.started;

    const onProgress = h.compactCalls[0].opts.onProgress as (m: string) => void;
    onProgress("halfway"); // edit #3 — parked mid-flight
    await microtasks();
    expect(h.rendersSeen()).toBe(3);

    // Let the job run all the way to the point of issuing its result…
    const attachment = await h.attachViaPrimitive();
    h.addSession("acp-new");
    h.pipeline.resolve({
      newSessionId: "acp-new",
      originalSessionId: "acp-source",
      wasActive: true,
      attachment,
      reportMarkdown: "# report",
      stats: { chunks: 3 },
    });
    await h.aboutToRenderResult;
    await microtasks();

    // …and it is STILL queued behind the parked progress frame. Unserialized,
    // the result edit would already have gone out over the top of it.
    expect(h.rendersSeen()).toBe(3);

    held.resolve();
    await h.settle();

    const titles = h.renders.map((r: any) => String(r?.embeds?.[0]?.data?.title ?? ""));
    expect(titles[titles.length - 1]).toBe("✨ Premium Compaction Complete");
    expect(titles.lastIndexOf("✨ Premium Compaction Complete")).toBeGreaterThan(
      titles.lastIndexOf("✨ Premium Compaction")
    );
  });

  it("a progress frame requested AFTER the pipeline returned is dropped", async () => {
    const h = makeHarness();
    await h.open();
    await h.collector.click("sessions:premium");
    await h.started;
    const onProgress = h.compactCalls[0].opts.onProgress as (m: string) => void;

    await finishCompaction(h, "sessions:premium");
    const settledCount = h.renders.length;

    // A pipeline that retained the callback and kept emitting must not be able
    // to repaint over its own result.
    for (let n = 0; n < 5; n++) onProgress(`late ${n}`);
    await h.settle();
    expect(h.renders.length).toBe(settledCount);
    expect(String(h.last()?.embeds?.[0]?.data?.title)).toBe("✨ Premium Compaction Complete");
  });

  it("a render in flight is tracked even when no job is running", async () => {
    // Isolated from the job on purpose: while a compaction is outstanding its
    // own promise holds the drain, which would mask an untracked edit. Here the
    // card is idle and only the EDIT is in flight.
    const held = deferred<void>();
    const h = makeHarness({ holdRenderNo: 2, holdUntil: held.promise });
    await h.open();
    await h.settle();
    expect(h.orch.pendingCardJobCount).toBe(0);

    // A fire-and-forget repaint, exactly as `pushProgress` issues one.
    void h.lifecycle.refresh({ embeds: [], components: [] });
    await Promise.resolve();
    expect(h.orch.pendingCardJobCount).toBeGreaterThan(0);

    let drained = false;
    const gate = h.settle().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false); // the in-flight EDIT is holding shutdown

    held.resolve();
    await gate;
    expect(h.orch.pendingCardJobCount).toBe(0);
  });
});

describe("#179 the 'before' is sampled at click admission", () => {
  it("a DETACH landing while the click is being ACKed is not undone", async () => {
    // `deferUpdate` is a round trip. Sampling the binding on the far side of it
    // — even "early", before the progress repaint — records whatever the
    // operator just did as the baseline. Here they detach the session being
    // compacted: a later sample sees ""=="" , calls it "no change", and
    // re-binds the thread they just disconnected.
    const h = makeHarness({
      bound: "acp-source",
      onDeferUpdate: (bound) => {
        bound.value = "";
      },
    });
    await h.open();
    await h.collector.click("sessions:premium");
    await h.started;

    const attachment = await finishCompaction(h, "sessions:premium");
    expect(attachment).toEqual({ attached: false, reason: "rebound-elsewhere" });
    expect(h.casCalls).toHaveLength(0); // nothing written…
    expect(h.bound.value).toBe(""); // …so the detach stands
  });

  it("an Attach landing inside the initial repaint is preserved, not overwritten", async () => {
    const held = deferred<void>();
    const h = makeHarness({ bound: "acp-source", holdUntil: held.promise });
    await h.open();

    const click = h.collector.click("sessions:premium");
    await Promise.resolve();
    // Admitted; its progress repaint is still in flight. The operator attaches
    // something else RIGHT NOW.
    h.bound.value = "acp-attached-mid-repaint";

    held.resolve();
    await click;
    await h.started;

    const attachment = await finishCompaction(h, "sessions:premium");
    expect(attachment).toEqual({ attached: false, reason: "rebound-elsewhere" });
    expect(h.casCalls).toHaveLength(0);
    expect(h.bound.value).toBe("acp-attached-mid-repaint");
  });

  it("passes the admission-time value into compactThread, not a later read", async () => {
    const h = makeHarness({
      bound: "acp-source",
      onDeferUpdate: (bound) => {
        bound.value = "acp-moved";
      },
    });
    await h.open();
    await h.collector.click("sessions:premium");
    await h.started;

    expect(h.compactCalls[0].opts.observedAtStart).toBe("acp-source");
  });
});

// ---------------------------------------------------------------------------
// C. Dead interaction token — deliver the result, leak nothing
// ---------------------------------------------------------------------------

describe("#179 dead-token recovery", () => {
  it("falls back to the thread with a fixed notice", async () => {
    const h = makeHarness({ killTokenAfterOpen: true });
    await h.open();
    await h.collector.click("sessions:premium");
    await h.started;
    await finishCompaction(h, "sessions:premium");

    expect(h.threadMessages).toEqual([CARD_FALLBACK_TEXT.compaction.ok]);
  });

  it("a MIGRATION success reaches the operator even with a dead token", async () => {
    // The sharpest case: the thread has been rebound underneath them and the
    // card can no longer say so. `lifecycle.terminal` swallowed its own render
    // error and reported success, leaving no notice anywhere.
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await h.open();
    await h.collector.click("sessions:migrate_target", ["codex"]);
    h.transcript.resolve("### User\nhello");
    await h.started;
    h.killToken();
    gate.resolve();
    await h.settle();

    expect(h.threadMessages).toEqual([CARD_FALLBACK_TEXT.migration.ok]);
    // Terminal regardless: the collector is closed, so nothing can be clicked.
    expect(h.collector.stopped).not.toBeNull();
  });

  it("a completed AI SUMMARY is held privately, never published to the thread", async () => {
    // The summary exists nowhere else — no session, no file, no log. Discarding
    // it behind a "your summary is ready" notice loses work the operator paid
    // for; POSTING it promotes an ephemeral, one-operator result to everyone in
    // the channel, permanently, because a token timed out. Neither is
    // acceptable, so it is parked for private collection.
    const h = makeHarness();
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await h.open();
    await h.collector.click("sessions:summary");
    h.transcript.resolve("### User\nhello");
    await h.started;
    h.killToken();
    gate.resolve();
    await h.settle();

    // The thread learns only that something finished and where to get it.
    expect(h.threadMessages).toHaveLength(1);
    expect(h.threadMessages[0]).toContain(CARD_FALLBACK_TEXT.summary.ok);
    expect(h.threadMessages[0]).toContain(CARD_RESULT_PARKED_NOTICE);
    // The BODY never crossed publicly — no message, no attachment.
    expect(h.threadMessages.join("\n")).not.toContain("THE GENERATED SUMMARY BODY");
    expect(h.threadFiles).toHaveLength(0);
  });

  it("…and the same operator collects it privately by re-opening the browser", async () => {
    const shared = fs.mkdtempSync(path.join(dataDir, "vault-"));
    const first = makeHarness({ dataDir: shared, userId: "op" });
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await first.open();
    await first.collector.click("sessions:summary");
    first.transcript.resolve("### User\nhello");
    await first.started;
    first.killToken();
    gate.resolve();
    await first.settle();

    // Re-opening is the authenticated moment, and the reply is ephemeral — the
    // audience the summary was generated for in the first place.
    const again = makeHarness({ dataDir: shared, userId: "op" });
    await again.open();
    expect(again.followUps).toHaveLength(1);
    expect(again.followUps[0].flags).toBe(MessageFlags.Ephemeral);
    expect(String(again.followUps[0].files[0].name)).toBe("session-summary.md");
    expect(again.threadMessages).toHaveLength(0); // nothing public
    // Collected once: a third open finds nothing left to hand over.
    const third = makeHarness({ dataDir: shared, userId: "op" });
    await third.open();
    expect(third.followUps).toHaveLength(0);
  });

  it("a failed follow-up leaves the private result available for one later retry", async () => {
    const shared = fs.mkdtempSync(path.join(dataDir, "vault-"));
    const first = makeHarness({ dataDir: shared, userId: "op" });
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await first.open();
    await first.collector.click("sessions:summary");
    first.transcript.resolve("### User\nhello");
    await first.started;
    first.killToken();
    gate.resolve();
    await first.settle();

    const failed = makeHarness({
      dataDir: shared,
      userId: "op",
      followUp: async () => {
        throw new Error("injected Discord failure");
      },
    });
    await failed.open();
    expect(failed.followUps).toHaveLength(0);

    const retry = makeHarness({ dataDir: shared, userId: "op" });
    await retry.open();
    expect(retry.followUps).toHaveLength(1);
    expect(retry.followUps[0].files[0].attachment.toString("utf8")).toContain(
      "THE GENERATED SUMMARY BODY"
    );

    const afterAck = makeHarness({ dataDir: shared, userId: "op" });
    await afterAck.open();
    expect(afterAck.followUps).toHaveLength(0);
  });

  it("two simultaneous browser opens have one private delivery consumer", async () => {
    const shared = fs.mkdtempSync(path.join(dataDir, "vault-"));
    const producer = makeHarness({ dataDir: shared, userId: "op" });
    const jobGate = deferred<void>();
    runtime.gate = jobGate.promise;
    await producer.open();
    await producer.collector.click("sessions:summary");
    producer.transcript.resolve("### User\nhello");
    await producer.started;
    producer.killToken();
    jobGate.resolve();
    await producer.settle();

    const followEntered = deferred<void>();
    const followGate = deferred<void>();
    const first = makeHarness({
      dataDir: shared,
      userId: "op",
      followUp: async () => {
        followEntered.resolve();
        await followGate.promise;
      },
    });
    const firstOpen = first.open();
    await followEntered.promise;

    const second = makeHarness({ dataDir: shared, userId: "op" });
    await second.open();
    expect(second.followUps).toHaveLength(0);

    followGate.resolve();
    await firstOpen;
    expect(first.followUps).toHaveLength(1);
    const third = makeHarness({ dataDir: shared, userId: "op" });
    await third.open();
    expect(third.followUps).toHaveLength(0);
  });

  it("oversized private output fails closed with only a generic thread notice", async () => {
    const shared = fs.mkdtempSync(path.join(dataDir, "vault-"));
    const h = makeHarness({ dataDir: shared, userId: "op" });
    const privateBody = "S".repeat(CARD_RESULT_BODY_MAX_BYTES + 1);

    await (h.orch as any).postCardFallback(
      { platform: "discord", id: "thread-1" },
      { kind: "summary", outcome: "ok", recordId: "discord:thread-1", userId: "op" },
      { filename: "session-summary.md", body: privateBody }
    );

    expect(h.threadMessages).toHaveLength(1);
    expect(h.threadMessages[0]).toContain(CARD_RESULT_REJECTED_NOTICE);
    expect(h.threadMessages[0]).not.toContain(privateBody.slice(0, 100));
    expect(h.threadFiles).toHaveLength(0);
    const vaultDir = path.join(shared, "card-results");
    expect(fs.existsSync(vaultDir) ? fs.readdirSync(vaultDir) : []).toEqual([]);
  });

  it("a DIFFERENT operator in the same thread is never handed it", async () => {
    const shared = fs.mkdtempSync(path.join(dataDir, "vault-"));
    const owner = makeHarness({ dataDir: shared, userId: "op" });
    const gate = deferred<void>();
    runtime.gate = gate.promise;
    await owner.open();
    await owner.collector.click("sessions:summary");
    owner.transcript.resolve("### User\nhello");
    await owner.started;
    owner.killToken();
    gate.resolve();
    await owner.settle();

    // Same thread, same record, different person: the card this replaces was
    // visible to one operator, and the replacement must not be more visible.
    const bystander = makeHarness({ dataDir: shared, userId: "someone-else" });
    await bystander.open();
    expect(bystander.followUps).toHaveLength(0);

    // …and it is still there for the person it belongs to.
    const owner2 = makeHarness({ dataDir: shared, userId: "op" });
    await owner2.open();
    expect(owner2.followUps).toHaveLength(1);
  });

  it("leaks no session id and no exception text into the thread", async () => {
    // The card was EPHEMERAL; the thread is not. A session id names a stored
    // conversation and an exception can carry paths, prompts or credentials, so
    // neither may be widened just because a token expired.
    const h = makeHarness({ killTokenAfterOpen: true });
    await h.open();
    await h.collector.click("sessions:premium");
    await h.started;
    h.pipeline.reject(new Error("boom at /home/ubuntu/secret/path with TOKEN=abc123"));
    await h.settle();

    expect(h.threadMessages).toEqual([CARD_FALLBACK_TEXT.compaction.failed]);
    expect(h.threadFiles).toHaveLength(0); // nothing content-bearing, ever
    const posted = h.threadMessages.join("\n") + h.threadFiles.map((f) => f.filename).join("\n");
    expect(posted).not.toContain("acp-source");
    expect(posted).not.toContain("acp-new");
    expect(posted).not.toContain("TOKEN=abc123");
    expect(posted).not.toContain("/home/ubuntu/secret");
  });

  it("every fixed notice is free of ids and error detail by construction", () => {
    for (const [kind, pair] of Object.entries(CARD_FALLBACK_TEXT)) {
      for (const [outcome, sentence] of Object.entries(pair)) {
        const where = `${kind}.${outcome}`;
        expect(sentence.length, where).toBeGreaterThan(0);
        // No interpolation survived into the table, and no uuid-ish token.
        expect(sentence, where).not.toContain("${");
        expect(sentence, where).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// D. The attach decision itself — every branch, without a database
// ---------------------------------------------------------------------------

describe("#179 planSessionAttachment", () => {
  const base = {
    observedAtStart: "acp-source",
    sourceId: "acp-source",
    newId: "acp-new",
    intent: "attach" as const,
  };

  it("swaps when the compacted session still holds the binding", () => {
    expect(planSessionAttachment({ ...base, current: "acp-source" })).toEqual({
      action: "cas",
      expect: "acp-source",
      next: "acp-new",
      reason: "swapped",
    });
  });

  it("binds an unbound thread only with attach authority", () => {
    expect(planSessionAttachment({ ...base, current: "", observedAtStart: "" })).toEqual({
      action: "cas",
      expect: "",
      next: "acp-new",
      reason: "bound-unbound",
    });
    expect(
      planSessionAttachment({ ...base, current: "", observedAtStart: "", intent: "swap-only" })
    ).toEqual({ action: "skip", attached: false, reason: "source-inactive" });
  });

  it("preserves EVERY observable transition, in both directions", () => {
    // Changed to a third session…
    expect(planSessionAttachment({ ...base, current: "acp-other" })).toEqual({
      action: "skip",
      attached: false,
      reason: "rebound-elsewhere",
    });
    // …DETACHED during the run: binding the result would undo that.
    expect(planSessionAttachment({ ...base, current: "" })).toEqual({
      action: "skip",
      attached: false,
      reason: "rebound-elsewhere",
    });
    // …ATTACHED during the run, to the very session being compacted. An earlier
    // revision read this as "so they want its compaction" and swapped, which
    // overwrote a deliberate choice with a guess about intent.
    expect(planSessionAttachment({ ...base, current: "acp-source", observedAtStart: "" })).toEqual({
      action: "skip",
      attached: false,
      reason: "rebound-elsewhere",
    });
    // …and a third session that was ALREADY bound before we started is not a
    // transition, just not ours.
    expect(
      planSessionAttachment({ ...base, current: "acp-other", observedAtStart: "acp-other" })
    ).toEqual({ action: "skip", attached: false, reason: "source-inactive" });
  });

  it("idempotence outranks change detection; a deleted record writes nothing", () => {
    // Already where we wanted to be, however it got there: a no-op, not a race.
    expect(
      planSessionAttachment({ ...base, current: "acp-new", observedAtStart: "acp-source" })
    ).toEqual({ action: "noop", attached: true, reason: "already-attached" });
    expect(planSessionAttachment({ ...base, current: null })).toEqual({
      action: "skip",
      attached: false,
      reason: "record-gone",
    });
  });

  it("names every outcome, including the unattached ones", () => {
    const ids = { newId: "acp-new", sourceId: "acp-source" };
    const outcomes = [
      { attached: true, reason: "swapped" },
      { attached: true, reason: "bound-unbound" },
      { attached: true, reason: "already-attached" },
      { attached: false, reason: "rebound-elsewhere" },
      { attached: false, reason: "source-inactive" },
      { attached: false, reason: "record-gone" },
    ] as const;
    for (const outcome of outcomes) {
      const line = describeAttachOutcome(outcome as never, ids);
      expect(line.length).toBeGreaterThan(0);
      if (!outcome.attached) expect(line).toContain("Left unattached");
    }
  });
});

// ---------------------------------------------------------------------------
// E. The gate itself must be a real gate
// ---------------------------------------------------------------------------

describe("#179 card jobs are tracked, not fire-and-forget", () => {
  it("settleCardJobs waits for a job that is still running", async () => {
    const h = makeHarness();
    await h.open();
    await h.collector.click("sessions:premium");
    await h.started;
    expect(h.orch.pendingCardJobCount).toBeGreaterThan(0);

    let settled = false;
    const gate = h.settle().then(() => {
      settled = true;
    });
    // A microtask drain is not enough: the job is genuinely outstanding.
    await Promise.resolve();
    expect(settled).toBe(false);

    await finishCompaction(h, "sessions:premium");
    await gate;
    expect(settled).toBe(true);
    expect(h.orch.pendingCardJobCount).toBe(0);
  });

  it("a job that throws outside its own try/catch is caught, not unhandled", async () => {
    const h = makeHarness();
    await h.open();
    (h.orch as any).runCardJob(async () => {
      throw new Error("escaped");
    });
    await expect(h.settle()).resolves.toBeUndefined();
    expect(h.orch.pendingCardJobCount).toBe(0);
  });
});
