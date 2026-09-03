import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import {
  DISCORD_EMBED_LIMITS,
  clampPanelForDiscord,
} from "../packages/core/src/core/panel-limits.js";
import {
  EXCERPT_ELLIPSIS,
  graphemeLength,
  promptExcerpt,
} from "../packages/core/src/core/prompt-excerpt.js";
import {
  dispatchOriginRefs,
  parseDispatchSpec,
  type DispatchSpec,
} from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type {
  PanelOrigin,
  SessionRecord,
  StatusPanel,
  StructuredPanel,
} from "../packages/core/src/core/types.js";
import type { ChannelRef, MessageRef } from "../packages/core/src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const field = (panel: StructuredPanel, name: string) =>
  panel.fields.find((f) => f.name === name);

// ---------------------------------------------------------------------------
// Rendering: provenance on the status card (#153)
// ---------------------------------------------------------------------------

function statusState(over: Partial<StatusPanel> = {}): StatusPanel {
  return {
    state: "Working",
    repoDisplay: "seam-acp",
    model: "opus",
    action: "Thinking…",
    elapsedSeconds: 3,
    ...over,
  };
}

describe("status card: origin fields (#153)", () => {
  it("renders From (thread · #channel) and a full-width Prompt", () => {
    const origin: PanelOrigin = {
      promptExcerpt: "audit the dispatch ledger for orphaned rows",
      threadName: "🧠 opus · orchestrator 1",
      channelName: "seam-dev",
    };
    const panel = discordRenderer.statusPanel(
      statusState({ titlePrefix: "📨 Handoff", origin })
    );
    expect(field(panel, "From")?.value).toBe("🧠 opus · orchestrator 1 · #seam-dev");
    expect(field(panel, "From")?.inline).toBe(true);
    expect(field(panel, "Prompt")?.value).toBe(
      "audit the dispatch ledger for orphaned rows"
    );
    // Full width, so a long excerpt does not squeeze the grid.
    expect(field(panel, "Prompt")?.inline).toBe(false);
  });

  it("omits the channel from From when it was dropped as same-channel noise", () => {
    const panel = discordRenderer.statusPanel(
      statusState({
        titlePrefix: "🔁 Report-back",
        origin: { promptExcerpt: "ship it", threadName: "🚾1️⃣ worker" },
      })
    );
    expect(field(panel, "From")?.value).toBe("🚾1️⃣ worker");
    expect(field(panel, "From")?.value).not.toContain("#");
  });

  it("omits From entirely when only the prompt survived (same-thread work)", () => {
    const panel = discordRenderer.statusPanel(
      statusState({ titlePrefix: "📨 Handoff", origin: { promptExcerpt: "ship it" } })
    );
    expect(field(panel, "From")).toBeUndefined();
    expect(field(panel, "Prompt")?.value).toBe("ship it");
  });

  it("adds nothing to a normal user turn (no origin)", () => {
    const panel = discordRenderer.statusPanel(statusState());
    expect(panel.fields.map((f) => f.name)).toEqual(["Repo", "Action"]);
  });

  it("puts provenance in the description on a simple card, which has no grid", () => {
    const panel = discordRenderer.statusPanel(
      statusState({
        style: "simple",
        titlePrefix: "📨 Handoff",
        origin: {
          promptExcerpt: "rebuild the thread name from its role",
          threadName: "🧠 opus · qa 2",
          channelName: "seam-dev",
        },
      })
    );
    expect(panel.fields).toEqual([]);
    expect(panel.description).toBe(
      "💬 rebuild the thread name from its role\n↩ 🧠 opus · qa 2 · #seam-dev"
    );
  });

  it("keeps the simple card compact by re-excerpting to a tighter budget", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const panel = discordRenderer.statusPanel(
      statusState({ style: "simple", titlePrefix: "📨 Handoff", origin: { promptExcerpt: long } })
    );
    expect(panel.description!.endsWith(EXCERPT_ELLIPSIS)).toBe(true);
    expect(graphemeLength(panel.description!)).toBeLessThan(200);
  });

  it("leaves a simple card without origin exactly as before", () => {
    const panel = discordRenderer.statusPanel(statusState({ style: "simple" }));
    expect(panel.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Discord embed limits — per-field AND aggregate
// ---------------------------------------------------------------------------

describe("clampPanelForDiscord", () => {
  it("leaves an in-budget panel structurally unchanged", () => {
    const panel: StructuredPanel = {
      color: 1,
      title: "📨 Handoff · Working",
      description: "tags",
      fields: [{ name: "Prompt", value: "short", inline: false }],
      footer: "⏱ 3s",
    };
    expect(clampPanelForDiscord(panel)).toEqual(panel);
  });

  it("clamps a field value to the 1024 cap without splitting an emoji", () => {
    const out = clampPanelForDiscord({
      color: 1,
      fields: [{ name: "Prompt", value: "👨‍👩‍👧".repeat(2000), inline: false }],
    });
    const value = out.fields[0]!.value;
    expect(graphemeLength(value)).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.fieldValue);
    expect(value.endsWith(EXCERPT_ELLIPSIS)).toBe(true);
    const body = value.slice(0, -1);
    expect(body).toBe("👨‍👩‍👧".repeat(body.length / "👨‍👩‍👧".length));
  });

  it("drops fields past Discord's 25-field ceiling", () => {
    const out = clampPanelForDiscord({
      color: 1,
      fields: Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: "v" })),
    });
    expect(out.fields).toHaveLength(DISCORD_EMBED_LIMITS.fieldCount);
  });

  it("enforces the 6000 aggregate, sacrificing the description before provenance", () => {
    const out = clampPanelForDiscord({
      color: 1,
      title: "t",
      description: "d".repeat(4000),
      fields: [
        { name: "From", value: "🧠 opus · orchestrator 1 · #seam-dev", inline: true },
        { name: "Prompt", value: "p".repeat(1000), inline: false },
        { name: "Other", value: "o".repeat(1000), inline: false },
      ],
      footer: "f".repeat(500),
    });
    expect(weight(out)).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.total);
    // The description went first; the small provenance field survived intact.
    expect(graphemeLength(out.description ?? "")).toBeLessThan(4000);
    expect(field(out, "From")?.value).toBe("🧠 opus · orchestrator 1 · #seam-dev");
  });

  it("shrinks the longest field values when the fields alone blow the budget", () => {
    const out = clampPanelForDiscord({
      color: 1,
      fields: Array.from({ length: 10 }, (_, i) => ({
        name: `f${i}`,
        value: "x".repeat(1024),
      })),
    });
    expect(weight(out)).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.total);
    expect(out.fields.length).toBeGreaterThan(0);
  });
});

function weight(p: StructuredPanel): number {
  return (
    graphemeLength(p.title ?? "") +
    graphemeLength(p.author ?? "") +
    graphemeLength(p.description ?? "") +
    graphemeLength(p.footer ?? "") +
    p.fields.reduce((n, f) => n + graphemeLength(f.name) + graphemeLength(f.value), 0)
  );
}

// ---------------------------------------------------------------------------
// Which prompt / which thread a card should name (pure precedence)
// ---------------------------------------------------------------------------

describe("dispatchOriginRefs", () => {
  const base: DispatchSpec = {
    id: "d1",
    target: "thread-w",
    prompt: "the dispatched prompt",
    session: "live",
    createdUtc: "2026-01-01T00:00:00Z",
  };

  it("a handoff's origin is its returnTo, and its own prompt is the ask", () => {
    expect(dispatchOriginRefs({ ...base, kind: "handoff", returnTo: "thread-o" })).toEqual({
      threadRef: "thread-o",
      prompt: "the dispatched prompt",
    });
  });

  it("an explicit originThreadRef / originPrompt wins (the report-back case)", () => {
    expect(
      dispatchOriginRefs({
        ...base,
        kind: "report_back",
        originThreadRef: "thread-w",
        originPrompt: "the ORIGINAL ask",
      })
    ).toEqual({ threadRef: "thread-w", prompt: "the ORIGINAL ask" });
  });

  it("a spec with neither has no source thread to name", () => {
    expect(dispatchOriginRefs(base)).toEqual({ prompt: "the dispatched prompt" });
  });

  it("survives a round-trip through the on-disk spec schema", () => {
    const raw = JSON.stringify({
      target: "thread-o",
      prompt: "wrapped worker output",
      session: "live",
      kind: "report_back",
      originThreadRef: "thread-w",
      originPrompt: "the ORIGINAL ask",
    });
    const parsed = parseDispatchSpec("d9", raw);
    expect(parsed.originThreadRef).toBe("thread-w");
    expect(parsed.originPrompt).toBe("the ORIGINAL ask");
  });
});

// ---------------------------------------------------------------------------
// Dispatch integration: the card the worker's thread actually gets
// ---------------------------------------------------------------------------

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-w",
  platform: "discord",
  channelRef: "thread-w",
  parentRef: "channel-a",
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-01-01T00:00:00Z",
  updatedUtc: "2026-01-01T00:00:00Z",
  ...over,
});

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

function spyAdapter(names: {
  threads?: Record<string, string>;
  channels?: Record<string, string>;
} = {}) {
  const calls = {
    sendPanel: [] as Array<{ channel: ChannelRef; panel: StructuredPanel }>,
    editPanel: [] as Array<{ ref: MessageRef; panel: StructuredPanel }>,
    sendMessage: [] as Array<{ channel: ChannelRef; text: string }>,
  };
  const adapter = {
    async sendPanel(channel: ChannelRef, panel: StructuredPanel): Promise<MessageRef> {
      calls.sendPanel.push({ channel, panel });
      return { channel, id: `msg-${calls.sendPanel.length}` };
    },
    async editPanel(ref: MessageRef, panel: StructuredPanel): Promise<void> {
      calls.editPanel.push({ ref, panel });
    },
    async sendMessage(channel: ChannelRef, text: string): Promise<MessageRef> {
      calls.sendMessage.push({ channel, text });
      return { channel, id: `msg-txt-${calls.sendMessage.length}` };
    },
    async editMessage(): Promise<void> {},
    async getThreadName(channel: ChannelRef): Promise<string | undefined> {
      return names.threads?.[channel.id];
    },
    async getChannelName(channelId: string): Promise<string | undefined> {
      return names.channels?.[channelId];
    },
  };
  return { adapter, calls };
}

/** thread id → the channel it lives in, for the store stub. */
const PARENTS: Record<string, string> = {
  "thread-w": "channel-a",
  "thread-o": "channel-a",
  "thread-far": "channel-b",
};

function makeOrch(opts: {
  dataDir: string;
  adapter: ReturnType<typeof spyAdapter>["adapter"];
  parked?: { rows: unknown[] };
  chainPrompt?: string;
}): Orchestrator {
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    ensureSessionRecord: ({ channelRef }: { channelRef: string }) =>
      record({
        id: `discord:${channelRef}`,
        channelRef,
        parentRef: PARENTS[channelRef] ?? null,
      }),
    getProfile: () => undefined,
    getOrStartRuntime: async () => fakeRuntime(),
    abortTurn: async () => "cancelled",
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
    tryRecordReportBack: (e: unknown) => e,
    readConfig: () => ({ model: "opus", reasoningEffort: "high" }),
    getByChannel: (_p: string, id: string) =>
      record({ id: `discord:${id}`, channelRef: id, parentRef: PARENTS[id] ?? null }),
    getParkedByChannel: () => null,
    deleteParked: () => {},
    upsertParked: (row: unknown) => opts.parked?.rows.push(row),
    getChain: () =>
      opts.chainPrompt ? { promptPreview: opts.chainPrompt, status: "running" } : null,
  };
  const config = {
    DATA_DIR: opts.dataDir,
    REPOS_ROOT: "/repo",
    TURN_TIMEOUT_SECONDS: 60,
    DEFAULT_MODEL: "default",
    SEAM_DISPATCH_OUTPUT_STYLE: "messages",
    SEAM_DISPATCH_STATUS_PANEL: true,
    REPO_EMOJIS: new Map<string, string>(),
    DISCORD_USER_NAMES: new Map<string, string>(),
    channelPresets: {},
    threadPresets: {},
  };
  return new Orchestrator({
    logger: silent,
    config: config as never,
    adapter: opts.adapter as never,
    router: router as never,
    store: store as never,
    renderer: discordRenderer as never,
  });
}

function baseSpec(over: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    id: "disp-1",
    target: "thread-w",
    prompt: "audit the dispatch ledger for orphaned rows and report what you find",
    session: "live",
    kind: "handoff",
    correlationId: "corr-1",
    createdUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-card-obs-"));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("handoff card (#153)", () => {
  it("shows the prompt excerpt and names the originating thread", async () => {
    const { adapter, calls } = spyAdapter({
      threads: { "thread-o": "🧠 opus · orchestrator 1" },
    });
    const orch = makeOrch({ dataDir, adapter });
    await orch.dispatchInjectTurn(baseSpec({ returnTo: "thread-o" }));

    const panel = calls.sendPanel[0]!.panel;
    expect(panel.title).toContain("📨 Handoff");
    expect(field(panel, "From")?.value).toBe("🧠 opus · orchestrator 1");
    expect(field(panel, "Prompt")?.value).toBe(
      "audit the dispatch ledger for orphaned rows and report what you find"
    );
  });

  it("omits the channel line for same-channel work", async () => {
    const { adapter, calls } = spyAdapter({
      threads: { "thread-o": "orchestrator" },
      channels: { "channel-a": "seam-dev" },
    });
    const orch = makeOrch({ dataDir, adapter });
    // thread-o and thread-w both live in channel-a.
    await orch.dispatchInjectTurn(baseSpec({ returnTo: "thread-o" }));
    expect(field(calls.sendPanel[0]!.panel, "From")?.value).toBe("orchestrator");
  });

  it("shows the channel when the work came from a different one", async () => {
    const { adapter, calls } = spyAdapter({
      threads: { "thread-far": "orchestrator" },
      channels: { "channel-b": "ops" },
    });
    const orch = makeOrch({ dataDir, adapter });
    await orch.dispatchInjectTurn(baseSpec({ returnTo: "thread-far" }));
    expect(field(calls.sendPanel[0]!.panel, "From")?.value).toBe("orchestrator · #ops");
  });

  it("names no source thread when the origin IS this thread (isolated worker)", async () => {
    const { adapter, calls } = spyAdapter({ threads: { "thread-w": "worker" } });
    const orch = makeOrch({ dataDir, adapter });
    await orch.dispatchInjectTurn(baseSpec({ returnTo: "thread-w" }));
    const panel = calls.sendPanel[0]!.panel;
    expect(field(panel, "From")).toBeUndefined();
    expect(field(panel, "Prompt")?.value).toContain("audit the dispatch ledger");
  });

  it("truncates a long prompt on a word boundary with an ellipsis", async () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter });
    await orch.dispatchInjectTurn(baseSpec({ prompt: long }));
    const value = field(calls.sendPanel[0]!.panel, "Prompt")!.value;
    expect(value.endsWith(EXCERPT_ELLIPSIS)).toBe(true);
    expect(value.slice(0, -1).split(" ").every((w) => /^word\d+$/.test(w))).toBe(true);
    expect(graphemeLength(value)).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.fieldValue);
  });
});

describe("report-back card (#153)", () => {
  it("carries the worker thread + the ORIGINAL ask onto the queued report-back spec", async () => {
    const { adapter } = spyAdapter({ threads: { "thread-o": "orchestrator" } });
    const orch = makeOrch({ dataDir, adapter });
    await orch.dispatchInjectTurn(baseSpec({ returnTo: "thread-o" }));

    const pending = path.join(dataDir, "dispatch", "pending");
    const files = fs.readdirSync(pending).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const spec = parseDispatchSpec(
      "rb",
      fs.readFileSync(path.join(pending, files[0]!), "utf8")
    );
    expect(spec.kind).toBe("report_back");
    expect(spec.target).toBe("thread-o");
    expect(spec.originThreadRef).toBe("thread-w");
    expect(spec.originPrompt).toBe(
      "audit the dispatch ledger for orphaned rows and report what you find"
    );
    // Its own prompt is the worker's wrapped OUTPUT — the wrong thing to show
    // as "the prompt", which is exactly why originPrompt exists.
    expect(spec.prompt).toContain("<seam-report-back");
  });

  it("excerpts the original ask, not the wrapped output, and names the worker", async () => {
    const { adapter, calls } = spyAdapter({ threads: { "thread-w": "🚾1️⃣ worker" } });
    const orch = makeOrch({ dataDir, adapter });
    await orch.dispatchInjectTurn(
      baseSpec({
        id: "disp-rb",
        target: "thread-o",
        kind: "report_back",
        prompt: "<seam-report-back correlation=\"corr-1\">worker output</seam-report-back>",
        originThreadRef: "thread-w",
        originPrompt: "audit the dispatch ledger for orphaned rows",
      })
    );
    const panel = calls.sendPanel[0]!.panel;
    expect(panel.title).toContain("🔁 Report-back");
    expect(field(panel, "From")?.value).toBe("🚾1️⃣ worker");
    expect(field(panel, "Prompt")?.value).toBe(
      "audit the dispatch ledger for orphaned rows"
    );
    expect(field(panel, "Prompt")?.value).not.toContain("seam-report-back");
  });
});

describe("chain delivery card (#153)", () => {
  it("carries the chain's original ask, since its own prompt is the result", async () => {
    const { adapter } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter, chainPrompt: "draft, review, ship" });
    await (orch as never as {
      enqueueChainDelivery(o: string, c: string, b: string): Promise<void>;
    }).enqueueChainDelivery("thread-o", "chain-1", "the final output");

    const pending = path.join(dataDir, "dispatch", "pending");
    const file = fs.readdirSync(pending).find((f) => f.endsWith(".json"))!;
    const spec = parseDispatchSpec("cd", fs.readFileSync(path.join(pending, file), "utf8"));
    expect(spec.originPrompt).toBe("draft, review, ship");
    // A chain has many hops and no single source thread to name.
    expect(spec.originThreadRef).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Queued-prompt card (#154)
// ---------------------------------------------------------------------------

describe("queued-prompt card (#154)", () => {
  it("shows the queued prompt, so the card identifies itself", async () => {
    const rows: unknown[] = [];
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter, parked: { rows } });
    await (orch as never as {
      parkPrompt(a: Record<string, unknown>): Promise<unknown>;
    }).parkPrompt({
      channel: { platform: "discord", id: "thread-w", parentId: "channel-a" },
      location: "local",
      prompt: "rerun the ledger audit once the bridge is back",
      authorId: "1",
      authorName: "Jesse",
      kind: "user_queue",
      busy: true,
    });

    expect(rows).toHaveLength(1);
    const panel = calls.sendPanel[0]!.panel;
    expect(panel.title).toBe("📥 Parked");
    expect(panel.description).toContain("Queued");
    expect(field(panel, "Prompt")?.value).toBe(
      "rerun the ledger audit once the bridge is back"
    );
  });

  it("keeps the prompt visible when the card is edited to Running / Cancelled", async () => {
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter });
    await (orch as never as {
      editParkedNotice(p: Record<string, unknown>, text: string): Promise<void>;
    }).editParkedNotice(
      {
        id: "p1",
        platform: "discord",
        channelRef: "thread-w",
        parentRef: "channel-a",
        noticeMessageId: "m1",
        prompt: "rerun the ledger audit once the bridge is back",
      },
      "▶️ Running now."
    );
    const panel = calls.editPanel[0]!.panel;
    expect(panel.title).toBe("▶️ Running");
    expect(field(panel, "Prompt")?.value).toBe(
      "rerun the ledger audit once the bridge is back"
    );
  });
});

// ---------------------------------------------------------------------------
// Slash steer card (#155)
// ---------------------------------------------------------------------------

function steerInteraction(opts: {
  now: boolean;
  prompt: string;
  thread?: string;
  channelId?: string;
  parentId?: string;
}) {
  const editReply = vi.fn(async () => {});
  return {
    i: {
      options: {
        getString: (name: string) =>
          name === "thread" ? (opts.thread ?? null) : opts.prompt,
        getBoolean: (name: string) => (name === "now" ? opts.now : null),
      },
      channelId: opts.channelId ?? "thread-o",
      channel: { parentId: opts.parentId ?? "channel-a" },
      deferReply: vi.fn(async () => {}),
      editReply,
      reply: vi.fn(async () => {}),
      user: { id: "1", username: "jbulpitt", globalName: "Jesse" },
      member: null,
    },
    editReply,
  };
}

describe("slash steer card (#155)", () => {
  it("posts a durable card with the steer text on the cooperative (inbox) path", async () => {
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter });
    (orch as never as { pushHumanInbox: unknown }).pushHumanInbox = () => ({ queued: 1 });

    const { i } = steerInteraction({
      now: false,
      prompt: "stop touching the renderer; finish the store migration first",
      thread: "thread-w",
    });
    await (orch as never as { cmdSteer(i: unknown): Promise<void> }).cmdSteer(i);

    const card = calls.sendPanel.at(-1)!;
    expect(card.channel.id).toBe("thread-w");
    expect(card.panel.title).toBe("🧭 Steer · queued to inbox");
    expect(field(card.panel, "Steer")?.value).toBe(
      "stop touching the renderer; finish the store migration first"
    );
    // Attributed, and the steer came from another thread in the SAME channel,
    // so the channel label is dropped as noise.
    expect(field(card.panel, "From")?.value).toBe("Jesse");
  });

  it("posts the card before the steered turn runs, on the preemptive path", async () => {
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter });
    const seenBeforeTurn: number[] = [];
    (orch as never as Record<string, unknown>).queueOnChannel = (
      _id: string,
      task: () => Promise<unknown>
    ) => {
      seenBeforeTurn.push(calls.sendPanel.length);
      return task();
    };
    (orch as never as Record<string, unknown>).injectTurn = async () => ({ text: "ok" });
    (orch as never as Record<string, unknown>).postSteerOutput = async () => {};

    const { i } = steerInteraction({
      now: true,
      prompt: "abandon that approach and use the SerialQueue",
      thread: "thread-w",
    });
    await (orch as never as { cmdSteer(i: unknown): Promise<void> }).cmdSteer(i);

    expect(seenBeforeTurn[0]).toBe(1); // the card was already up
    const card = calls.sendPanel[0]!;
    expect(card.panel.title).toBe("🧭 Steer · cancel & reprompt");
    expect(card.panel.description).toContain("Cancelled the running turn");
    expect(field(card.panel, "Steer")?.value).toBe(
      "abandon that approach and use the SerialQueue"
    );
  });

  it("names the source channel when steering across channels", async () => {
    const { adapter, calls } = spyAdapter({
      threads: { "thread-far": "ops console" },
      channels: { "channel-b": "ops" },
    });
    const orch = makeOrch({ dataDir, adapter });
    (orch as never as { pushHumanInbox: unknown }).pushHumanInbox = () => ({ queued: 1 });

    const { i } = steerInteraction({
      now: false,
      prompt: "pause the migration",
      thread: "thread-w",
      channelId: "thread-far",
      parentId: "channel-b",
    });
    await (orch as never as { cmdSteer(i: unknown): Promise<void> }).cmdSteer(i);

    expect(field(calls.sendPanel.at(-1)!.panel, "From")?.value).toBe(
      "Jesse · ops console · #ops"
    );
  });

  it("truncates a very long steer with the shared convention", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `step${i}`).join(" ");
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter });
    (orch as never as { pushHumanInbox: unknown }).pushHumanInbox = () => ({ queued: 1 });

    const { i } = steerInteraction({ now: false, prompt: long, thread: "thread-w" });
    await (orch as never as { cmdSteer(i: unknown): Promise<void> }).cmdSteer(i);

    const value = field(calls.sendPanel.at(-1)!.panel, "Steer")!.value;
    expect(value).toBe(promptExcerpt(long));
    expect(value.endsWith(EXCERPT_ELLIPSIS)).toBe(true);
  });
});
