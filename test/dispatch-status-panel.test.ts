import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../src/platforms/discord/orchestrator.js";
import { DispatchStatusPanel } from "../src/core/dispatch-status-panel.js";
import { TurnStatus, formatContextUsage } from "../src/core/status-panel.js";
import { discordRenderer } from "../src/platforms/discord/renderer.js";
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
  const edits: string[] = [];
  let posted: string | undefined;
  const status = new TurnStatus({ model: "opus", repoDisplay: "repo", titlePrefix });
  const panel = new DispatchStatusPanel<MessageRef>(
    discordRenderer,
    status,
    {
      post: async (text) => {
        posted = text;
        return { channel: { platform: "discord", id: "t" }, id: "m1" };
      },
      edit: async (_ref, text) => {
        edits.push(text);
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
    // Initial post carries the dispatch type in the title.
    expect(getPosted()).toContain("⏰ Wake");
    await panel.finalize("Done", "Completed");
    const last = edits[edits.length - 1]!;
    expect(last).toContain("⏰ Wake");
    expect(last).toContain("Done"); // title is "⏰ Wake · Done"
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
  it("posts the panel, omits the ▶ line, and streams the plain answer alongside it", async () => {
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

    // The status panel was posted as the FIRST message, titled with the type.
    const panelPost = calls.sendMessage[0]!;
    expect(panelPost.text).toContain("📨 Handoff");
    // The redundant ▶ start indicator is suppressed — NO message is the ▶ line;
    // the plain stream starts as a bare "starting…" placeholder instead.
    expect(calls.sendMessage.every((m) => !m.text.startsWith("_▶"))).toBe(true);
    expect(calls.sendMessage[1]!.text).toBe("_starting…_");

    // Panel and plain output are DISTINCT messages (different refs) — both live.
    const panelRefId = panelPost.ref.id;
    const streamRefId = calls.sendMessage[1]!.ref.id;
    expect(panelRefId).not.toBe(streamRefId);

    // The plain answer streamed into its own message and finalized with the body.
    const streamEdits = calls.editMessage.filter((e) => e.ref.id === streamRefId);
    expect(streamEdits.length).toBeGreaterThan(0);
    expect(streamEdits[streamEdits.length - 1]!.text).toContain("Hello world");
    // …and the plain answer carries NO ▶/type header (the panel owns the type).
    expect(streamEdits[streamEdits.length - 1]!.text).not.toContain("Handoff");

    // The panel's terminal edit shows Done + the accumulated health: thinking,
    // the context-window line, and the resolved model.
    const panelEdits = calls.editMessage.filter((e) => e.ref.id === panelRefId);
    const finalPanel = panelEdits[panelEdits.length - 1]!.text;
    expect(finalPanel).toContain("📨 Handoff · Done");
    expect(finalPanel).toContain("planning the edit"); // thinking
    expect(finalPanel).toContain(formatContextUsage(50_000, 200_000)); // context health
    expect(finalPanel).toContain("claude-opus-4-8"); // model

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
      expect(calls.sendMessage[0]!.text).toContain(marker);
    }
  });

  it("quiet run (stream:false) posts the panel + the body, no dangling placeholder", async () => {
    const rt = fakeRuntime({ text: ["Hello ", "world"] });
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, rt, adapter });

    const res = await orch.dispatchInjectTurn(baseSpec({ stream: false }));

    // First message is the panel; there is NO "_starting…_" placeholder and NO
    // ▶ line — the body is posted below the panel by the quiet capture path.
    expect(calls.sendMessage[0]!.text).toContain("📨 Handoff");
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
    expect(calls.sendMessage[0]!.text).toContain("🔗 Chain");
  });

  it("finalizes the panel to Timed out when the turn times out", async () => {
    const rt = fakeRuntime({ hang: true });
    const { adapter, calls } = spyAdapter();
    // 50ms timeout so raceWithTimeout resolves "timeout" fast.
    const orch = makeOrch({ dataDir, rt, adapter, timeoutSeconds: 0.05 });

    await orch.dispatchInjectTurn(baseSpec()).catch(() => {}); // times out ⇒ throws

    const panelRefId = calls.sendMessage[0]!.ref.id;
    const panelEdits = calls.editMessage.filter((e) => e.ref.id === panelRefId);
    const finalPanel = panelEdits[panelEdits.length - 1]!.text;
    expect(finalPanel).toContain("📨 Handoff · Timed out");
  });
});

describe("dispatchInjectTurn: status panel OFF restores today's behavior", () => {
  it("posts no panel and restores the ▶ start indicator", async () => {
    const rt = fakeRuntime({ text: ["Hello ", "world"] });
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, rt, adapter, panel: false });

    const res = await orch.dispatchInjectTurn(baseSpec());

    // No panel message — the first (and streaming) message is the ▶ indicator.
    expect(calls.sendMessage.some((m) => m.text.includes("Handoff ·"))).toBe(false);
    expect(calls.sendMessage[0]!.text).toBe("_▶ handoff · do the thing_");
    // The answer still streamed into that ▶ message and finalized with ✅.
    const last = calls.editMessage[calls.editMessage.length - 1]!.text;
    expect(last).toMatch(/^_✅ handoff/);
    expect(last).toContain("Hello world");
    expect(res.output).toBe("Hello world");
  });
});
