import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../src/platforms/discord/orchestrator.js";
import { DispatchStatusPanel } from "../src/core/dispatch-status-panel.js";
import { TurnStatus, formatContextUsage } from "../src/core/status-panel.js";
import { discordRenderer } from "../src/platforms/discord/renderer.js";
import { serializePanelText } from "../src/platforms/renderer.js";
import type { DispatchSpec } from "../src/core/dispatch/types.js";
import type { Logger } from "../src/lib/logger.js";
import type { SessionRecord, StructuredPanel } from "../src/core/types.js";
import type { ChannelRef, MessageRef } from "../src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

// ---------------------------------------------------------------------------
// Unit: the DispatchStatusPanel controller drives a TurnStatus from onEvent
// with the SAME mapping the user-turn path uses, and renders a titled panel.
// ---------------------------------------------------------------------------

function makeUnitPanel(titlePrefix = "📨 Handoff") {
  // The controller now ships REAL StructuredPanel embed cards (never plain text),
  // exactly like the user-turn path — so the IO receives panel objects.
  const edits: StructuredPanel[] = [];
  let posted: StructuredPanel | undefined;
  const status = new TurnStatus({ model: "opus", repoDisplay: "repo", titlePrefix });
  const panel = new DispatchStatusPanel<MessageRef>(
    discordRenderer,
    status,
    {
      post: async (p) => {
        posted = p;
        return { channel: { platform: "discord", id: "t" }, id: "m1" };
      },
      edit: async (_ref, p) => {
        edits.push(p);
      },
    },
    // Debounce 0 → every refresh edits immediately; huge heartbeat so it never
    // fires during the test (and it is unref'd anyway).
    { debounceMs: 0, heartbeatMs: 1_000_000 }
  );
  return { panel, status, edits, getPosted: () => posted };
}

describe("DispatchStatusPanel: drives TurnStatus from onEvent", () => {
  it("maps thinking, tools, usage, and model events onto the turn state", async () => {
    const { panel, status } = makeUnitPanel();
    await panel.start();

    // agent-thought → pushThinkingChunk (promoted on newline).
    panel.handleEvent({ kind: "agent-thought", text: "planning the change\n" });
    expect(status.thinkingWindow()).toContain("planning the change");

    // tool-start → action + activity.
    panel.handleEvent({ kind: "tool-start", toolCallId: "t1", title: "Read file.ts" });
    expect(status.action).toBe("Tool: Read file.ts");
    expect(status.activity).toContain("Read file.ts");

    // usage-update → context-window health line.
    panel.handleEvent({ kind: "usage-update", used: 50_000, size: 200_000 });
    expect(status.context).toBe(formatContextUsage(50_000, 200_000));

    // model-changed → model.
    panel.handleEvent({ kind: "model-changed", modelId: "claude-opus-4-8" });
    expect(status.model).toBe("claude-opus-4-8");

    await panel.finalize("Done", "Completed");
  });

  it("ignores size:0 / used:0 usage blips (no context set from noise)", async () => {
    const { panel, status } = makeUnitPanel();
    await panel.start();
    panel.handleEvent({ kind: "usage-update", used: 0, size: 200_000 });
    panel.handleEvent({ kind: "usage-update", used: 12_345, size: 0 });
    expect(status.context).toBeUndefined();
    await panel.finalize("Done");
  });

  it("posts a panel titled with the dispatch type and finalizes to Done", async () => {
    const { panel, getPosted, edits } = makeUnitPanel("⏰ Wake");
    await panel.start();
    // Initial post carries the dispatch type in the embed title.
    expect(getPosted()?.title).toContain("⏰ Wake");
    await panel.finalize("Done", "Completed");
    const last = edits[edits.length - 1]!;
    expect(last.title).toContain("⏰ Wake");
    expect(last.title).toContain("Done"); // title is "⏰ Wake · Done"
  });

  it("is inert when the initial post fails (best-effort, never throws)", async () => {
    const status = new TurnStatus({ model: "opus", repoDisplay: "repo", titlePrefix: "📨 Handoff" });
    const panel = new DispatchStatusPanel<MessageRef>(
      discordRenderer,
      status,
      { post: async () => undefined, edit: async () => {} },
      { debounceMs: 0 }
    );
    const live = await panel.start();
    expect(live).toBe(false);
    expect(panel.isLive).toBe(false);
    // Events are no-ops; no throw.
    panel.handleEvent({ kind: "agent-thought", text: "x\n" });
    await panel.finalize("Failed", "boom");
  });
});

// ---------------------------------------------------------------------------
// Integration: dispatchInjectTurn with the panel ON (default) vs OFF.
// ---------------------------------------------------------------------------

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
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

/** A fake runtime that emits a scripted mix of events (thinking, tool, usage,
 *  model) plus agent-text through the handler, then returns a clean stop. When
 *  `hang` is set, `prompt` never resolves (to exercise the timeout path). */
function fakeRuntime(opts: { text?: string[]; events?: unknown[]; hang?: boolean }) {
  let handler: ((e: unknown) => void | Promise<void>) | undefined;
  return {
    onEvent(h: (e: unknown) => void | Promise<void>) {
      handler = h;
    },
    async prompt() {
      if (opts.hang) return new Promise<never>(() => {}); // never resolves
      for (const ev of opts.events ?? []) await handler?.(ev);
      for (const text of opts.text ?? []) await handler?.({ kind: "agent-text", text });
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
  const calls = {
    sendPanel: [] as Array<{ channel: ChannelRef; panel: StructuredPanel }>,
    editPanel: [] as Array<{ ref: MessageRef; panel: StructuredPanel }>,
    sendMessage: [] as Array<{ channel: ChannelRef; text: string; ref: MessageRef }>,
    editMessage: [] as Array<{ ref: MessageRef; text: string }>,
    sendFile: [] as Array<{ channel: ChannelRef; filename: string; body: string }>,
  };
  const adapter = {
    async sendPanel(channel: ChannelRef, panel: StructuredPanel): Promise<MessageRef> {
      const ref = { channel, id: `msg-${calls.sendPanel.length + 1}` };
      calls.sendPanel.push({ channel, panel });
      return ref;
    },
    async editPanel(ref: MessageRef, panel: StructuredPanel): Promise<void> {
      calls.editPanel.push({ ref, panel });
    },
    async sendMessage(channel: ChannelRef, text: string): Promise<MessageRef> {
      const ref = { channel, id: `msg-txt-${calls.sendMessage.length + 1}` };
      calls.sendMessage.push({ channel, text, ref });
      return ref;
    },
    async editMessage(ref: MessageRef, text: string): Promise<void> {
      calls.editMessage.push({ ref, text });
    },
    async sendFile(
      channel: ChannelRef,
      file: { data: Buffer; filename: string; mimeType: string }
    ): Promise<MessageRef> {
      calls.sendFile.push({ channel, filename: file.filename, body: file.data.toString("utf8") });
      return { channel, id: `msg-file-${calls.sendFile.length}` };
    },
  };
  return { adapter, calls };
}

function makeOrch(opts: {
  dataDir: string;
  rt: ReturnType<typeof fakeRuntime>;
  adapter: ReturnType<typeof spyAdapter>["adapter"];
  panel?: boolean;
  timeoutSeconds?: number;
  cfg?: Record<string, unknown>;
}): Orchestrator {
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    ensureSessionRecord: ({ channelRef }: { channelRef: string }) =>
      record({ id: `discord:${channelRef}`, channelRef }),
    getProfile: () => undefined,
    getOrStartRuntime: async () => opts.rt,
  };
  const store = {
    getPresetByName: () => null,
    recordDelegation: () => {},
    updateDelegationStatus: () => {},
    getReportBackByCorrelation: () => null,
    tryRecordReportBack: (e: unknown) => e,
    readConfig: () => opts.cfg ?? { model: "opus", reasoningEffort: "high" },
  };
  const config = {
    DATA_DIR: opts.dataDir,
    REPOS_ROOT: "/repo",
    TURN_TIMEOUT_SECONDS: opts.timeoutSeconds ?? 60,
    DEFAULT_MODEL: "default",
    CHANNEL_PRESETS_FILE: undefined,
    SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
    SEAM_DISPATCH_OUTPUT_STYLE: "messages",
    SEAM_DISPATCH_STATUS_PANEL: opts.panel ?? true,
    REPO_EMOJIS: new Map<string, string>(),
    channelPresets: {},
    threadPresets: {},
  };
  return new Orchestrator({
    logger: silent,
    config: config as any,
    adapter: opts.adapter as any,
    router: router as any,
    store: store as any,
    renderer: discordRenderer as any,
  });
}

function baseSpec(over: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    id: "disp-1",
    target: "thread-w",
    prompt: "do the thing",
    session: "live",
    kind: "handoff",
    correlationId: "corr-1",
    createdUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-panel-test-"));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("dispatchInjectTurn: status panel ON (default)", () => {
  it("posts the panel, omits the ▶ line, and streams the plain answer as its own real message", async () => {
    const rt = fakeRuntime({
      events: [
        { kind: "agent-thought", text: "planning the edit\n" },
        { kind: "tool-start", toolCallId: "t1", title: "Read app.ts" },
        { kind: "usage-update", used: 50_000, size: 200_000 },
        { kind: "model-changed", modelId: "claude-opus-4-8" },
      ],
      text: ["Hello ", "world"],
    });
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, rt, adapter });

    const res = await orch.dispatchInjectTurn(baseSpec());

    // The status panel is a REAL embed card via sendPanel (the SAME path a normal
    // turn uses), titled with the dispatch type — NOT a plain-text message.
    expect(calls.sendPanel.length).toBe(1);
    const panelPost = calls.sendPanel[0]!;
    expect(panelPost.panel.title).toContain("📨 Handoff");
    // The panel never went out as message content (that path hits the 2000-char
    // 50035 limit); the type marker appears in NO plain sendMessage.
    expect(calls.sendMessage.some((m) => m.text.includes("Handoff"))).toBe(false);
    // No ▶ line AND no "_starting…_" placeholder — with the flush renderer the
    // OUTPUT posts as fresh real messages, so nothing is pre-posted to stream into.
    expect(calls.sendMessage.every((m) => !m.text.startsWith("_▶"))).toBe(true);
    expect(calls.sendMessage.some((m) => m.text === "_starting…_")).toBe(false);

    // The plain answer is a fresh REAL message (parity with a normal turn), NOT an
    // edit of the panel — and carries no ▶/type header (the panel owns the type).
    const bodyMsgs = calls.sendMessage.filter((m) => m.text === "Hello world");
    expect(bodyMsgs.length).toBe(1);
    expect(bodyMsgs[0]!.text).not.toContain("Handoff");
    // The body's own message was never edited (it was posted whole, not tail-capped).
    const bodyRefId = bodyMsgs[0]!.ref.id;
    expect(calls.editMessage.filter((e) => e.ref.id === bodyRefId).length).toBe(0);

    // The panel is updated via editPanel (embed edits), NEVER editMessage.
    expect(calls.editMessage.length).toBe(0);
    // The panel's terminal edit shows Done + the accumulated health: thinking,
    // the context-window line, and the resolved model.
    expect(calls.editPanel.length).toBeGreaterThan(0);
    const finalPanel = calls.editPanel[calls.editPanel.length - 1]!.panel;
    expect(finalPanel.title).toContain("📨 Handoff · Done");
    const finalText = serializePanelText(finalPanel);
    expect(finalText).toContain("planning the edit"); // thinking
    expect(finalText).toContain(formatContextUsage(50_000, 200_000)); // context health
    expect(finalText).toContain("claude-opus-4-8"); // model

    // Lossless capture unaffected.
    expect(res.output).toBe("Hello world");
  });

  it("titles the panel by dispatch kind (wake / watch / report_back)", async () => {
    for (const [kind, marker] of [
      ["wake", "⏰ Wake"],
      ["watch", "👁 Watch"],
      ["report_back", "🔁 Report-back"],
    ] as const) {
      const rt = fakeRuntime({ text: ["ok"] });
      const { adapter, calls } = spyAdapter();
      const orch = makeOrch({ dataDir, rt, adapter });
      await orch.dispatchInjectTurn(baseSpec({ kind }));
      expect(calls.sendPanel[0]!.panel.title).toContain(marker);
    }
  });

  it("quiet run (stream:false) posts the panel + the body, no dangling placeholder", async () => {
    const rt = fakeRuntime({ text: ["Hello ", "world"] });
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, rt, adapter });

    const res = await orch.dispatchInjectTurn(baseSpec({ stream: false }));

    // The panel is a real embed card via sendPanel; there is NO "_starting…_"
    // placeholder and NO ▶ line — the body is posted below the panel by the
    // quiet capture path.
    expect(calls.sendPanel[0]!.panel.title).toContain("📨 Handoff");
    expect(calls.sendMessage.some((m) => m.text === "_starting…_")).toBe(false);
    expect(calls.sendMessage.every((m) => !m.text.startsWith("_▶"))).toBe(true);
    expect(calls.sendMessage.some((m) => m.text === "Hello world")).toBe(true);
    expect(res.output).toBe("Hello world");
  });

  it("titles a chained hop as 🔗 Chain regardless of kind", async () => {
    const rt = fakeRuntime({ text: ["ok"] });
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, rt, adapter });
    await orch.dispatchInjectTurn(baseSpec({ kind: "forward", chainId: "chain-1" }));
    expect(calls.sendPanel[0]!.panel.title).toContain("🔗 Chain");
  });

  it("finalizes the panel to Timed out when the turn times out", async () => {
    const rt = fakeRuntime({ hang: true });
    const { adapter, calls } = spyAdapter();
    // 50ms timeout so raceWithTimeout resolves "timeout" fast.
    const orch = makeOrch({ dataDir, rt, adapter, timeoutSeconds: 0.05 });

    await orch.dispatchInjectTurn(baseSpec()).catch(() => {}); // times out ⇒ throws

    // The panel finalized to "Timed out" via an editPanel embed edit.
    const finalPanel = calls.editPanel[calls.editPanel.length - 1]!.panel;
    expect(finalPanel.title).toContain("📨 Handoff · Timed out");
  });
});

describe("dispatchInjectTurn: status panel renders as a REAL embed card", () => {
  it("uses sendPanel/editPanel (never editMessage) and survives a busy turn without a 50035-class content overflow", async () => {
    // A genuinely busy turn: 25 tool events (activity log) + 5 long thinking
    // lines. Serialized to plain message CONTENT this blows past Discord's
    // 2000-char limit (DiscordAPIError 50035) — the exact regression. Rendered
    // as an embed it can't: embeds carry no content limit.
    const longThought = "x".repeat(300); // trimmed to 200 in the footer, ×5 lines
    const events: unknown[] = [];
    for (let i = 0; i < 25; i++) {
      events.push({ kind: "tool-start", toolCallId: `t${i}`, title: `Read some/really/long/path/to/file-number-${i}.ts` });
    }
    for (let i = 0; i < 5; i++) {
      events.push({ kind: "agent-thought", text: `${longThought}\n` });
    }
    events.push({ kind: "usage-update", used: 50_000, size: 200_000 });
    const rt = fakeRuntime({ events, text: ["done"] });
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, rt, adapter });

    await orch.dispatchInjectTurn(baseSpec());

    // Delivered as a real embed card, edited as a real embed card.
    expect(calls.sendPanel.length).toBe(1);
    expect(calls.editPanel.length).toBeGreaterThan(0);
    // The panel NEVER went through plain message content — no editMessage on it,
    // and no sendMessage carrying the panel title. This is what kills the 50035.
    expect(calls.editMessage.length).toBe(0);
    expect(calls.sendMessage.some((m) => m.text.includes("Handoff"))).toBe(false);

    // Proof the OLD plain-content path WOULD have overflowed: the equivalent
    // serialized text exceeds Discord's 2000-char content ceiling.
    const finalPanel = calls.editPanel[calls.editPanel.length - 1]!.panel;
    expect(serializePanelText(finalPanel).length).toBeGreaterThan(2000);
    // …yet no plain message we posted came anywhere near that ceiling.
    for (const m of calls.sendMessage) expect(m.text.length).toBeLessThanOrEqual(2000);
  });

  it("falls back to sendMessage/editMessage(serializePanelText) only when the adapter lacks sendPanel/editPanel", async () => {
    const rt = fakeRuntime({
      events: [{ kind: "agent-thought", text: "planning\n" }],
      text: ["Hello world"],
    });
    const { adapter, calls } = spyAdapter();
    // Strip the embed capability so the controller must fall back — exactly what
    // handleIncomingMessageInner does for a legacy adapter.
    const fallbackAdapter = { ...adapter } as Record<string, unknown>;
    delete fallbackAdapter.sendPanel;
    delete fallbackAdapter.editPanel;
    const orch = makeOrch({ dataDir, rt, adapter: fallbackAdapter as any });

    await orch.dispatchInjectTurn(baseSpec());

    // No embed calls were even possible — the panel posted as serialized text.
    expect(calls.sendPanel.length).toBe(0);
    expect(calls.editPanel.length).toBe(0);
    expect(calls.sendMessage[0]!.text).toContain("📨 Handoff");
    // The title line is the serialized panel form (**bold** header).
    expect(calls.sendMessage[0]!.text).toContain("**📨 Handoff");
  });
});

describe("dispatchInjectTurn: status panel OFF restores today's behavior", () => {
  it("posts no panel and restores the ▶ start indicator", async () => {
    const rt = fakeRuntime({ text: ["Hello ", "world"] });
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, rt, adapter, panel: false });

    const res = await orch.dispatchInjectTurn(baseSpec());

    // No panel message — the first message is the ▶ indicator (the header).
    expect(calls.sendMessage.some((m) => m.text.includes("Handoff ·"))).toBe(false);
    expect(calls.sendMessage[0]!.text).toBe("_▶ handoff · do the thing_");
    // The answer streamed as a fresh REAL message below the indicator…
    expect(calls.sendMessage.some((m) => m.text === "Hello world")).toBe(true);
    // …and the ▶ indicator flipped to ✅ in place — carrying NO body (it streamed
    // as its own message, not tail-capped into the indicator).
    const indicatorRefId = calls.sendMessage[0]!.ref.id;
    const indicatorEdits = calls.editMessage.filter((e) => e.ref.id === indicatorRefId);
    const last = indicatorEdits[indicatorEdits.length - 1]!.text;
    expect(last).toMatch(/^_✅ handoff/);
    expect(last).not.toContain("Hello world");
    expect(res.output).toBe("Hello world");
  });
});
