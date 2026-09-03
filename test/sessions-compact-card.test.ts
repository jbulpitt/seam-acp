/**
 * #179 — the session browser's three compaction buttons.
 *
 * Two defects, both only visible at COMPLETION time:
 *
 *  A. attachment. The binding decision was a boolean captured before a pipeline
 *     that can run for ten minutes, so a thread left unbound by an agent switch
 *     got a resumable seed with nothing pointing at it, a binding changed
 *     during the run could be clobbered, and the browser kept rendering the
 *     stale snapshot afterwards.
 *
 *  B. card lifecycle. Each button launched an unawaited job and then wrote the
 *     result with a raw `editReply({ components: [backRow] })`. If the
 *     10-minute collector expired first, that repainted a live-looking
 *     `Back to Manage` onto an already-expired card — a control whose only
 *     possible answer is Discord's interaction error (#159's invariant, broken
 *     from the late-writer side).
 *
 * These tests drive the REAL `cmdSessions` collector: the real handler, the
 * real `CardLifecycle`, the real attach decision and the real compare-and-swap.
 * Only the transport, the session manager and the compaction pipeline are
 * stubbed, and every timing point is an explicit deferred rather than a sleep.
 */
import { describe, it, expect, vi } from "vitest";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { hasEnabledComponents } from "../packages/core/src/platforms/discord/collector-lifecycle.js";
import {
  describeAttachOutcome,
  planSessionAttachment,
} from "../packages/core/src/core/session-attach.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Drain enough macrotask turns that a fire-and-forget job has settled. */
const flush = async (turns = 12) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

const summary = (sessionId: string) => ({
  sessionId,
  createdAt: 1_700_000_000_000,
  lastActivityAt: 1_700_000_100_000,
  previewLines: [{ sender: "human" as const, text: "hello" }],
});

/**
 * Stand-in for a `discord.js` InteractionCollector: `stop()` is one-way, fires
 * `end` once, and a click after a stop is never delivered — which is exactly
 * the property that makes a repainted Back button unanswerable.
 */
class FakeCollector {
  stopped: string | null = null;
  private endListeners: Array<(collected: unknown, reason: string) => void> = [];
  private collectListeners: Array<(evt: unknown) => Promise<void>> = [];

  /**
   * A component interaction's `editReply` edits the SAME message as the
   * original interaction's, so both are recorded into one timeline — otherwise
   * a test cannot tell what the operator is actually looking at.
   */
  constructor(private readonly edit: (payload: unknown) => void) {}

  on(event: "end" | "collect", listener: (...args: never[]) => unknown): this {
    if (event === "end") this.endListeners.push(listener as never);
    else this.collectListeners.push(listener as never);
    return this;
  }

  stop(reason = "user"): void {
    if (this.stopped !== null) return;
    this.stopped = reason;
    for (const l of this.endListeners) l(undefined, reason);
  }

  /** Deliver a click. `false` means Discord/the collector would have refused it. */
  async click(customId: string): Promise<boolean> {
    if (this.stopped !== null) return false;
    const evt = {
      customId,
      user: { id: "op" },
      isStringSelectMenu: () => false,
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        this.edit(payload);
      },
      followUp: async () => {},
      reply: async () => {},
      deleteReply: async () => {},
    };
    for (const l of this.collectListeners) await l(evt);
    return true;
  }
}

interface HarnessOpts {
  /** Binding the store reports. "" = unbound. */
  bound?: string;
  /** Sessions the manager lists, before the compaction adds one. */
  sessions?: string[];
  /**
   * Kill the interaction token AFTER the browser is open (Discord expires it
   * at 15 minutes) — a harness that kills it up front never gets a collector.
   */
  killTokenAfterOpen?: boolean;
  /** Runs between the CAS read and its write. */
  onCasRead?: (cell: { value: string }) => void;
}

function makeHarness(opts: HarnessOpts = {}) {
  const bound = { value: opts.bound ?? "acp-source" };
  const record: SessionRecord = {
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: null,
    agentId: "claude",
    acpSessionId: bound.value,
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
  };

  let listed = (opts.sessions ?? ["acp-source", "acp-other"]).map(summary);
  const manager = {
    listSessions: async () => listed,
    getHistoryPath: () => "/tmp/history.jsonl",
    deleteSession: async () => {},
    cloneSession: async () => {},
  };
  const profile = { id: "claude", displayName: "Claude", sessionManager: manager };

  const invalidated: Array<{ id: string; opts: unknown }> = [];
  const router = {
    listProfiles: () => [profile],
    describeConfig: () => ({}),
    getProfile: () => profile,
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
    upsert: () => {},
    recordDelegation: () => {},
    updateDelegationStatus: () => {},
  };

  /** Every payload the operator would actually see, in order. */
  const renders: any[] = [];
  const threadMessages: string[] = [];
  const tokenDead = { value: false };
  const record0 = (payload: unknown) => {
    if (tokenDead.value) throw new Error("Unknown Webhook");
    renders.push(payload);
  };
  const collector = new FakeCollector(record0);
  const msg = { createMessageComponentCollector: () => collector };

  const interaction = {
    channelId: "thread-1",
    channel: null,
    user: { id: "op" },
    deferReply: async () => {},
    editReply: async (payload: any) => {
      record0(payload);
      return msg;
    },
    deleteReply: async () => {},
    options: { getSubcommand: () => "sessions" },
  };

  const adapter = {
    sendMessage: async (_c: unknown, text: string) => {
      threadMessages.push(text);
      return { channel: _c, id: "m1" };
    },
  };

  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: "/tmp/none",
      REPOS_ROOT: "/repo",
      DEFAULT_MODEL: "default",
      CLAUDE_COMPACTION_MODEL: "claude-opus-4.8",
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

  // The compaction pipeline itself is the one thing we hold open, so every
  // "the collector expired mid-run" case is an explicit resolve, not a sleep.
  const job = deferred<any>();
  const compactCalls: any[] = [];
  (orch as any).compactThread = async (rec: SessionRecord, o: any) => {
    compactCalls.push({ rec, opts: o });
    return job.promise;
  };
  // The plain (non-premium) sibling builds its seed inline.
  const seedCalls: any[] = [];
  (orch as any).buildDefaultCompactionSeed = async () => job.promise;
  // The other long jobs that live on this same card and had the same defect.
  (orch as any).rebuildSessionFromThread = async () => job.promise;
  (orch as any).seedNewSession = async (a: any) => {
    seedCalls.push(a);
    return "acp-new";
  };

  /** Resolve the premium pipeline with a normal success. */
  const finishPremium = async (over: Partial<Record<string, unknown>> = {}) => {
    const newId = (over.newSessionId as string) ?? "acp-new";
    const attachment = await (orch as any).attachCompactedSession({
      record,
      sourceId: "acp-source",
      newId,
      observedAtStart: record.acpSessionId,
      intent: "attach",
    });
    listed = [...listed, summary(newId)];
    job.resolve({
      newSessionId: newId,
      originalSessionId: "acp-source",
      wasActive: attachment.attached && attachment.reason === "swapped",
      attachment,
      reportMarkdown: "# report",
      stats: { chunks: 3 },
      ...over,
    });
    await flush();
    return attachment;
  };

  const open = async () => {
    await (orch as any).cmdSessions(interaction);
    if (opts.killTokenAfterOpen) tokenDead.value = true;
  };

  return {
    orch,
    open,
    collector,
    renders,
    threadMessages,
    invalidated,
    casCalls,
    bound,
    record,
    job,
    compactCalls,
    seedCalls,
    finishPremium,
    last: () => renders[renders.length - 1],
    addSession: (id: string) => void (listed = [...listed, summary(id)]),
  };
}

/** Flatten every embed description in a render payload. */
function text(payload: any): string {
  return (payload?.embeds ?? [])
    .map((e: any) => `${e?.data?.title ?? ""}\n${e?.data?.description ?? ""}`)
    .join("\n") + `\n${payload?.content ?? ""}`;
}

const PREMIUM_BUTTONS = ["sessions:premium", "sessions:premium_discord"] as const;

// ---------------------------------------------------------------------------
// A. Attachment — decided at completion, from authoritative state
// ---------------------------------------------------------------------------

describe("#179 premium compaction attaches its result", () => {
  it.each(PREMIUM_BUTTONS)("%s: an ACTIVE source session is swapped to the new one", async (id) => {
    const h = makeHarness({ bound: "acp-source" });
    await h.open();
    await h.collector.click(id);
    await flush();

    const attachment = await h.finishPremium();
    expect(attachment).toEqual({ attached: true, reason: "swapped" });
    expect(h.casCalls).toEqual([{ expected: "acp-source", next: "acp-new", ok: true }]);
    expect(h.bound.value).toBe("acp-new");
    expect(text(h.last())).toContain("now bound to");
  });

  it.each(PREMIUM_BUTTONS)(
    "%s: an UNBOUND thread (post agent switch) is attached, not left disconnected",
    async (id) => {
      // The exact reported flow: the thread switched agents, which cleared its
      // ACP binding, and the operator compacted a session picked from the list.
      const h = makeHarness({ bound: "" });
      await h.open();
      await h.collector.click(id);
      await flush();

      const attachment = await h.finishPremium();
      expect(attachment).toEqual({ attached: true, reason: "bound-unbound" });
      expect(h.bound.value).toBe("acp-new");
      expect(h.invalidated).toHaveLength(1);
      // And the card SAYS so — the silent-unattached state is the bug.
      expect(text(h.last())).toContain("had no active session");
    }
  );

  it.each(PREMIUM_BUTTONS)(
    "%s: a deliberate rebinding during the run is preserved, and said out loud",
    async (id) => {
      const h = makeHarness({ bound: "acp-source" });
      await h.open();
      await h.collector.click(id);
      await flush();

      // The operator attached something else while the pipeline ran.
      h.bound.value = "acp-chosen-during-run";

      const attachment = await h.finishPremium();
      expect(attachment).toEqual({ attached: false, reason: "rebound-elsewhere" });
      expect(h.casCalls).toHaveLength(0); // no write was even attempted
      expect(h.bound.value).toBe("acp-chosen-during-run");
      expect(text(h.last())).toContain("Left unattached");
    }
  );

  it("re-reads the binding for EVERY render, not just after its own compaction", async () => {
    // The browser holds one `record` for its whole ten-minute life. A binding
    // moved by any other surface — an attach from a second card, an agent
    // switch, a `compact` dispatch — must still show up, so the list cannot be
    // rendered from the captured snapshot.
    const h = makeHarness({ bound: "acp-source" });
    await h.open();
    expect(text(h.last())).toContain("Active Session in this channel");

    h.bound.value = "acp-other"; // changed elsewhere; no compaction involved
    await h.collector.click("sessions:next");
    await flush();

    const shown = text(h.last());
    expect(shown).toContain("acp-other");
    expect(shown).toContain("Active Session in this channel");
  });

  it("the browser then marks the ACTUALLY persisted session active, not its snapshot", async () => {
    const h = makeHarness({ bound: "acp-source" });
    await h.open();
    await h.collector.click("sessions:premium");
    await flush();
    await h.finishPremium();

    // Back rebuilds the list; the just-created session must render as active.
    expect(await h.collector.click("sessions:summary_back")).toBe(true);
    await flush();
    const rebuilt = text(h.last());
    expect(rebuilt).toContain("acp-new");
    expect(rebuilt).toContain("Active Session in this channel");
  });

  it("premium_discord runs the Discord-history pipeline with attach authority", async () => {
    const h = makeHarness();
    await h.open();
    await h.collector.click("sessions:premium_discord");
    await flush();
    expect(h.compactCalls[0].opts).toMatchObject({
      source: "discord",
      sessionId: "acp-source",
      attachIntent: "attach",
    });

    const h2 = makeHarness();
    await h2.open();
    await h2.collector.click("sessions:premium");
    await flush();
    expect(h2.compactCalls[0].opts.source).toBeUndefined();
    expect(h2.compactCalls[0].opts.attachIntent).toBe("attach");
  });
});

// ---------------------------------------------------------------------------
// B. Card lifecycle — a settled card never regains controls
// ---------------------------------------------------------------------------

describe("#179 a late completion never resurrects the Back button", () => {
  it.each(PREMIUM_BUTTONS)(
    "%s: a run that outlives the 10-minute collector settles component-free",
    async (id) => {
      const h = makeHarness();
      await h.open();
      await h.collector.click(id);
      await flush();

      // 10 minutes pass: discord.js ends the collector, the lifecycle expires
      // the card and strips its controls.
      h.collector.stop("time");
      await flush();
      expect(hasEnabledComponents(h.last().components)).toBe(false);

      // …and only now does the pipeline finish.
      await h.finishPremium();

      const final = h.last();
      // The result is still delivered — the operator paid for it…
      expect(text(final)).toContain("acp-new");
      // …but with nothing clickable, and a note saying where the buttons went.
      expect(hasEnabledComponents(final.components)).toBe(false);
      expect(final.content).toContain("run `/seam info sessions` again");
      // The button it used to repaint cannot be reached at all.
      expect(JSON.stringify(final.components ?? [])).not.toContain("sessions:summary_back");
      expect(await h.collector.click("sessions:summary_back")).toBe(false);
    }
  );

  it.each(PREMIUM_BUTTONS)("%s: a LIVE card keeps a Back button that actually works", async (id) => {
    const h = makeHarness();
    await h.open();
    await h.collector.click(id);
    await flush();
    await h.finishPremium();

    // The positive control for the case above: while the collector is alive the
    // completion card is *supposed* to carry Back.
    expect(hasEnabledComponents(h.last().components)).toBe(true);
    expect(JSON.stringify(h.last().components)).toContain("sessions:summary_back");
    expect(h.collector.stopped).toBeNull();
    expect(await h.collector.click("sessions:summary_back")).toBe(true);
  });

  it.each(PREMIUM_BUTTONS)("%s: a FAILED run obeys the same rule", async (id) => {
    const h = makeHarness();
    await h.open();
    await h.collector.click(id);
    await flush();
    h.collector.stop("time");
    await flush();

    h.job.reject(new Error("pipeline exploded"));
    await flush();

    const final = h.last();
    expect(text(final)).toContain("pipeline exploded");
    expect(hasEnabledComponents(final.components)).toBe(false);
  });

  it("a failure on a LIVE card still offers Back", async () => {
    const h = makeHarness();
    await h.open();
    await h.collector.click("sessions:premium");
    await flush();
    h.job.reject(new Error("pipeline exploded"));
    await flush();

    expect(text(h.last())).toContain("pipeline exploded");
    expect(hasEnabledComponents(h.last().components)).toBe(true);
  });

  it("progress frames stop once the card has expired (the lifecycle refuses them)", async () => {
    const h = makeHarness();
    await h.open();
    await h.collector.click("sessions:premium");
    await flush();
    h.collector.stop("time");
    await flush();

    const afterExpiry = h.renders.length;
    // The pipeline is still emitting progress; none of it may repaint the
    // expired card, or the "this timed out" notice silently becomes a live-
    // looking progress frame again.
    const onProgress = h.compactCalls[0].opts.onProgress as (m: string) => void;
    for (let n = 0; n < 5; n++) onProgress(`step ${n}`);
    await flush();
    expect(h.renders.length).toBe(afterExpiry);
  });

  it("falls back to a thread message when the interaction token is dead too", async () => {
    // Discord expires an interaction token at 15 minutes, independently of the
    // collector. Every edit throws; the answer must not be lost with the card.
    const h = makeHarness({ killTokenAfterOpen: true });
    await h.open();
    await h.collector.click("sessions:premium");
    await flush();
    await h.finishPremium();

    expect(h.threadMessages).toHaveLength(1);
    expect(h.threadMessages[0]).toContain("acp-new");
    expect(h.threadMessages[0]).toContain("bound to");
  });
});

// ---------------------------------------------------------------------------
// C. The non-premium sibling gets the same contract
// ---------------------------------------------------------------------------

describe("#179 the plain sessions:compact button", () => {
  it("attaches an unbound thread and states the outcome", async () => {
    const h = makeHarness({ bound: "" });
    await h.open();
    await h.collector.click("sessions:compact");
    await flush();

    h.addSession("acp-new");
    h.job.resolve({ seed: "SEED", keptTurns: 3, summarizedTurns: 7, pinnedCount: 2 });
    await flush();

    expect(h.seedCalls).toHaveLength(1);
    expect(h.bound.value).toBe("acp-new");
    expect(text(h.last())).toContain("had no active session");
    expect(hasEnabledComponents(h.last().components)).toBe(true);
  });

  it("never repaints controls onto an expired card", async () => {
    const h = makeHarness();
    await h.open();
    await h.collector.click("sessions:compact");
    await flush();
    h.collector.stop("time");
    await flush();

    h.addSession("acp-new");
    h.job.resolve({ seed: "SEED", keptTurns: 1, summarizedTurns: 1, pinnedCount: 0 });
    await flush();

    expect(text(h.last())).toContain("acp-new");
    expect(hasEnabledComponents(h.last().components)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C2. The other long jobs on the same card
// ---------------------------------------------------------------------------

describe("#179 sessions:rebuild obeys the same lifecycle rule", () => {
  it("a rebuild that outlives the collector settles component-free", async () => {
    const h = makeHarness();
    await h.open();
    await h.collector.click("sessions:rebuild");
    await flush();

    h.collector.stop("time");
    await flush();

    h.job.resolve({ newSessionId: "acp-rebuilt", summary: "rebuilt summary" });
    await flush();

    const final = h.last();
    expect(text(final)).toContain("acp-rebuilt");
    // The old code repainted a Close button here, with no collector behind it.
    expect(hasEnabledComponents(final.components)).toBe(false);
    expect(JSON.stringify(final.components ?? [])).not.toContain("sessions:close");
  });

  it("a LIVE rebuild still gets its Close button (positive control)", async () => {
    const h = makeHarness();
    await h.open();
    await h.collector.click("sessions:rebuild");
    await flush();
    h.job.resolve({ newSessionId: "acp-rebuilt", summary: "rebuilt summary" });
    await flush();

    expect(hasEnabledComponents(h.last().components)).toBe(true);
    expect(JSON.stringify(h.last().components)).toContain("sessions:close");
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

  it("never steals a binding that points somewhere else", () => {
    // Changed during the run…
    expect(planSessionAttachment({ ...base, current: "acp-other" })).toEqual({
      action: "skip",
      attached: false,
      reason: "rebound-elsewhere",
    });
    // …and unchanged, but never ours to begin with.
    expect(
      planSessionAttachment({ ...base, current: "acp-other", observedAtStart: "acp-other" })
    ).toEqual({ action: "skip", attached: false, reason: "source-inactive" });
  });

  it("is idempotent on the seeded session and inert on a deleted record", () => {
    expect(planSessionAttachment({ ...base, current: "acp-new" })).toEqual({
      action: "noop",
      attached: true,
      reason: "already-attached",
    });
    expect(planSessionAttachment({ ...base, current: null })).toEqual({
      action: "skip",
      attached: false,
      reason: "record-gone",
    });
  });

  it("treats a mid-run attach OF THE SOURCE as the swap it asked for", () => {
    // Start unbound, operator attaches the source session, compaction lands:
    // moving that session onto its own compaction is exactly the intent.
    expect(
      planSessionAttachment({ ...base, current: "acp-source", observedAtStart: "" })
    ).toEqual({ action: "cas", expect: "acp-source", next: "acp-new", reason: "swapped" });
  });

  it("names every outcome for the operator, including the unattached ones", () => {
    const ids = { newId: "acp-new", sourceId: "acp-source" };
    const reasons = [
      { attached: true, reason: "swapped" },
      { attached: true, reason: "bound-unbound" },
      { attached: true, reason: "already-attached" },
      { attached: false, reason: "rebound-elsewhere" },
      { attached: false, reason: "source-inactive" },
      { attached: false, reason: "record-gone" },
    ] as const;
    for (const outcome of reasons) {
      const line = describeAttachOutcome(outcome as never, ids);
      expect(line.length).toBeGreaterThan(0);
      // An unattached result must SAY it is unattached, never just omit the
      // "now bound to it" clause the way the old copy did.
      if (!outcome.attached) expect(line).toContain("Left unattached");
    }
  });
});

// ---------------------------------------------------------------------------
// E. Source invariants — the shape of the fix, not just this instance of it
// ---------------------------------------------------------------------------

describe("#179 source invariants", () => {
  const ORCHESTRATOR = new URL(
    "../packages/core/src/platforms/discord/orchestrator.ts",
    import.meta.url
  );

  it("no compaction branch writes the card outside the lifecycle", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(ORCHESTRATOR, "utf8")
    );
    const start = src.indexOf('customId === "sessions:compact"');
    const end = src.indexOf('customId === "sessions:import_to_cwd"');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    // The regression was literally this call shape. It must not come back.
    expect(block).not.toMatch(/btnInteraction\.editReply\(/);
    expect(block).toContain("runBrowserCompaction");
  });

  it("EVERY fire-and-forget job in the browser settles through the lifecycle", async () => {
    // The generalisation of the reported bug. `sessions:premium` was only the
    // one that got noticed: rebuild, AI summary, migrate-failure and the import
    // modal all launched an unawaited job on this same card and then wrote its
    // result with a raw `editReply(...components)`. Any of them can outlive the
    // 10-minute collector, and each would then repaint a control nothing can
    // answer. Scanning for the SHAPE is what stops it coming back one branch at
    // a time.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(ORCHESTRATOR, "utf8")
    );
    const start = src.indexOf("private async cmdSessions");
    const end = src.indexOf("private async cmdTools");
    const body = src.slice(start, end);

    const blocks: string[] = [];
    const opener = /void \(async \(\) => \{/g;
    for (let m = opener.exec(body); m; m = opener.exec(body)) {
      let depth = 0;
      let close = m.end - 1;
      for (let j = m.index + m[0].length - 1; j < body.length; j++) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}" && --depth === 0) {
          close = j;
          break;
        }
      }
      blocks.push(body.slice(m.index, close + 1));
    }

    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const block of blocks) {
      const label = block.slice(0, 120);
      expect(block, `unlifecycled long job: ${label}`).toContain("settleLongJobCard");
      // The exact call shape the regression was made of.
      expect(block.match(/btnInteraction\.editReply\(/g) ?? [], label).toHaveLength(0);
      expect(block.match(/submission\.editReply\(/g) ?? [], label).toHaveLength(0);
    }
  });

  it("the browser never renders from a stale captured binding", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(ORCHESTRATOR, "utf8")
    );
    const start = src.indexOf("private async cmdSessions");
    const end = src.indexOf("private async cmdTools");
    const block = src.slice(start, end);
    expect(block).toContain("const activeSessionId = ()");
    // Every list render asks the store, not the ten-minute-old snapshot.
    expect(block).not.toMatch(/makeSessionMessageOptions\([^)]*record\.acpSessionId/);
  });
});

// A guard against the harness quietly stopping to exercise the real handler.
describe("#179 harness fidelity", () => {
  it("drives the real collector handler and the real lifecycle", async () => {
    const h = makeHarness();
    await h.open();
    expect(h.renders.length).toBeGreaterThan(0);
    expect(hasEnabledComponents(h.renders[0].components)).toBe(true);
    const spy = vi.fn();
    h.collector.on("end", spy as never);
    h.collector.stop("time");
    expect(spy).toHaveBeenCalled();
  });
});
