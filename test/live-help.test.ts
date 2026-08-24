import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { LiveHelpManager, type LiveHelpHost } from "../packages/core/src/core/live-help/manager.js";
import {
  checkLiveHelpVoiceChannel,
  parseLiveHelpMintSpec,
} from "../packages/core/src/core/live-help/voice-policy.js";
import { isChoiceAuthoringRefused } from "../packages/core/src/core/choice/types.js";
import {
  buildActivityEnd,
  buildActivityStart,
  buildHistoryClientContent,
  buildLiveHelpSetup,
  isLiveGoAway,
  isLiveInterrupted,
  isLiveSetupComplete,
  setupHasRootResponseModalities,
} from "../packages/core/src/core/audio/gemini-live.js";
import {
  mixMono16,
  pcm24kMonoTo48kStereo,
  pcm48kStereoTo16kMono,
} from "../packages/core/src/platforms/discord/live-help-call.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { pino } from "pino";

const silent = pino({ level: "silent" }) as unknown as Logger;

describe("live-help D11 refuse-list", () => {
  it("accepts an explicit non-school guild voice snowflake", () => {
    expect(
      checkLiveHelpVoiceChannel({
        id: "1487095870188027987",
        name: "General",
        type: ChannelType.GuildVoice,
        parentName: "Voice Channels",
      })
    ).toEqual({ ok: true, channelId: "1487095870188027987" });
  });

  it("accepts a different tutoring VC (not General-only)", () => {
    expect(
      checkLiveHelpVoiceChannel({
        id: "1515080987074232323",
        name: "tutoring",
        type: ChannelType.GuildVoice,
      }).ok
    ).toBe(true);
  });

  it("refuses school-named channels and parents", () => {
    expect(
      checkLiveHelpVoiceChannel({
        id: "1487095870188027987",
        name: "school-allie",
        type: ChannelType.GuildVoice,
      }).ok
    ).toBe(false);
    expect(
      checkLiveHelpVoiceChannel({
        id: "1487095870188027987",
        name: "General",
        type: ChannelType.GuildVoice,
        parentName: "school-alaina",
      }).ok
    ).toBe(false);
  });

  it("refuses obfuscated and non-voice", () => {
    expect(
      checkLiveHelpVoiceChannel({
        id: "1487095870188027987",
        name: "General",
        type: ChannelType.GuildVoice,
        obfuscated: true,
      }).ok
    ).toBe(false);
    expect(
      checkLiveHelpVoiceChannel({
        id: "1487095870188027987",
        name: "General",
        type: ChannelType.GuildText,
      }).ok
    ).toBe(false);
  });

  it("refuses a non-snowflake id", () => {
    expect(checkLiveHelpVoiceChannel({ id: "general" }).ok).toBe(false);
  });
});

describe("live-help setup shape (D10)", () => {
  it("puts responseModalities only in generationConfig, not the setup root", () => {
    const msg = buildLiveHelpSetup({ system: "tutor fractions" });
    expect(setupHasRootResponseModalities(msg)).toBe(false);
    const gen = msg.setup.generationConfig as Record<string, unknown>;
    expect(gen.responseModalities).toEqual(["AUDIO"]);
    expect(msg.setup.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(msg.setup.realtimeInputConfig).toEqual({
      automaticActivityDetection: { disabled: true },
    });
    expect(msg.setup.historyConfig).toEqual({ initialHistoryInClientContent: true });
    expect(msg.setup.systemInstruction).toEqual({
      parts: [{ text: "tutor fractions" }],
    });
  });

  it("history is clientContent, not File Search", () => {
    const msg = buildHistoryClientContent("missed 1/2 + 1/4");
    expect(msg.clientContent).toMatchObject({
      turnComplete: true,
      turns: [{ role: "user", parts: [{ text: "missed 1/2 + 1/4" }] }],
    });
  });

  it("seeds history without starting a spoken turn (3.1 initialHistoryInClientContent)", () => {
    const setup = buildLiveHelpSetup({ system: "tutor" });
    const hist = setup.setup.historyConfig as { initialHistoryInClientContent?: boolean };
    expect(hist.initialHistoryInClientContent).toBe(true);
  });

  it("parses setupComplete, interrupted, goAway", () => {
    expect(isLiveSetupComplete({ setupComplete: {} })).toBe(true);
    expect(isLiveInterrupted({ serverContent: { interrupted: true } })).toBe(true);
    expect(isLiveGoAway({ goAway: { timeLeft: "10s" } })).toBe(true);
  });

  it("brackets utterances with activityStart / activityEnd", () => {
    expect(buildActivityStart()).toEqual({ realtimeInput: { activityStart: {} } });
    expect(buildActivityEnd()).toEqual({ realtimeInput: { activityEnd: {} } });
  });
});

describe("live-help mint spec + participant gate", () => {
  it("requires voiceChannelId + system", () => {
    expect(parseLiveHelpMintSpec({}).ok).toBe(false);
    expect(parseLiveHelpMintSpec({ voiceChannelId: "1" }).ok).toBe(false);
    expect(
      parseLiveHelpMintSpec({
        voiceChannelId: "1487095870188027987",
        system: "hi",
      }).ok
    ).toBe(true);
  });

  it("restricted participants cannot mint; injected turns can", () => {
    const kids = new Set(["kid-1"]);
    const admins = new Set(["admin-1"]);
    expect(isChoiceAuthoringRefused("kid-1", kids, admins)).toBe(true);
    expect(isChoiceAuthoringRefused("admin-1", kids, admins)).toBe(false);
    expect(isChoiceAuthoringRefused(null, kids, admins)).toBe(false);
    expect(isChoiceAuthoringRefused(undefined, kids, admins)).toBe(false);
  });
});

describe("pcm mix / resample (no disk)", () => {
  it("downsamples 48k stereo to 16k mono", () => {
    const pcm = Buffer.alloc(4 * 6);
    for (let i = 0; i < 6; i++) {
      pcm.writeInt16LE(3000, i * 4);
      pcm.writeInt16LE(1000, i * 4 + 2);
    }
    const out = pcm48kStereoTo16kMono(pcm);
    expect(out.byteLength).toBe(4);
    expect(out.readInt16LE(0)).toBe(2000);
  });

  it("upsamples 24k mono 20ms to 48k stereo", () => {
    const frame = Buffer.alloc(960);
    frame.writeInt16LE(100, 0);
    const out = pcm24kMonoTo48kStereo(frame);
    expect(out.byteLength).toBe(3840);
    expect(out.readInt16LE(0)).toBe(100);
    expect(out.readInt16LE(2)).toBe(100);
    expect(out.readInt16LE(4)).toBe(100);
  });

  it("mixes overlapping speakers with clamp", () => {
    const a = Buffer.alloc(2);
    a.writeInt16LE(20_000, 0);
    const b = Buffer.alloc(2);
    b.writeInt16LE(20_000, 0);
    expect(mixMono16([a, b]).readInt16LE(0)).toBe(32767);
  });
});

describe("LiveHelpManager one-session-per-VC + restart", () => {
  let dir: string;
  let store: SessionStore;

  const record = (): SessionRecord => ({
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    agentId: "grok",
    acpSessionId: "acp",
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-live-help-"));
    store = new SessionStore(path.join(dir, "t.db"));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function mgr(over?: Partial<LiveHelpHost>): LiveHelpManager {
    const host: LiveHelpHost = {
      inspectVoiceChannel: async () => ({
        ok: true,
        guildId: "guild-1",
        channelName: "General",
        type: 2,
        obfuscated: false,
      }),
      runCall: async ({ signal }) =>
        new Promise((resolve) => {
          const t = setTimeout(() => resolve({ reason: "ended" }), 30_000);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve({ reason: "cancelled" });
          });
        }),
      notify: async () => {},
      ...over,
    };
    return new LiveHelpManager({
      store,
      logger: silent,
      host,
      apiKey: () => "test-key",
    });
  }

  it("refuses a second mint on a busy VC", async () => {
    const m = mgr();
    const first = await m.mint(
      record(),
      { voiceChannelId: "1487095870188027987", system: "tutor" },
      "coach"
    );
    expect(first.ok).toBe(true);
    const second = await m.mint(
      record(),
      { voiceChannelId: "1487095870188027987", system: "tutor" },
      "coach"
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already has a live-help/);
    if (first.ok) m.cancel(first.liveId);
  });

  it("refuses a second mint in the same guild even on another VC", async () => {
    const m = mgr();
    const first = await m.mint(
      record(),
      { voiceChannelId: "1487095870188027987", system: "tutor" },
      "coach"
    );
    expect(first.ok).toBe(true);
    const second = await m.mint(
      record(),
      { voiceChannelId: "1515080987074232323", system: "tutor" },
      "coach"
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/guild already/);
    if (first.ok) m.cancel(first.liveId);
  });

  it("reconcileOnBoot marks in-flight rows ended", async () => {
    const m = mgr();
    const first = await m.mint(
      record(),
      { voiceChannelId: "1487095870188027987", system: "tutor" },
      "coach"
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const n = m.reconcileOnBoot();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(store.getLiveHelp(first.liveId)?.status).toBe("ended");
    m.stopAll();
  });

  it("stores preset without requiring it", async () => {
    const m = mgr();
    const out = await m.mint(
      record(),
      {
        voiceChannelId: "1487095870188027987",
        system: "tutor",
        preset: "fractions-coach",
      },
      "coach"
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(store.getLiveHelp(out.liveId)?.preset).toBe("fractions-coach");
    m.cancel(out.liveId);
  });
});

describe("MCP create_live_help / cancel_live_help", () => {
  it("create_live_help returns liveId", async () => {
    const { SeamMcpServer } = await import("../packages/core/src/core/mcp/seam-mcp-server.js");
    const server = new SeamMcpServer({
      logger: silent,
      resolveSession: (t) =>
        t === "tok"
          ? {
              id: "discord:thread-1",
              platform: "discord",
              channelRef: "thread-1",
              parentRef: "chan-1",
              agentId: "grok",
              acpSessionId: "acp",
              repoPath: "/r",
              configJson: "{}",
              createdUtc: "t",
              updatedUtc: "t",
            }
          : undefined,
      enqueueDispatch: async () => {},
      createLiveHelp: async () => ({
        ok: true,
        liveId: "lh_1",
        guildId: "g",
        channelName: "General",
      }),
    });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seam-session": "tok" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_live_help",
          arguments: { voiceChannelId: "1487095870188027987", system: "tutor" },
        },
      }),
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toMatch(/lh_1/);
    expect(body.result.content[0]!.text).toMatch(/General/);
    await server.stop();
  });

  it("surfaces a participant refusal", async () => {
    const { SeamMcpServer } = await import("../packages/core/src/core/mcp/seam-mcp-server.js");
    const server = new SeamMcpServer({
      logger: silent,
      resolveSession: (t) =>
        t === "tok"
          ? {
              id: "discord:thread-1",
              platform: "discord",
              channelRef: "thread-1",
              parentRef: "chan-1",
              agentId: "grok",
              acpSessionId: "acp",
              repoPath: "/r",
              configJson: "{}",
              createdUtc: "t",
              updatedUtc: "t",
            }
          : undefined,
      enqueueDispatch: async () => {},
      createLiveHelp: async () => ({
        ok: false,
        error: "Restricted participants cannot mint live-help calls.",
      }),
    });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seam-session": "tok" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_live_help",
          arguments: { voiceChannelId: "1487095870188027987", system: "tutor" },
        },
      }),
    });
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toMatch(/Restricted participants/);
    await server.stop();
  });
});
