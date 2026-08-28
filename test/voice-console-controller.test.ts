import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../packages/core/src/core/session-store.js";
import { VoiceLeaseManager } from "../packages/core/src/core/voice-lease.js";
import { VoiceConsoleManager } from "../packages/core/src/core/voice-console/manager.js";
import { VoiceConsoleController } from "../packages/core/src/platforms/discord/voice-console-controller.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const request = {
  guildId: "guild-1",
  channelRef: "thread-1",
  parentRef: "parent-1",
  ownerUserId: "admin-1",
  ownerName: "Owner",
  alias: "One",
  ttsVoice: "Kore",
  ttsPace: "natural" as const,
  ttsStyle: "neutral" as const,
};

describe("VoiceConsoleController startup transaction", () => {
  let dir: string;
  let store: SessionStore;
  let leases: VoiceLeaseManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-voice-console-controller-"));
    store = new SessionStore(path.join(dir, "test.db"));
    leases = new VoiceLeaseManager();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(over: Record<string, unknown> = {}) {
    const events: string[] = [];
    let onConnectionLost: ((reason: string) => void) | undefined;
    let capturePersistence: any;
    const captureHost = {
      router: {
        listLanes: () => [],
        activeLaneCount: 0,
      },
      setInputEnabled: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    };
    const playback = {
      play: vi.fn(async () => ({ status: "played" as const, durationMs: 0 })),
      destroy: vi.fn(),
    };
    const adapter = {
      inspectVoiceConsoleStart: vi.fn(async () => ({
        ok: true as const,
        guildId: "guild-1",
        voiceChannelId: "vc-1",
        channelName: "General",
        selfMuted: true,
        visible: true,
        missingPermissions: [],
        initialSpeakers: [{
          userId: "admin-1",
          speakerName: "Owner",
          selfMuted: true,
          sessionId: "voice-session",
        }],
      })),
      inspectVoiceConsoleChannel: vi.fn(async () => ({
        ok: true as const,
        guildId: "guild-1",
        missingPermissions: [],
        initialSpeakers: [],
      })),
      sendVoiceConsolePanel: vi.fn(async () => {
        events.push("card-post");
        expect(store.listActiveVoiceConsoles()).toHaveLength(0);
        return { channel: { platform: "discord", id: "vc-1" }, id: "card-1" };
      }),
      editVoiceConsolePanel: vi.fn(async () => { events.push("card-edit"); }),
      voiceConsoleMessageExists: vi.fn(async () => true),
      createVoiceConsoleTransport: vi.fn(async (opts: any) => {
        events.push("transport-create");
        onConnectionLost = opts.callbacks?.onConnectionLost;
        capturePersistence = opts.persistence;
        expect(store.listActiveVoiceConsoles()).toHaveLength(1);
        expect(leases.get("guild-1")).toMatchObject({ kind: "thread_voice" });
        return {
          connection: { state: { status: "ready" } },
          captureHost,
          playback,
          destroyConnection: vi.fn(),
        };
      }),
      sendMessage: vi.fn(async () => ({
        channel: { platform: "discord", id: "thread-1" },
        id: "echo-1",
      })),
      watchVoiceConsoleOwnerPresence: vi.fn(() => vi.fn()),
      ...over,
    };
    const controller = new VoiceConsoleController({
      store,
      adapter: adapter as any,
      logger: silent,
      apiKey: () => "key",
      ttsModel: () => "model",
      isAllowedUser: (id) => id === "admin-1",
      isBindingBusy: () => false,
      cardRetryDelaysMs: [0, 0, 0],
    });
    const manager = new VoiceConsoleManager({
      store,
      logger: silent,
      host: controller,
      leases,
      dispatch: {
        isBindingBusy: () => false,
        inspectArtifact: async () => "missing",
        enqueue: async () => {},
      },
    });
    controller.setManager(manager);
    return {
      adapter,
      controller,
      manager,
      events,
      captureHost,
      playback,
      getCapturePersistence: () => capturePersistence,
      loseConnection: (reason = "connection lost") => onConnectionLost?.(reason),
    };
  }

  it("refuses each missing VC-chat permission before card, state, lease, or transport", async () => {
    const { adapter, controller } = setup({
      inspectVoiceConsoleStart: vi.fn(async () => ({
        ok: true as const,
        guildId: "guild-1",
        voiceChannelId: "vc-1",
        channelName: "General",
        selfMuted: true,
        visible: true,
        missingPermissions: ["EmbedLinks"],
        initialSpeakers: [],
      })),
    });
    await expect(controller.start(request)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("EmbedLinks"),
    });
    expect(adapter.sendVoiceConsolePanel).not.toHaveBeenCalled();
    expect(adapter.createVoiceConsoleTransport).not.toHaveBeenCalled();
    expect(store.listActiveVoiceConsoles()).toHaveLength(0);
    expect(leases.get("guild-1")).toBeUndefined();
  });

  it("posts the VC-chat card before durable state, lease, and shared transport", async () => {
    const { adapter, controller, manager, events } = setup();
    expect(leases.get("guild-1")).toBeUndefined();
    const result = await controller.start(request);
    if (!result.ok) throw new Error(result.error);
    expect(result).toMatchObject({ ok: true });
    expect(events.slice(0, 2)).toEqual(["card-post", "transport-create"]);
    expect(store.listActiveVoiceConsoles()).toHaveLength(1);
    expect(store.listActiveVoiceConsoles()[0]).toMatchObject({
      status: "ready",
      cardChannelId: "vc-1",
      cardMessageId: "card-1",
    });
    expect(store.getActiveVoiceConsoleBindingForThread("discord", "thread-1")).toMatchObject({
      noticeMessageId: "echo-1",
    });
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      { platform: "discord", id: "thread-1", parentId: "parent-1" },
      expect.stringContaining("Open canonical controls")
    );
    expect(controller.statusPages(result.console.id)[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "STT outcomes", value: expect.stringContaining("0 live") }),
      ])
    );
    await controller.shutdownAll();
    manager.shutdown();
  });

  it("persists exact forwarded-byte telemetry and echoes an idempotent terminal winner once", async () => {
    const { adapter, controller, manager, getCapturePersistence } = setup();
    const started = await controller.start(request);
    if (!started.ok) throw new Error(started.error);
    const persistence = getCapturePersistence();
    const snapshot = await persistence.snapshotCapture({
      speakerId: "admin-1",
      speakerName: "Owner",
      capturedStartedUtc: "2026-08-28T12:00:00.000Z",
    });
    expect(snapshot).toMatchObject({
      consoleId: started.console.id,
      speakerId: "admin-1",
      targets: [expect.objectContaining({ bindingId: started.binding.id, sequence: 1 })],
    });
    adapter.sendMessage.mockClear();

    const terminal = {
      captureId: snapshot.captureId,
      snapshot,
      transcript: "First durable transcript 🎙️",
      audioMs: 25,
      forwardedBytes: 33,
      // Package B's integer convenience value is intentionally not billing authority.
      forwardedAudioMs: 1,
      capturedEndedUtc: "2026-08-28T12:00:01.000Z",
      source: "live" as const,
    };
    await expect(persistence.commitCapture(terminal)).resolves.toEqual([
      expect.objectContaining({ bindingId: started.binding.id, sequence: 1, status: "committed" }),
    ]);
    expect(store.getVoiceConsole(started.console.id)).toMatchObject({
      forwardedAudioMs: 1.03125,
      utteranceCount: 1,
      liveFinalCount: 1,
    });
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage.mock.calls[0]?.[1]).toContain("First durable transcript 🎙️");

    await expect(persistence.commitCapture({
      ...terminal,
      transcript: "Late conflicting terminal must lose",
      forwardedBytes: 99,
      forwardedAudioMs: 3,
    })).resolves.toEqual([
      expect.objectContaining({ bindingId: started.binding.id, sequence: 1, status: "committed" }),
    ]);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.getVoiceConsole(started.console.id)).toMatchObject({
      forwardedAudioMs: 1.03125,
      utteranceCount: 1,
    });

    await controller.shutdownAll();
    manager.shutdown();
  });

  it("renders the binding alias inert in the compact thread notice", async () => {
    const { adapter, controller, manager } = setup();
    const result = await controller.start({ ...request, alias: "**Admin**" });
    if (!result.ok) throw new Error(result.error);
    const notice = adapter.sendMessage.mock.calls[0]?.[1] as string;
    expect(notice).toContain("＊＊Admin＊＊");
    expect(notice).not.toContain("**Admin**");

    await controller.shutdownAll();
    manager.shutdown();
  });

  it("names and unwinds a shared Live Help lease conflict without opening transport", async () => {
    leases.acquire({
      kind: "live_help",
      sessionId: "lh-active",
      guildId: "guild-1",
      voiceChannelId: "vc-1",
    });
    const { adapter, controller, manager } = setup();
    const result = await controller.start(request);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain("live_help");
      expect(result.error).toContain("lh-active");
    }
    expect(adapter.sendVoiceConsolePanel).toHaveBeenCalledOnce();
    expect(adapter.createVoiceConsoleTransport).not.toHaveBeenCalled();
    expect(store.listActiveVoiceConsoles()).toHaveLength(0);
    expect(leases.get("guild-1")).toMatchObject({ kind: "live_help", sessionId: "lh-active" });
    manager.shutdown();
  });

  it("retries transient canonical-card edits without ending runtime or releasing the lease", async () => {
    const { adapter, controller, manager } = setup();
    const started = await controller.start(request);
    if (!started.ok) throw new Error(started.error);
    adapter.editVoiceConsolePanel.mockClear();
    let attempts = 0;
    adapter.editVoiceConsolePanel.mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient Discord API failure");
    });

    await expect(controller.refreshCard(started.console.id, true)).resolves.toBeUndefined();
    expect(adapter.editVoiceConsolePanel).toHaveBeenCalledTimes(3);
    expect(store.getVoiceConsole(started.console.id)).toMatchObject({ status: "ready" });
    expect(leases.get("guild-1")).toMatchObject({
      kind: "thread_voice",
      sessionId: started.console.id,
    });

    await controller.shutdownAll();
    manager.shutdown();
  });

  it("reposts only in VC chat, persists the replacement, and disables the old card", async () => {
    const { adapter, controller, manager } = setup();
    const started = await controller.start(request);
    if (!started.ok) throw new Error(started.error);
    adapter.editVoiceConsolePanel.mockClear();
    adapter.sendVoiceConsolePanel.mockResolvedValueOnce({
      channel: { platform: "discord", id: "vc-1" },
      id: "card-2",
    });

    await expect(controller.repostCard(started.console.id)).resolves.toMatchObject({
      channel: { id: "vc-1" },
      id: "card-2",
    });
    expect(store.getVoiceConsole(started.console.id)).toMatchObject({
      cardChannelId: "vc-1",
      cardMessageId: "card-2",
    });
    const oldEdit = adapter.editVoiceConsolePanel.mock.calls.find(
      ([ref]: [{ id: string }]) => ref.id === "card-1"
    );
    expect(oldEdit).toBeDefined();
    expect(oldEdit![1].components.flatMap((row: { components: Array<{ disabled?: boolean }> }) =>
      row.components
    ).every((component: { disabled?: boolean }) => component.disabled)).toBe(true);

    await controller.shutdownAll();
    manager.shutdown();
  });

  it("recreates a deleted canonical card once in the same VC chat during boot recovery", async () => {
    const first = setup();
    const started = await first.controller.start(request);
    if (!started.ok) throw new Error(started.error);
    await first.controller.shutdownAll();
    first.manager.shutdown();

    const exists = vi.fn(async () => true);
    exists.mockResolvedValueOnce(false);
    const recovered = setup({
      voiceConsoleMessageExists: exists,
      sendVoiceConsolePanel: vi.fn(async () => ({
        channel: { platform: "discord", id: "vc-1" },
        id: "card-recovered",
      })),
      editMessage: vi.fn(async () => {}),
    });
    await expect(recovered.manager.reconcileOnBoot({
      aliasFor: () => "One",
      profileFor: () => ({ voice: "Kore", pace: "natural", style: "neutral" }),
    })).resolves.toMatchObject({ reconciled: 1, failures: 0 });
    expect(recovered.adapter.sendVoiceConsolePanel).toHaveBeenCalledWith(
      "vc-1",
      expect.any(Object)
    );
    expect(store.getVoiceConsole(started.console.id)).toMatchObject({
      status: "ready",
      cardChannelId: "vc-1",
      cardMessageId: "card-recovered",
    });
    expect(recovered.adapter.createVoiceConsoleTransport).toHaveBeenCalledOnce();

    await recovered.controller.shutdownAll();
    recovered.manager.shutdown();
  });

  it("fails boot recovery closed when VC-chat permissions were revoked", async () => {
    const first = setup();
    const started = await first.controller.start(request);
    if (!started.ok) throw new Error(started.error);
    await first.controller.shutdownAll();
    first.manager.shutdown();

    const recovered = setup({
      inspectVoiceConsoleChannel: vi.fn(async () => ({
        ok: true as const,
        guildId: "guild-1",
        missingPermissions: ["ReadMessageHistory"],
        initialSpeakers: [],
      })),
    });
    await expect(recovered.manager.reconcileOnBoot({
      aliasFor: () => "One",
      profileFor: () => ({ voice: "Kore", pace: "natural", style: "neutral" }),
    })).resolves.toMatchObject({ reconciled: 0, failures: 1 });
    expect(recovered.adapter.createVoiceConsoleTransport).not.toHaveBeenCalled();
    expect(store.getVoiceConsole(started.console.id)).toMatchObject({ status: "failed" });
    expect(leases.get("guild-1")).toBeUndefined();
    recovered.manager.shutdown();
  });

  it("uses the shared terminal path when the Discord connection cannot recover", async () => {
    const subject = setup();
    const started = await subject.controller.start(request);
    if (!started.ok) throw new Error(started.error);

    subject.loseConnection("Discord voice connection did not recover");
    await vi.waitFor(() => expect(store.getVoiceConsole(started.console.id)).toMatchObject({
      status: "ended",
      endReason: "Discord voice connection did not recover",
    }));
    expect(subject.captureHost.destroy).toHaveBeenCalledOnce();
    expect(leases.get("guild-1")).toBeUndefined();
    subject.manager.shutdown();
  });
});
