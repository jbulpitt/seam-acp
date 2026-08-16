import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { pino } from "pino";
import { Orchestrator } from "../src/platforms/discord/orchestrator.js";
import { dispatchDirs, type DispatchSpec } from "../src/core/dispatch/types.js";
import type { Logger } from "../src/lib/logger.js";
import type { SessionRecord, StructuredPanel } from "../src/core/types.js";
import type { ChannelRef, MessageRef } from "../src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

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

/** A fake ACP runtime whose `prompt` streams `chunks` through the handler the
 *  orchestrator registers, then returns a clean stop. Records ordering into a
 *  shared log so a test can prove the indicator posts BEFORE the turn runs. */
function fakeRuntime(chunks: string[], log: string[]) {
  let handler: ((e: unknown) => void | Promise<void>) | undefined;
  return {
    onEvent(h: (e: unknown) => void | Promise<void>) {
      handler = h;
    },
    async prompt() {
      log.push("prompt-start");
      for (const text of chunks) {
        await handler?.({ kind: "agent-text", text });
      }
      return { stopReason: "end_turn" };
    },
    async idle() {},
    getSessionInfo() {
      return { sessionId: "acp-1" };
    },
    async dispose() {},
  };
}

/** A spy adapter recording every render call, in order. */
function spyAdapter(log: string[]) {
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
      log.push(`sendPanel:${panel.title.slice(0, 12)}`);
      return { channel, id: `msg-${calls.sendPanel.length}` };
    },
    async editPanel(ref: MessageRef, panel: StructuredPanel): Promise<void> {
      calls.editPanel.push({ ref, panel });
      log.push(`editPanel:${panel.title.slice(0, 12)}`);
    },
    async sendMessage(channel: ChannelRef, text: string): Promise<MessageRef> {
      calls.sendMessage.push({ channel, text });
      log.push(`sendMessage:${text.slice(0, 12)}`);
      return { channel, id: `msg-txt-${calls.sendMessage.length}` };
    },
    async editMessage(ref: MessageRef, text: string): Promise<void> {
      calls.editMessage.push({ ref, text });
      log.push(`editMessage:${text.slice(0, 12)}`);
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

/** Build an Orchestrator whose router hands out `rt` for the live turn. */
function makeOrch(opts: {
  dataDir: string;
  rt: ReturnType<typeof fakeRuntime>;
  adapter: ReturnType<typeof spyAdapter>["adapter"];
  style?: "messages" | "card";
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
  };
  const config = {
    DATA_DIR: opts.dataDir,
    REPOS_ROOT: "/repo",
    TURN_TIMEOUT_SECONDS: 60,
    DEFAULT_MODEL: "default",
    CHANNEL_PRESETS_FILE: undefined,
    SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
    SEAM_DISPATCH_OUTPUT_STYLE: opts.style ?? "messages",
    // These tests exercise the PLAIN OUTPUT streaming path in isolation, so the
    // additive status panel is off — which is also the contract that "false
    // restores the ▶ line". Panel-on behavior is covered in
    // dispatch-status-panel.test.ts.
    SEAM_DISPATCH_STATUS_PANEL: false,
    channelPresets: {},
    threadPresets: {},
  };
  return new Orchestrator({
    logger: silent,
    config: config as any,
    adapter: opts.adapter as any,
    router: router as any,
    store: store as any,
    renderer: {} as any,
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-stream-test-"));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('dispatchInjectTurn: start indicator + live streaming ("card" style)', () => {
  it("posts a start indicator BEFORE the turn runs", async () => {
    const log: string[] = [];
    const rt = fakeRuntime(["Hello ", "world"], log);
    const { adapter, calls } = spyAdapter(log);
    const orch = makeOrch({ dataDir, rt, adapter, style: "card" });

    await orch.dispatchInjectTurn(baseSpec());

    // The indicator was posted, and its title is the kind-aware header.
    expect(calls.sendPanel.length).toBe(1);
    const indicator = calls.sendPanel[0]!.panel;
    expect(indicator.title).toMatch(/^▶ handoff/);
    // It reached the worker thread.
    expect(calls.sendPanel[0]!.channel.id).toBe("thread-w");
    // ...and it landed BEFORE the turn's prompt started running.
    expect(log.indexOf("sendPanel:▶ handoff")).toBeLessThan(log.indexOf("prompt-start"));
  });

  it("streams progressively (panel edited >1x) and does NOT double-post the body", async () => {
    const log: string[] = [];
    const rt = fakeRuntime(["Hello ", "world"], log);
    const { adapter, calls } = spyAdapter(log);
    const orch = makeOrch({ dataDir, rt, adapter, style: "card" });

    const res = await orch.dispatchInjectTurn(baseSpec());

    // The single indicator message was edited more than once (progressive
    // stream + terminal render) — no per-chunk editMessage storm required.
    expect(calls.editPanel.length).toBeGreaterThan(1);
    // The final edit shows the done state with the full body.
    const last = calls.editPanel[calls.editPanel.length - 1]!.panel;
    expect(last.title).toMatch(/^✅ handoff/);
    expect(last.description).toContain("Hello world");
    // No second card was posted with the whole body — sendPanel fired ONCE
    // (the indicator). Streaming replaces postDispatchOutput, never duplicates.
    expect(calls.sendPanel.length).toBe(1);
    // The full captured text is still returned (report-back / done-file safe).
    expect(res.output).toBe("Hello world");
  });

  it("stream:false runs quiet — indicator shown, no intermediate edits", async () => {
    const log: string[] = [];
    const rt = fakeRuntime(["Hello ", "world"], log);
    const { adapter, calls } = spyAdapter(log);
    const orch = makeOrch({ dataDir, rt, adapter, style: "card" });

    const res = await orch.dispatchInjectTurn(baseSpec({ stream: false }));

    // The panel was never progressively edited.
    expect(calls.editPanel.length).toBe(0);
    // The indicator still posted, plus the quiet capture-and-post body card.
    expect(calls.sendPanel.length).toBe(2);
    expect(calls.sendPanel[0]!.panel.title).toMatch(/^▶ handoff/);
    expect(calls.sendPanel[1]!.panel.description).toContain("Hello world");
    // Still lossless.
    expect(res.output).toBe("Hello world");
  });

  it("report-back to a different thread delivers the complete bundled text", async () => {
    const log: string[] = [];
    const rt = fakeRuntime(["Full ", "answer ", "here"], log);
    const { adapter } = spyAdapter(log);
    const orch = makeOrch({ dataDir, rt, adapter, style: "card" });

    await orch.dispatchInjectTurn(baseSpec({ returnTo: "thread-caller" }));

    // A report-back spec was enqueued into a DIFFERENT thread with the WHOLE
    // captured answer bundled (streaming changed live visibility, not delivery).
    const dirs = dispatchDirs(dataDir);
    const pending = (await readdir(dirs.pending)).filter((f) => f.endsWith(".json"));
    expect(pending.length).toBe(1);
    const spec = JSON.parse(await readFile(path.join(dirs.pending, pending[0]!), "utf8"));
    expect(spec.target).toBe("thread-caller");
    expect(spec.kind).toBe("report_back");
    expect(spec.prompt).toContain("Full answer here");
  });

  it("spills an overflowing body to a file once, without a duplicate card", async () => {
    const log: string[] = [];
    const big = "x".repeat(5000); // > DISPATCH_STREAM_DESC_MAX
    const rt = fakeRuntime([big], log);
    const { adapter, calls } = spyAdapter(log);
    const orch = makeOrch({ dataDir, rt, adapter, style: "card" });

    const res = await orch.dispatchInjectTurn(baseSpec());

    // Full body still returned…
    expect(res.output).toBe(big);
    // …attached exactly once as a file (the whole body, losslessly)…
    expect(calls.sendFile.length).toBe(1);
    expect(calls.sendFile[0]!.body).toBe(big);
    // …and still no duplicate body card (only the indicator via sendPanel).
    expect(calls.sendPanel.length).toBe(1);
    const last = calls.editPanel[calls.editPanel.length - 1]!.panel;
    expect(last.description).toContain("full output attached");
  });
});

describe('dispatchInjectTurn: plain "messages" style (default)', () => {
  it("posts a PLAIN start indicator and streams into a plain message — no embeds", async () => {
    const log: string[] = [];
    const rt = fakeRuntime(["Hello ", "world"], log);
    const { adapter, calls } = spyAdapter(log);
    // No style passed → default "messages".
    const orch = makeOrch({ dataDir, rt, adapter });

    const res = await orch.dispatchInjectTurn(baseSpec());

    // No embed cards at all — neither the start indicator nor the stream.
    expect(calls.sendPanel.length).toBe(0);
    expect(calls.editPanel.length).toBe(0);
    // The start indicator is a plain italic one-liner posted BEFORE the turn.
    expect(calls.sendMessage.length).toBe(1);
    expect(calls.sendMessage[0]!.text).toBe("_▶ handoff · do the thing_");
    expect(log.indexOf("sendMessage:_▶ handoff")).toBeLessThan(log.indexOf("prompt-start"));
    // That same message was edited in place more than once (progressive stream +
    // terminal render) — no per-chunk storm, SerialQueue/throttle intact.
    expect(calls.editMessage.length).toBeGreaterThan(1);
    // The terminal edit flips to ✅ and carries the WHOLE body inline (fits one
    // message) — a clean single traditional message, no duplicate post.
    const last = calls.editMessage[calls.editMessage.length - 1]!.text;
    expect(last).toMatch(/^_✅ handoff/);
    expect(last).toContain("Hello world");
    // Lossless capture preserved for report-back / done-file.
    expect(res.output).toBe("Hello world");
  });

  it("stream:false runs quiet — plain indicator + plain body messages, no cards", async () => {
    const log: string[] = [];
    const rt = fakeRuntime(["Hello ", "world"], log);
    const { adapter, calls } = spyAdapter(log);
    const orch = makeOrch({ dataDir, rt, adapter });

    const res = await orch.dispatchInjectTurn(baseSpec({ stream: false }));

    // Never streamed (no in-place edits) and never a card.
    expect(calls.editMessage.length).toBe(0);
    expect(calls.sendPanel.length).toBe(0);
    expect(calls.editPanel.length).toBe(0);
    // Plain indicator, then the captured body as a plain message.
    expect(calls.sendMessage.map((m) => m.text)).toEqual([
      "_▶ handoff · do the thing_",
      "Hello world",
    ]);
    expect(res.output).toBe("Hello world");
  });

  it("empty output finalizes to a short plain done line, no card", async () => {
    const log: string[] = [];
    const rt = fakeRuntime([], log); // worker produced nothing
    const { adapter, calls } = spyAdapter(log);
    const orch = makeOrch({ dataDir, rt, adapter, style: "messages" });

    const res = await orch.dispatchInjectTurn(baseSpec({ stream: false }));

    expect(res.output).toBe("");
    expect(calls.sendPanel.length).toBe(0);
    // Indicator plus a plain "no output" done line — both plain messages.
    expect(calls.sendMessage.map((m) => m.text)).toEqual([
      "_▶ handoff · do the thing_",
      "✅ Done — no output.",
    ]);
  });

  it("moderate overflow continues as additional plain messages (no file)", async () => {
    const log: string[] = [];
    // > one 2000-char message but ≤ 8 chunks of 1900 — spills to extra messages.
    const big = "y".repeat(6000);
    const rt = fakeRuntime([big], log);
    const { adapter, calls } = spyAdapter(log);
    const orch = makeOrch({ dataDir, rt, adapter });

    const res = await orch.dispatchInjectTurn(baseSpec());

    expect(res.output).toBe(big);
    // No embeds, no file — just the plain indicator (edited to a terminal line)
    // and the full body posted as fresh plain message chunks below it.
    expect(calls.sendPanel.length).toBe(0);
    expect(calls.sendFile.length).toBe(0);
    // The overflow body was chunked at 1900 → 4 additional plain messages.
    const bodyMsgs = calls.sendMessage.filter((m) => m.text.startsWith("y"));
    expect(bodyMsgs.length).toBe(Math.ceil(big.length / 1900));
    expect(bodyMsgs.map((m) => m.text).join("")).toBe(big);
    // The streamed indicator terminal edit is just the ✅ header (body is below).
    const last = calls.editMessage[calls.editMessage.length - 1]!.text;
    expect(last).toMatch(/^_✅ handoff/);
    expect(last).not.toContain("yyyy");
  });

  it("huge overflow spills to a single file, losslessly, no card", async () => {
    const log: string[] = [];
    const big = "z".repeat(20000); // > 8 chunks of 1900 → file
    const rt = fakeRuntime([big], log);
    const { adapter, calls } = spyAdapter(log);
    const orch = makeOrch({ dataDir, rt, adapter });

    const res = await orch.dispatchInjectTurn(baseSpec());

    expect(res.output).toBe(big);
    expect(calls.sendPanel.length).toBe(0);
    // Whole body attached exactly once, losslessly.
    expect(calls.sendFile.length).toBe(1);
    expect(calls.sendFile[0]!.body).toBe(big);
    // A short plain "attached" note accompanies it (not an embed).
    expect(calls.sendMessage.some((m) => m.text.includes("full output attached"))).toBe(true);
  });

  it("report-back to a different thread: plain local render, delivery unchanged", async () => {
    const log: string[] = [];
    const rt = fakeRuntime(["Full ", "answer ", "here"], log);
    const { adapter, calls } = spyAdapter(log);
    const orch = makeOrch({ dataDir, rt, adapter });

    await orch.dispatchInjectTurn(baseSpec({ returnTo: "thread-caller" }));

    // Local rendering in the worker thread is plain (no embeds).
    expect(calls.sendPanel.length).toBe(0);
    expect(calls.editPanel.length).toBe(0);
    // Delivery semantics unchanged: a report-back spec was still enqueued into
    // the DIFFERENT caller thread with the WHOLE captured answer bundled.
    const dirs = dispatchDirs(dataDir);
    const pending = (await readdir(dirs.pending)).filter((f) => f.endsWith(".json"));
    expect(pending.length).toBe(1);
    const spec = JSON.parse(await readFile(path.join(dirs.pending, pending[0]!), "utf8"));
    expect(spec.target).toBe("thread-caller");
    expect(spec.kind).toBe("report_back");
    expect(spec.prompt).toContain("Full answer here");
  });
});
