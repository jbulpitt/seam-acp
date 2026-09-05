import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { completionRoute } from "../packages/core/src/core/dispatch/done-reconcile.js";
import {
  dispatchDirs,
  isStatelessHandoffWorker,
  shouldInlineCardReportBack,
  type DispatchSpec,
} from "../packages/core/src/core/dispatch/types.js";
import {
  DISPATCH_CARD_WINDOW_CHARS,
  rollingLineWindow,
} from "../packages/core/src/core/rolling-line-window.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { Preset, SessionRecord, StructuredPanel } from "../packages/core/src/core/types.js";
import type { ChannelRef, MessageRef } from "../packages/core/src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-caller",
  platform: "discord",
  channelRef: "thread-caller",
  parentRef: null,
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-01-01T00:00:00Z",
  updatedUtc: "2026-01-01T00:00:00Z",
  ...over,
});

function fakePreset(name: string): Preset {
  return {
    id: `preset-${name}`,
    name,
    description: null,
    agentId: "claude",
    model: null,
    effort: null,
    repoPath: null,
    role: null,
    disableThreadPrefix: null,
    permission: null,
    toolsAllow: null,
    toolsExclude: null,
    instructions: null,
    statusCardStyle: null,
    createdBy: "test",
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
  };
}

function spyAdapter() {
  const calls = {
    sendPanel: [] as Array<{ channel: ChannelRef; panel: StructuredPanel }>,
    editPanel: [] as Array<{ ref: MessageRef; panel: StructuredPanel }>,
    sendMessage: [] as Array<{ channel: ChannelRef; text: string }>,
    editMessage: [] as Array<{ ref: MessageRef; text: string }>,
    sendFile: [] as Array<{ channel: ChannelRef; filename: string; body: string }>,
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
  adapter: ReturnType<typeof spyAdapter>["adapter"];
  chunks?: string[];
  error?: string;
}): Orchestrator {
  const chunks = opts.chunks ?? ["Hello ", "world"];
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    ensureSessionRecord: ({ channelRef }: { channelRef: string }) =>
      record({ id: `discord:${channelRef}`, channelRef }),
    getProfile: () => ({ id: "claude" }),
    getOrStartRuntime: async () => {
      throw new Error("live runtime must not be used; injectTurn is stubbed");
    },
    reuseMcpServers: () => [],
  };
  const store = {
    getPresetByName: (name: string) => fakePreset(name),
    recordDelegation: () => {},
    getDelegation: () => null,
    updateDelegationStatus: () => {},
    getReportBackByCorrelation: () => null,
    tryRecordReportBack: (e: unknown) => e,
    getParkedByChannel: () => null,
  };
  const orchestrator = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: opts.dataDir,
      REPOS_ROOT: "/repo",
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "default",
      CHANNEL_PRESETS_FILE: undefined,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      SEAM_DISPATCH_OUTPUT_STYLE: "messages",
      SEAM_DISPATCH_STATUS_PANEL: false,
      channelPresets: {},
      threadPresets: {},
    } as any,
    adapter: opts.adapter as any,
    router: router as any,
    store: store as any,
    renderer: {} as any,
  });
  (orchestrator as any).injectTurn = async (
    _record: unknown,
    _prompt: unknown,
    injectOpts: { onEvent?: (event: { kind: string; text: string }) => Promise<void> | void }
  ) => {
    let text = "";
    for (const chunk of chunks) {
      text += chunk;
      await injectOpts.onEvent?.({ kind: "agent-text", text: chunk });
    }
    return {
      text,
      stopReason: "end_turn",
      ...(opts.error ? { error: opts.error } : {}),
    };
  };
  return orchestrator;
}

function presetSpec(over: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    id: "disp-stateless",
    target: "thread-caller",
    prompt: "review the diff",
    session: "isolated",
    preset: "reviewer",
    returnTo: "thread-caller",
    kind: "handoff",
    correlationId: "corr-stateless",
    createdUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function threadSpec(over: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    id: "disp-thread",
    target: "thread-worker",
    prompt: "do the thing",
    session: "live",
    returnTo: "thread-caller",
    kind: "handoff",
    correlationId: "corr-thread",
    createdUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function pendingSpecs(dataDir: string): DispatchSpec[] {
  const { pending } = dispatchDirs(dataDir);
  if (!fs.existsSync(pending)) return [];
  return fs
    .readdirSync(pending)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(fs.readFileSync(path.join(pending, n), "utf8")) as DispatchSpec);
}

function reportBacks(dataDir: string): DispatchSpec[] {
  return pendingSpecs(dataDir).filter((s) => s.kind === "report_back");
}

function assertNoLiveReportBack(dataDir: string): void {
  const rbs = reportBacks(dataDir);
  if (rbs.length > 0) {
    throw new Error(
      `live report_back turn must not be enqueued for same-thread card delivery; got ${rbs
        .map((s) => `${s.id} → ${s.target}`)
        .join(", ")}`
    );
  }
}

function overCapLines(count = 40): string {
  return Array.from(
    { length: count },
    (_, i) => `L${String(i).padStart(2, "0")}-${"x".repeat(20)}`
  ).join("\n");
}

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-stateless-card-"));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("rollingLineWindow", () => {
  it("leaves text under the cap unchanged", () => {
    expect(rollingLineWindow("hello\nworld", 750)).toBe("hello\nworld");
    expect(rollingLineWindow("hello\nworld", 11)).toBe("hello\nworld");
  });

  it("drops oldest complete lines once over cap", () => {
    const text = "aaaa\nbbbb\ncccc";
    expect(rollingLineWindow(text, 9)).toBe("bbbb\ncccc");
    expect(rollingLineWindow(text, 4)).toBe("cccc");
  });

  it("keeps a newest line that itself exceeds the cap whole (no mid-line cut)", () => {
    const newest = "n".repeat(DISPATCH_CARD_WINDOW_CHARS + 80);
    const text = `old-line-one\n${newest}`;
    expect(rollingLineWindow(text, DISPATCH_CARD_WINDOW_CHARS)).toBe(newest);
    expect(rollingLineWindow(newest, DISPATCH_CARD_WINDOW_CHARS)).toBe(newest);
  });

  it("splits only on \\n so mixed endings keep \\r on the line", () => {
    const text = "aaaa\nbbbb\r\ncccc";
    expect(rollingLineWindow(text, text.length)).toBe(text);
    expect(rollingLineWindow(text, 10)).toBe("bbbb\r\ncccc");
    expect(rollingLineWindow(text, 10)).toContain("\r");
  });
});

describe("isStatelessHandoffWorker / shouldInlineCardReportBack", () => {
  it("treats preset and agentId@location isolated handoffs as the card path", () => {
    expect(isStatelessHandoffWorker(presetSpec())).toBe(true);
    expect(
      isStatelessHandoffWorker(
        presetSpec({ preset: "claude", location: "mac", agentId: undefined })
      )
    ).toBe(true);
    expect(
      isStatelessHandoffWorker({
        target: "thread-caller",
        prompt: "x",
        session: "isolated",
        agentId: "claude",
        kind: "handoff",
        createdUtc: "2026-01-01T00:00:00Z",
        id: "d",
      })
    ).toBe(true);
  });

  it("does not treat thread-id handoffs or chain hops as the card path", () => {
    expect(isStatelessHandoffWorker(threadSpec())).toBe(false);
    expect(isStatelessHandoffWorker(presetSpec({ chainId: "chain-1", kind: "forward" }))).toBe(
      false
    );
  });

  it("inlines report-back only when returnTo equals target", () => {
    expect(shouldInlineCardReportBack(presetSpec())).toBe(true);
    expect(shouldInlineCardReportBack(presetSpec({ returnTo: "thread-other" }))).toBe(false);
    expect(shouldInlineCardReportBack(threadSpec())).toBe(false);
  });
});

describe("stateless/preset handoff embed card", () => {
  it("posts a card (not messages) for a preset handoff", async () => {
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter, chunks: ["Hello ", "world"] });
    await orch.dispatchInjectTurn(presetSpec());
    expect(calls.sendPanel.length).toBe(1);
    expect(calls.sendPanel[0]!.channel.id).toBe("thread-caller");
    expect(calls.sendPanel[0]!.panel.title).toMatch(/^▶ handoff/);
    expect(calls.sendMessage.filter((m) => !m.text.startsWith("_▶"))).toHaveLength(0);
  });

  it("keeps a thread-id handoff on the messages path and still report-backs", async () => {
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter, chunks: ["Hello ", "world"] });
    await orch.dispatchInjectTurn(threadSpec());
    expect(calls.sendPanel.length).toBe(0);
    expect(calls.sendMessage.some((m) => m.channel.id === "thread-worker")).toBe(true);
    const rbs = reportBacks(dataDir);
    expect(rbs).toHaveLength(1);
    expect(rbs[0]!.target).toBe("thread-caller");
    expect(rbs[0]!.kind).toBe("report_back");
    expect(rbs[0]!.prompt).toContain("Hello world");
  });

  it("streams the rolling window, not the full dump", async () => {
    const blob = overCapLines();
    expect(blob.length).toBeGreaterThan(DISPATCH_CARD_WINDOW_CHARS);
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter, chunks: [blob] });
    const res = await orch.dispatchInjectTurn(presetSpec());
    expect(res.output).toBe(blob);

    const live = calls.editPanel.filter((e) => !e.panel.fields.some((f) => f.name === "Result"));
    expect(live.length).toBeGreaterThan(0);
    for (const edit of live) {
      expect(edit.panel.description).toBe(
        rollingLineWindow(blob, DISPATCH_CARD_WINDOW_CHARS)
      );
      expect(edit.panel.description).not.toBe(blob);
      expect(edit.panel.description!.length).toBeLessThan(blob.length);
      expect(edit.panel.description!.endsWith("L39-xxxxxxxxxxxxxxxxxxxx")).toBe(true);
    }
  });

  it("on Done, the same message gains a Result section and does not enqueue report_back", async () => {
    const blob = overCapLines();
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter, chunks: [blob] });
    await orch.dispatchInjectTurn(presetSpec());

    expect(calls.sendPanel.length).toBe(1);
    const last = calls.editPanel[calls.editPanel.length - 1]!.panel;
    expect(last.title).toMatch(/^✅ handoff/);
    const resultField = last.fields.find((f) => f.name === "Result");
    expect(resultField).toBeDefined();
    expect(resultField!.value).toBe(rollingLineWindow(blob, DISPATCH_CARD_WINDOW_CHARS));
    expect(resultField!.value).not.toBe(blob);
    expect(last.fields.some((f) => f.name === "Error")).toBe(false);
    assertNoLiveReportBack(dataDir);
  });

  it("stream:false still posts one card that flips to Done with Result", async () => {
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter, chunks: ["Hello ", "world"] });
    await orch.dispatchInjectTurn(presetSpec({ stream: false }));
    expect(calls.sendPanel.length).toBe(1);
    expect(calls.sendPanel[0]!.panel.title).toMatch(/^▶ handoff/);
    expect(calls.editPanel.length).toBe(1);
    const done = calls.editPanel[0]!.panel;
    expect(done.title).toMatch(/^✅ handoff/);
    expect(done.fields.find((f) => f.name === "Result")?.value).toBe("Hello world");
    assertNoLiveReportBack(dataDir);
  });

  it("empty output: Done card says no output, still no live report-back", async () => {
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter, chunks: [] });
    await orch.dispatchInjectTurn(presetSpec());
    const last = calls.editPanel[calls.editPanel.length - 1]!.panel;
    expect(last.fields.find((f) => f.name === "Result")?.value).toBe("_(no output)_");
    assertNoLiveReportBack(dataDir);
  });

  it("errors land on the Done card (error color / Error section), not a live report-back", async () => {
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter, chunks: ["partial answer"], error: "boom" });
    await expect(orch.dispatchInjectTurn(presetSpec())).rejects.toThrow("boom");
    const last = calls.editPanel[calls.editPanel.length - 1]!.panel;
    expect(last.title).toMatch(/^❌ handoff/);
    expect(last.color).toBe(0xe74c3c);
    expect(last.fields.find((f) => f.name === "Error")?.value).toBe("boom");
    expect(last.fields.find((f) => f.name === "Result")?.value).toBe("partial answer");
    assertNoLiveReportBack(dataDir);
  });

  it("still enqueues a live report-back when returnTo is a different thread", async () => {
    const { adapter, calls } = spyAdapter();
    const orch = makeOrch({ dataDir, adapter, chunks: ["Full ", "answer"] });
    await orch.dispatchInjectTurn(presetSpec({ returnTo: "thread-other" }));
    expect(calls.sendPanel[0]!.channel.id).toBe("thread-caller");
    const last = calls.editPanel[calls.editPanel.length - 1]!.panel;
    expect(last.fields.find((f) => f.name === "Result")?.value).toBe("Full answer");
    const rbs = reportBacks(dataDir);
    expect(rbs).toHaveLength(1);
    expect(rbs[0]!.target).toBe("thread-other");
    expect(rbs[0]!.kind).toBe("report_back");
    expect(rbs[0]!.prompt).toContain("Full answer");
    expect(rbs[0]!.prompt).toContain("<seam-report-back");
  });
});

describe("completion replay does not invent a live report-back for the card path", () => {
  it("completionRoute terminalizes when inlinedReportBack is set, even with returnTo", () => {
    const route = completionRoute(
      {
        returnTo: "thread-caller",
        kind: "handoff",
        inlinedReportBack: true,
      },
      { status: "running", kind: "handoff" }
    );
    expect(route).toEqual({ action: "terminalize" });
  });

  it("stamps inlinedReportBack on the done-file for a same-thread preset handoff", async () => {
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => ({ output: "card result", stopReason: "end_turn" }),
    });
    const spec = presetSpec({ id: "disp-inline" });
    const dirs = dispatchDirs(dataDir);
    await mkdir(dirs.pending, { recursive: true });
    await writeFile(path.join(dirs.pending, `${spec.id}.json`), `${JSON.stringify(spec, null, 2)}\n`);
    await watcher.start();
    watcher.stop();
    const done = JSON.parse(await readFile(path.join(dirs.done, `${spec.id}.json`), "utf8"));
    expect(done.inlinedReportBack).toBe(true);
    expect(done.returnTo).toBe("thread-caller");
    expect(completionRoute(done, { status: "running", kind: "handoff" })).toEqual({
      action: "terminalize",
    });
    expect(await readdir(dirs.pending)).toEqual([]);
  });
});
