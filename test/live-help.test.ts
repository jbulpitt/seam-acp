import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { LiveHelpManager, type LiveHelpHost } from "../packages/core/src/core/live-help/manager.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import {
  checkLiveHelpVoiceChannel,
  parseLiveHelpMintSpec,
} from "../packages/core/src/core/live-help/voice-policy.js";
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
import { VoiceLeaseManager } from "../packages/core/src/core/voice-lease.js";
import { pino } from "pino";

const silent = pino({ level: "silent" }) as unknown as Logger;

describe("live-help voice-channel validation", () => {
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

  it("accepts designated school/course voice channels", () => {
    expect(
      checkLiveHelpVoiceChannel({
        id: "1487095870188027987",
        name: "school-allie",
        type: ChannelType.GuildVoice,
      }).ok
    ).toBe(true);
    expect(
      checkLiveHelpVoiceChannel({
        id: "1487095870188027987",
        name: "General",
        type: ChannelType.GuildVoice,
        parentName: "school-alaina",
      }).ok
    ).toBe(true);
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

describe("live-help mint spec + self-service authorization", () => {
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

  it("lets a restricted participant start and stop live help in their own thread", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-live-help-auth-"));
    const store = new SessionStore(path.join(dir, "test.db"));
    try {
      const session: SessionRecord = {
        id: "discord:thread-1",
        platform: "discord",
        channelRef: "thread-1",
        parentRef: "course-1",
        agentId: "grok",
        acpSessionId: "acp",
        repoPath: "/repo",
        configJson: "{}",
        createdUtc: "2026-01-01T00:00:00Z",
        updatedUtc: "2026-01-01T00:00:00Z",
      };
      const mint = vi.fn(async () => ({
        ok: true as const,
        liveId: "lh_student",
        guildId: "guild-1",
        channelName: "school-allie",
      }));
      const cancel = vi.fn(() => ({ ok: true as const }));
      const orch = new Orchestrator({
        logger: silent,
        config: {
          DATA_DIR: dir,
          REPOS_ROOT: dir,
          DISCORD_ALLOWED_USER_IDS: new Set(["kid-1"]),
          SEAM_PARTICIPANT_USER_IDS: new Set(["kid-1"]),
          SEAM_CONFIG_ADMIN_USER_IDS: new Set(["admin-1"]),
          channelPresets: new Map(),
          threadPresets: new Map(),
        } as any,
        adapter: {} as any,
        router: { listProfiles: () => [], describeConfig: () => ({}) } as any,
        store,
        renderer: {} as any,
      });
      orch.setLiveHelpManager({ mint, cancel } as unknown as LiveHelpManager);
      (orch as any).currentAuthorIds.set(session.channelRef, "kid-1");

      const spec = {
        voiceChannelId: "1541262301636853832",
        system: "Tutor the current lesson.",
      };
      await expect(orch.createLiveHelp(session, spec)).resolves.toMatchObject({
        ok: true,
        liveId: "lh_student",
      });
      expect(mint).toHaveBeenCalledWith(session, spec, "kid-1");

      expect(orch.cancelLiveHelp(session, "lh_student")).toEqual({ ok: true });
      expect(cancel).toHaveBeenCalledWith("lh_student", {
        authoringChannelRef: "thread-1",
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  function mgr(over?: Partial<LiveHelpHost>, leases = new VoiceLeaseManager()): LiveHelpManager {
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
      leases,
    });
  }

  it("arbitrates concurrent mints atomically through the shared guild lease", async () => {
    let releaseInspection!: () => void;
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
    const inspectVoiceChannel = vi.fn(async () => {
      await inspectionGate;
      return {
        ok: true as const,
        guildId: "guild-1",
        channelName: "General",
        type: 2,
        obfuscated: false,
      };
    });
    const m = mgr({ inspectVoiceChannel });
    const first = m.mint(
      record(),
      { voiceChannelId: "1487095870188027987", system: "tutor one" },
      "student-one"
    );
    const second = m.mint(
      record(),
      { voiceChannelId: "1487095870188027987", system: "tutor two" },
      "student-two"
    );
    await vi.waitFor(() => expect(inspectVoiceChannel).toHaveBeenCalledTimes(2));
    releaseInspection();

    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused).toMatchObject({ ok: false });
    if (refused && !refused.ok) {
      expect(refused.error).toMatch(/already has a live-help|leased by live_help session/);
    }
    const active = results.find((result) => result.ok);
    if (active?.ok) m.cancel(active.liveId);
  });

  it("names a shared Thread Voice lease conflict without changing Live Help authorization", async () => {
    const leases = new VoiceLeaseManager();
    leases.acquire({
      kind: "thread_voice",
      sessionId: "tv-active",
      guildId: "guild-1",
      voiceChannelId: "vc-thread-voice",
    });
    const result = await mgr(undefined, leases).mint(
      record(),
      { voiceChannelId: "1487095870188027987", system: "tutor" },
      "student-self-service"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("thread_voice session `tv-active`");
      expect(result.error).not.toMatch(/parent|approval|authoriz/i);
    }
  });

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
    await m.stopAll();
  });

  it("stopAll waits for the aborted call's DB/notification cleanup tail", async () => {
    let release!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
    const m = mgr({
      runCall: async ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            void cleanupGate.then(() => resolve({ reason: "cancelled" }));
          });
        }),
    });
    const minted = await m.mint(
      record(),
      { voiceChannelId: "1487095870188027987", system: "tutor" },
      "coach"
    );
    expect(minted.ok).toBe(true);
    let stopped = false;
    const stop = m.stopAll().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(stopped).toBe(true);
    if (minted.ok) expect(store.getLiveHelp(minted.liveId)?.status).toBe("cancelled");
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

  it("surfaces a host policy refusal", async () => {
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
        error: "This guild already has a live-help session.",
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
    expect(body.result.content[0]!.text).toMatch(/already has a live-help session/);
    await server.stop();
  });
});
