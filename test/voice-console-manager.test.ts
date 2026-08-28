import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../packages/core/src/core/session-store.js";
import { VoiceConsoleManager } from "../packages/core/src/core/voice-console/manager.js";
import type {
  ThreadVoiceBinding,
  VoiceConsoleDispatchHost,
  VoiceConsoleRuntimeHost,
  VoiceConsoleSession,
} from "../packages/core/src/core/voice-console/types.js";
import type { ThreadVoiceSession } from "../packages/core/src/core/thread-voice/types.js";
import { VoiceLeaseManager } from "../packages/core/src/core/voice-lease.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const NOW = "2026-08-28T12:00:00.000Z";
const silent = pino({ level: "silent" }) as unknown as Logger;
let dir: string;
let store: SessionStore;
let leases: VoiceLeaseManager;
let host: VoiceConsoleRuntimeHost;
let dispatch: VoiceConsoleDispatchHost;
let manager: VoiceConsoleManager;

function captureIdentity(captureId: string) {
  const identity = store.getVoiceConsoleCaptureIdentity(captureId);
  if (!identity) throw new Error(`missing capture identity ${captureId}`);
  return identity;
}

function createManager(): VoiceConsoleManager {
  return new VoiceConsoleManager({
    store,
    logger: silent,
    host,
    dispatch,
    leases,
    now: () => NOW,
  });
}

function consoleRow(over: Partial<VoiceConsoleSession> = {}): VoiceConsoleSession {
  return {
    id: "tvc_1",
    platform: "discord",
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    ownerUserId: "admin-1",
    ownerName: "Owner",
    status: "ready",
    cardChannelId: "vc-1",
    cardMessageId: null,
    cardPage: 0,
    revision: 1,
    fanoutArmed: false,
    forwardedAudioBytes: 0,
    forwardedAudioMs: 0,
    utteranceCount: 0,
    liveFinalCount: 0,
    unaryFallbackCount: 0,
    droppedCount: 0,
    sttFailureCount: 0,
    createdUtc: NOW,
    updatedUtc: NOW,
    endedUtc: null,
    endReason: null,
    ...over,
  };
}

function binding(id = "bind-a", over: Partial<ThreadVoiceBinding> = {}): ThreadVoiceBinding {
  return {
    id,
    consoleId: "tvc_1",
    platform: "discord",
    channelRef: `thread-${id}`,
    parentRef: "parent-1",
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    ownerUserId: "admin-1",
    ownerName: "Owner",
    status: "active",
    noticeMessageId: null,
    alias: id,
    aliasNormalized: id,
    ttsVoice: "Aoede",
    ttsPace: "normal",
    ttsStyle: null,
    profileUpdatedUtc: NOW,
    outputEnabled: true,
    outputGeneration: 0,
    createdUtc: NOW,
    updatedUtc: NOW,
    endedUtc: null,
    endReason: null,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function seedFiveSelectedBindings(): Promise<void> {
  store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-1") });
  for (const id of ["bind-2", "bind-3", "bind-4", "bind-5"]) {
    const added = await manager.addBinding({
      binding: binding(id, { status: "adding" }),
      claim: false,
      expectedRevision: store.getVoiceConsole("tvc_1")!.revision,
    });
    if (!added.ok) throw new Error(added.error);
  }
  const selected = store.replaceVoiceConsoleInputTargets("tvc_1", {
    bindingIds: ["bind-1", "bind-2", "bind-3", "bind-4", "bind-5"],
    fanoutArmed: true,
    expectedRevision: store.getVoiceConsole("tvc_1")!.revision,
  });
  if (!selected.ok) throw new Error(selected.error);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-voice-console-manager-"));
  store = new SessionStore(path.join(dir, "test.db"));
  leases = new VoiceLeaseManager({ now: () => NOW });
  host = {
    startConsole: vi.fn(async () => ({ ok: true })),
    addBinding: vi.fn(async () => ({ ok: true })),
    reconcileConsole: vi.fn(async () => ({ ok: true })),
    stopConsole: vi.fn(async () => {}),
    stopBinding: vi.fn(async () => {}),
    waitForBindingSpeechIdle: vi.fn(async () => {}),
  };
  dispatch = {
    isBindingBusy: vi.fn(async () => false),
    inspectArtifact: vi.fn(async () => "missing"),
    quarantineArtifact: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {}),
  };
  manager = createManager();
});

afterEach(async () => {
  manager.shutdown();
  await flush();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("VoiceConsoleManager lifecycle", () => {
  it("leases by console id, invokes the platform-neutral host, and marks start ready", async () => {
    const result = await manager.start({
      console: consoleRow({ status: "starting" }),
      binding: binding("bind-a", { status: "adding" }),
    });
    expect(result.ok).toBe(true);
    expect(host.startConsole).toHaveBeenCalledOnce();
    expect(leases.get("guild-1")).toMatchObject({
      kind: "thread_voice",
      sessionId: "tvc_1",
      voiceChannelId: "vc-1",
    });
    expect(store.getVoiceConsole("tvc_1")).toMatchObject({ status: "ready", revision: 2 });
    expect(store.getVoiceConsoleBinding("bind-a")?.status).toBe("active");
  });

  it("upgrades active V1 state before host reconciliation and transfers lease authority", async () => {
    const legacy: ThreadVoiceSession = {
      id: "tv_legacy",
      platform: "discord",
      channelRef: "thread-legacy",
      parentRef: "parent-1",
      guildId: "guild-1",
      voiceChannelId: "vc-1",
      ownerUserId: "admin-1",
      ownerName: "Owner",
      status: "ready",
      noticeMessageId: "notice-1",
      transmittedAudioMs: 0,
      createdUtc: NOW,
      updatedUtc: NOW,
      endedUtc: null,
      endReason: null,
    };
    store.insertThreadVoiceSession(legacy);
    leases.acquire({
      kind: "thread_voice",
      sessionId: legacy.id,
      guildId: legacy.guildId,
      voiceChannelId: legacy.voiceChannelId,
    });
    const result = await manager.reconcileOnBoot({
      aliasFor: () => "Legacy",
      profileFor: () => ({ voice: "Aoede", pace: "normal", style: null }),
    });
    expect(result).toMatchObject({ upgraded: 1, reconciled: 1, failures: 0 });
    const active = store.getActiveVoiceConsoleForGuild("guild-1");
    expect(active?.id).toMatch(/^tvc_/);
    expect(leases.get("guild-1")?.sessionId).toBe(active?.id);
    expect(host.reconcileConsole).toHaveBeenCalledWith(
      expect.objectContaining({ id: active?.id }),
      [expect.objectContaining({ id: "tv_legacy", status: "active" })]
    );
  });

  it.each(["structured", "thrown"] as const)(
    "cleans a partially-created boot runtime when reconciliation returns %s failure",
    async (failureKind) => {
      store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
      vi.mocked(host.reconcileConsole).mockImplementationOnce(async () => {
        if (failureKind === "thrown") throw new Error("partial runtime failed");
        return { ok: false, reason: "partial runtime failed" };
      });
      const result = await manager.reconcileOnBoot({
        aliasFor: () => "unused",
        profileFor: () => ({ voice: "Aoede", pace: null, style: null }),
      });
      expect(result).toMatchObject({ reconciled: 0, failures: 1 });
      expect(host.stopConsole).toHaveBeenCalledOnce();
      expect(host.stopConsole).toHaveBeenCalledWith("tvc_1", "partial runtime failed");
      expect(store.getVoiceConsole("tvc_1")).toMatchObject({
        status: "failed",
        endReason: "partial runtime failed",
      });
      expect(leases.get("guild-1")).toBeUndefined();
    }
  );

  it("still terminalizes and releases boot state when partial-runtime cleanup throws", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    vi.mocked(host.reconcileConsole).mockRejectedValueOnce(new Error("primary reconcile failure"));
    vi.mocked(host.stopConsole).mockRejectedValueOnce(new Error("cleanup failure"));
    const result = await manager.reconcileOnBoot({
      aliasFor: () => "unused",
      profileFor: () => ({ voice: "Aoede", pace: null, style: null }),
    });
    expect(result).toMatchObject({ reconciled: 0, failures: 1 });
    expect(host.stopConsole).toHaveBeenCalledOnce();
    expect(store.getVoiceConsole("tvc_1")).toMatchObject({
      status: "failed",
      endReason: "primary reconcile failure",
    });
    expect(leases.get("guild-1")).toBeUndefined();
  });

  it("activates a hosted binding before claiming it and returns capture-ready state", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    vi.mocked(host.addBinding).mockImplementationOnce(async (_console, added) => {
      expect(added.status).toBe("adding");
      expect(store.listVoiceConsoleInputTargets("tvc_1").map((row) => row.bindingId)).toEqual([
        "bind-a",
      ]);
      return { ok: true };
    });
    const result = await manager.addBinding({
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: true,
      expectedRevision: 1,
      interactionId: "add-bind-b",
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.bindings.find((row) => row.id === "bind-b")?.status).toBe("active");
    expect(result.value.targets.map((row) => row.bindingId)).toEqual(["bind-b"]);
    expect(
      manager.allocateCapture({
        consoleId: "tvc_1",
        speakerId: "speaker-1",
        speakerName: "Speaker",
        captureId: "capture-new-binding",
      })?.assignments
    ).toEqual([expect.objectContaining({ bindingId: "bind-b", sequence: 1 })]);
  });

  it("restores the prior input target when host attachment fails after default claim", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    vi.mocked(host.addBinding).mockResolvedValueOnce({ ok: false, reason: "attach failed" });
    await expect(
      manager.addBinding({
        binding: binding("bind-b", { status: "adding", alias: "Beta" }),
        claim: true,
        expectedRevision: 1,
        interactionId: "add-bind-b-failed",
      })
    ).rejects.toThrow("attach failed");
    expect(store.listVoiceConsoleInputTargets("tvc_1").map((row) => row.bindingId)).toEqual([
      "bind-a",
    ]);
    expect(store.getVoiceConsoleBinding("bind-b")?.status).toBe("failed");
    expect(
      manager.allocateCapture({
        consoleId: "tvc_1",
        speakerId: "speaker-1",
        speakerName: "Speaker",
        captureId: "capture-after-failed-add",
      })?.assignments
    ).toEqual([expect.objectContaining({ bindingId: "bind-a" })]);
  });

  it("rejects a sixth claimed fan-out binding before host attach without leaking staged state", async () => {
    await seedFiveSelectedBindings();
    vi.mocked(host.addBinding).mockClear();
    vi.mocked(host.stopBinding).mockClear();
    const priorTargets = store.listVoiceConsoleInputTargets("tvc_1").map((row) => row.bindingId);

    const result = await manager.addBinding({
      binding: binding("bind-6", { status: "adding" }),
      claim: true,
      expectedRevision: store.getVoiceConsole("tvc_1")!.revision,
      interactionId: "add-sixth-claimed",
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid-targets",
      error: "Voice Console fan-out target limit is five.",
    });
    expect(host.addBinding).not.toHaveBeenCalled();
    expect(host.stopBinding).not.toHaveBeenCalled();
    expect(store.getVoiceConsoleBinding("bind-6")).toBeNull();
    expect(store.listVoiceConsoleInputTargets("tvc_1").map((row) => row.bindingId)).toEqual(
      priorTargets
    );
  });

  it("terminalizes and detaches once when activation throws after host attach", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    const activation = vi
      .spyOn(store, "activateVoiceConsoleBinding")
      .mockImplementationOnce(() => {
        throw new Error("activation exploded");
      });

    await expect(
      manager.addBinding({
        binding: binding("bind-b", { status: "adding", alias: "Beta" }),
        claim: true,
        expectedRevision: 1,
      })
    ).rejects.toThrow("activation exploded");

    activation.mockRestore();
    expect(host.stopBinding).toHaveBeenCalledOnce();
    expect(host.stopBinding).toHaveBeenCalledWith("bind-b", "activation exploded");
    expect(store.getVoiceConsoleBinding("bind-b")?.status).toBe("failed");
    expect(store.listVoiceConsoleInputTargets("tvc_1").map((row) => row.bindingId)).toEqual([
      "bind-a",
    ]);
  });

  it("terminalizes and detaches once when activation loses a revision race", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    vi.mocked(host.addBinding).mockImplementationOnce(async () => {
      const raced = store.replaceVoiceConsoleInputTargets("tvc_1", {
        bindingIds: ["bind-a"],
        fanoutArmed: false,
        expectedRevision: 2,
      });
      if (!raced.ok) throw new Error(raced.error);
      return { ok: true };
    });

    await expect(
      manager.addBinding({
        binding: binding("bind-b", { status: "adding", alias: "Beta" }),
        claim: true,
        expectedRevision: 1,
      })
    ).rejects.toThrow("Console changed; refresh.");

    expect(host.stopBinding).toHaveBeenCalledOnce();
    expect(host.stopBinding).toHaveBeenCalledWith("bind-b", "Console changed; refresh.");
    expect(store.getVoiceConsoleBinding("bind-b")?.status).toBe("failed");
    expect(store.listVoiceConsoleInputTargets("tvc_1").map((row) => row.bindingId)).toEqual([
      "bind-a",
    ]);
  });

  it("terminalizes a staged binding and preserves targets when host attach throws", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    vi.mocked(host.addBinding).mockRejectedValueOnce(new Error("attach exploded"));

    await expect(
      manager.addBinding({
        binding: binding("bind-b", { status: "adding", alias: "Beta" }),
        claim: true,
        expectedRevision: 1,
      })
    ).rejects.toThrow("attach exploded");

    expect(host.stopBinding).toHaveBeenCalledOnce();
    expect(host.stopBinding).toHaveBeenCalledWith("bind-b", "attach exploded");
    expect(store.getVoiceConsoleBinding("bind-b")?.status).toBe("failed");
    expect(store.listVoiceConsoleInputTargets("tvc_1").map((row) => row.bindingId)).toEqual([
      "bind-a",
    ]);
  });

  it("keeps the original activation error and terminal state when detach cleanup throws", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    const activation = vi
      .spyOn(store, "activateVoiceConsoleBinding")
      .mockImplementationOnce(() => {
        throw new Error("activation invariant failed");
      });
    vi.mocked(host.stopBinding).mockRejectedValueOnce(new Error("detach cleanup failed"));

    await expect(
      manager.addBinding({
        binding: binding("bind-b", { status: "adding", alias: "Beta" }),
        claim: true,
        expectedRevision: 1,
        interactionId: "cleanup-stop-failed",
      })
    ).rejects.toThrow("activation invariant failed");

    activation.mockRestore();
    await expect(
      manager.addBinding({
        binding: binding("bind-b", { status: "adding", alias: "Beta" }),
        claim: true,
        expectedRevision: 1,
        interactionId: "cleanup-stop-failed",
      })
    ).rejects.toThrow("activation invariant failed");
    expect(host.stopBinding).toHaveBeenCalledOnce();
    expect(host.addBinding).toHaveBeenCalledOnce();
    expect(store.getVoiceConsoleBinding("bind-b")?.status).toBe("failed");
    expect(store.getVoiceConsoleAddInteraction("tvc_1", "cleanup-stop-failed")).toMatchObject({
      status: "failed",
      failureCode: "activation-failed",
      failureMessage: "activation invariant failed",
    });
    expect(store.listVoiceConsoleInputTargets("tvc_1").map((row) => row.bindingId)).toEqual([
      "bind-a",
    ]);
  });

  it("falls back to direct terminalization without masking the original activation error", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    const activation = vi
      .spyOn(store, "activateVoiceConsoleBinding")
      .mockImplementationOnce(() => {
        throw new Error("activation remains authoritative");
      });
    const terminalization = vi
      .spyOn(store, "failStagedVoiceConsoleBinding")
      .mockImplementationOnce(() => {
        throw new Error("atomic cleanup failed");
      });

    await expect(
      manager.addBinding({
        binding: binding("bind-b", { status: "adding", alias: "Beta" }),
        claim: true,
        expectedRevision: 1,
      })
    ).rejects.toThrow("activation remains authoritative");

    activation.mockRestore();
    terminalization.mockRestore();
    expect(host.stopBinding).toHaveBeenCalledOnce();
    expect(store.getVoiceConsoleBinding("bind-b")?.status).toBe("failed");
    expect(store.listVoiceConsoleInputTargets("tvc_1").map((row) => row.bindingId)).toEqual([
      "bind-a",
    ]);
  });

  it("allows a sixth unclaimed binding to activate without changing five selected targets", async () => {
    await seedFiveSelectedBindings();
    vi.mocked(host.addBinding).mockClear();
    vi.mocked(host.stopBinding).mockClear();
    const priorTargets = store.listVoiceConsoleInputTargets("tvc_1").map((row) => row.bindingId);

    const result = await manager.addBinding({
      binding: binding("bind-6", { status: "adding" }),
      claim: false,
      expectedRevision: store.getVoiceConsole("tvc_1")!.revision,
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.value.bindings.find((row) => row.id === "bind-6")?.status).toBe("active");
    expect(result.value.targets.map((row) => row.bindingId)).toEqual(priorTargets);
    expect(host.addBinding).toHaveBeenCalledOnce();
    expect(host.stopBinding).not.toHaveBeenCalled();
    expect(
      manager.allocateCapture({
        consoleId: "tvc_1",
        speakerId: "speaker-1",
        speakerName: "Speaker",
        captureId: "capture-five-targets",
      })?.assignments.map((assignment) => assignment.bindingId)
    ).toEqual(priorTargets);
  });

  it("replays a thrown host failure without repeating host add or cleanup", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    vi.mocked(host.addBinding).mockRejectedValueOnce(new Error("attach exploded"));
    const input = {
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: true,
      expectedRevision: 1,
      interactionId: "same-add-thrown",
    };

    await expect(manager.addBinding(input)).rejects.toThrow("attach exploded");
    await expect(manager.addBinding(input)).rejects.toThrow("attach exploded");

    expect(host.addBinding).toHaveBeenCalledOnce();
    expect(host.stopBinding).toHaveBeenCalledOnce();
    expect(store.getVoiceConsoleBinding("bind-b")?.status).toBe("failed");
    expect(store.getVoiceConsoleAddInteraction("tvc_1", "same-add-thrown")).toMatchObject({
      status: "failed",
      failureCode: "host-attach-failed",
      failureMessage: "attach exploded",
      failureAsException: true,
    });
  });

  it("replays a structured host failure without repeating host add or cleanup", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    vi.mocked(host.addBinding).mockResolvedValueOnce({ ok: false, reason: "host refused attach" });
    const input = {
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: true,
      expectedRevision: 1,
      interactionId: "same-add-structured",
    };

    await expect(manager.addBinding(input)).rejects.toThrow("host refused attach");
    await expect(manager.addBinding(input)).rejects.toThrow("host refused attach");

    expect(host.addBinding).toHaveBeenCalledOnce();
    expect(host.stopBinding).toHaveBeenCalledOnce();
    expect(store.getVoiceConsoleAddInteraction("tvc_1", "same-add-structured")).toMatchObject({
      status: "failed",
      failureCode: "host-attach-failed",
    });
  });

  it("replays activation failure without repeating host add or cleanup", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    vi.spyOn(store, "activateVoiceConsoleBinding").mockReturnValueOnce({
      ok: false,
      reason: "stale-revision",
      error: "activation lost its revision",
    });
    const input = {
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: true,
      expectedRevision: 1,
      interactionId: "same-add-activation",
    };

    await expect(manager.addBinding(input)).rejects.toThrow("activation lost its revision");
    await expect(manager.addBinding(input)).rejects.toThrow("activation lost its revision");

    expect(host.addBinding).toHaveBeenCalledOnce();
    expect(host.stopBinding).toHaveBeenCalledOnce();
    expect(store.getVoiceConsoleAddInteraction("tvc_1", "same-add-activation")).toMatchObject({
      status: "failed",
      failureCode: "stale-revision",
      failureAsException: true,
    });
  });

  it("replays a successful add without repeating host attachment", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    const input = {
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: true,
      expectedRevision: 1,
      interactionId: "same-add-success",
    };

    const first = await manager.addBinding(input);
    const replay = await manager.addBinding(input);

    expect(first.ok && first.value).toMatchObject({ applied: true, duplicate: false });
    expect(replay.ok && replay.value).toMatchObject({ applied: false, duplicate: true });
    expect(host.addBinding).toHaveBeenCalledOnce();
    expect(host.stopBinding).not.toHaveBeenCalled();
    expect(store.getVoiceConsoleAddInteraction("tvc_1", "same-add-success")?.status).toBe(
      "succeeded"
    );
  });

  it("fails a concurrent pending duplicate closed without double-attaching", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    const attachment = deferred<{ ok: true }>();
    vi.mocked(host.addBinding).mockImplementationOnce(async () => attachment.promise);
    const input = {
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: true,
      expectedRevision: 1,
      interactionId: "same-add-pending",
    };

    const first = manager.addBinding(input);
    await flush();
    expect(await manager.addBinding(input)).toEqual({
      ok: false,
      reason: "interaction-pending",
      error: "Voice Console binding add is already in progress.",
      duplicate: true,
    });
    expect(host.addBinding).toHaveBeenCalledOnce();

    attachment.resolve({ ok: true });
    const completed = await first;
    expect(completed.ok && completed.value).toMatchObject({ applied: true, duplicate: false });
    expect(host.addBinding).toHaveBeenCalledOnce();
    expect(host.stopBinding).not.toHaveBeenCalled();
  });

  it("replays durable failed and succeeded outcomes after reopening the store", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    vi.mocked(host.addBinding).mockRejectedValueOnce(new Error("persisted attach failure"));
    const failedInput = {
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: true,
      expectedRevision: 1,
      interactionId: "persisted-add-failed",
    };
    await expect(manager.addBinding(failedInput)).rejects.toThrow("persisted attach failure");
    const succeededInput = {
      binding: binding("bind-c", { status: "adding", alias: "Gamma" }),
      claim: false,
      expectedRevision: store.getVoiceConsole("tvc_1")!.revision,
      interactionId: "persisted-add-succeeded",
    };
    const succeeded = await manager.addBinding(succeededInput);
    if (!succeeded.ok) throw new Error(succeeded.error);

    manager.shutdown();
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    manager = createManager();

    await expect(manager.addBinding(failedInput)).rejects.toThrow("persisted attach failure");
    const successReplay = await manager.addBinding(succeededInput);
    expect(successReplay.ok && successReplay.value).toMatchObject({
      applied: false,
      duplicate: true,
    });
    expect(host.addBinding).toHaveBeenCalledTimes(2);
    expect(host.stopBinding).toHaveBeenCalledOnce();
  });

  it("rejects interaction id collisions with a different add input or action", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    const input = {
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: false,
      expectedRevision: 1,
      interactionId: "colliding-add",
    };
    const first = await manager.addBinding(input);
    if (!first.ok) throw new Error(first.error);

    expect(await manager.addBinding({ ...input, claim: true })).toEqual({
      ok: false,
      reason: "interaction-collision",
      error: "Interaction ID is already used by a different Voice Console action or input.",
    });
    expect(() =>
      store.replaceVoiceConsoleInputTargets("tvc_1", {
        bindingIds: ["bind-a"],
        fanoutArmed: false,
        expectedRevision: store.getVoiceConsole("tvc_1")!.revision,
        interactionId: "colliding-add",
      })
    ).toThrow("Interaction ID is already used by a different Voice Console action or input.");
    expect(host.addBinding).toHaveBeenCalledOnce();
  });

  it("recovers a stale pending add on boot and replays its durable failure", async () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    const input = {
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: true,
      expectedRevision: 1,
      interactionId: "pending-across-boot",
    };
    const staged = store.addVoiceConsoleBinding(input);
    expect(staged.ok && staged.value.applied).toBe(true);
    expect(store.getVoiceConsoleBinding("bind-b")?.status).toBe("adding");

    await manager.reconcileOnBoot({
      aliasFor: () => "unused",
      profileFor: () => ({ voice: "Aoede", pace: null, style: null }),
    });

    expect(store.getVoiceConsoleBinding("bind-b")?.status).toBe("failed");
    expect(store.getVoiceConsoleAddInteraction("tvc_1", "pending-across-boot")).toMatchObject({
      status: "failed",
      failureCode: "recovered-pending",
      failureAsException: false,
    });
    expect(await manager.addBinding(input)).toEqual({
      ok: false,
      reason: "recovered-pending",
      error: "Voice Console binding add was interrupted before completion.",
      duplicate: true,
      replayAsException: false,
    });
    expect(host.addBinding).not.toHaveBeenCalled();
  });

  it.each(["capturing", "finalizing"] as const)(
    "terminalizes a pre-crash %s reservation once so the next sequence can release",
    async (state) => {
      store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
      const first = manager.allocateCapture({
        consoleId: "tvc_1",
        speakerId: "speaker-1",
        speakerName: "First",
        captureId: `capture-${state}-1`,
      });
      if (state === "finalizing") {
        (store as SessionStore & {
          markVoiceConsoleCaptureFinalizing(captureId: string, updatedUtc?: string): number;
        }).markVoiceConsoleCaptureFinalizing(first!.captureId, NOW);
      }
      manager.allocateCapture({
        consoleId: "tvc_1",
        speakerId: "speaker-2",
        speakerName: "Second",
        captureId: `capture-${state}-2`,
      });
      manager.commitCapture({
        ...captureIdentity(`capture-${state}-2`),
        speakerId: "speaker-2",
        speakerName: "Second",
        transcript: "second survives restart",
        audioMs: 500,
        forwardedAudioMs: 500,
        capturedEndedUtc: NOW,
        speakerAuthorized: true,
      });
      vi.mocked(dispatch.isBindingBusy).mockResolvedValue(true);
      await manager.reconcileOnBoot({
        aliasFor: () => "unused",
        profileFor: () => ({ voice: "Aoede", pace: null, style: null }),
      });
      await flush();
      await manager.reconcileOnBoot({
        aliasFor: () => "unused",
        profileFor: () => ({ voice: "Aoede", pace: null, style: null }),
      });
      expect(store.listVoiceConsoleSegments("bind-a")[0]).toMatchObject({
        state: "capture_dropped",
        transcript: "",
        error: "process restarted before capture finalization",
      });
      expect(store.getVoiceConsole("tvc_1")?.droppedCount).toBe(1);
      vi.mocked(dispatch.isBindingBusy).mockResolvedValue(false);
      expect(await manager.releaseIfIdle("bind-a")).toBe(true);
      expect(dispatch.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ authorId: "speaker-2", prompt: expect.stringContaining("second survives") })
      );
    }
  );
});

describe("VoiceConsoleManager dispatch and barriers", () => {
  beforeEach(() => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding() });
  });

  it("fans out one actual speaker into independent authenticated dispatches", async () => {
    const added = await manager.addBinding({
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: false,
      expectedRevision: 1,
    });
    if (!added.ok) throw new Error(added.error);
    const selected = store.replaceVoiceConsoleInputTargets("tvc_1", {
      bindingIds: ["bind-a", "bind-b"],
      fanoutArmed: true,
      expectedRevision: added.value.console.revision,
    });
    if (!selected.ok) throw new Error(selected.error);
    const capture = manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-7",
      speakerName: "Actual Speaker",
      captureId: "capture-fanout",
    });
    expect(capture?.assignments).toHaveLength(2);
    manager.commitCapture({
      ...captureIdentity("capture-fanout"),
      speakerId: "speaker-7",
      speakerName: "Actual Speaker",
      transcript: "fan this out",
      audioMs: 800,
      forwardedAudioMs: 800,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    await Promise.all([manager.releaseIfIdle("bind-a"), manager.releaseIfIdle("bind-b")]);
    expect(dispatch.enqueue).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dispatch.enqueue).mock.calls.map(([request]) => request)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "thread-bind-a",
          authorId: "speaker-7",
          authorName: "Actual Speaker",
          consoleId: "tvc_1",
          bindingId: "bind-a",
        }),
        expect.objectContaining({ target: "thread-bind-b", bindingId: "bind-b" }),
      ])
    );
  });

  it("exposes a capture-scoped terminal drop that cannot be replaced by a late commit", () => {
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      captureId: "capture-manager-drop",
    });
    const dropped = manager.dropCapture({
      ...captureIdentity("capture-manager-drop"),
      reason: "input off",
      capturedEndedUtc: NOW,
      audioMs: 250,
      forwardedAudioMs: 200,
      outcome: "dropped",
      resultSource: "live",
    });
    const late = manager.commitCapture({
      ...captureIdentity("capture-manager-drop"),
      speakerId: "speaker-1",
      speakerName: "Speaker",
      transcript: "late transcript",
      audioMs: 900,
      forwardedAudioMs: 900.5,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
      resultSource: "unary",
    });
    expect(dropped).toMatchObject({
      duplicate: false,
      terminal: { outcome: "dropped", reason: "input off", audioMs: 250, forwardedAudioMs: 200 },
    });
    expect(late).toMatchObject({
      duplicate: true,
      terminal: { outcome: "dropped", reason: "input off", audioMs: 250, forwardedAudioMs: 200 },
    });
    expect(late.committed).toEqual([]);
    expect(store.getVoiceConsole("tvc_1")?.forwardedAudioMs).toBe(200);
  });

  it("releases pending voice after an origin-agnostic visible binding turn settles", async () => {
    vi.mocked(dispatch.isBindingBusy).mockResolvedValue(true);
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      captureId: "capture-after-handoff",
    });
    manager.commitCapture({
      ...captureIdentity("capture-after-handoff"),
      speakerId: "speaker-1",
      speakerName: "Speaker",
      transcript: "wait behind visible generic work",
      audioMs: 500,
      forwardedAudioMs: 500,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    await manager.releaseIfIdle("bind-a");
    expect(dispatch.enqueue).not.toHaveBeenCalled();

    vi.mocked(dispatch.isBindingBusy).mockResolvedValue(false);
    expect(await manager.markBindingActivitySettled("bind-a")).toBe(true);
    expect(dispatch.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: "bind-a", authorId: "speaker-1" })
    );
  });

  it("linearizes discard against an in-flight artifact inspection", async () => {
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      captureId: "capture-1",
    });
    manager.commitCapture({
      ...captureIdentity("capture-1"),
      speakerId: "speaker-1",
      speakerName: "Speaker",
      transcript: "discard me",
      audioMs: 500,
      forwardedAudioMs: 500,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    const inspection = deferred<"missing">();
    vi.mocked(dispatch.inspectArtifact)
      .mockImplementationOnce(async () => inspection.promise)
      .mockResolvedValue("missing");
    const releasing = manager.releaseIfIdle("bind-a");
    await flush();
    expect(dispatch.inspectArtifact).toHaveBeenCalledOnce();

    const removing = manager.removeBinding("bind-a", {
      expectedRevision: 1,
      discardPending: true,
      reason: "test removal",
    });
    await flush();
    inspection.resolve("missing");
    await releasing;
    const result = await removing;
    expect(result).toEqual({ ok: true, discarded: 1, consoleEnded: true });
    expect(dispatch.enqueue).not.toHaveBeenCalled();
    expect(store.listVoiceConsoleSegments("bind-a")[0]).toMatchObject({
      state: "discarded",
      transcript: "",
    });
    expect(store.getVoiceConsole("tvc_1")?.status).toBe("ended");
    expect(leases.get("guild-1")).toBeUndefined();
  });

  it("requeues an artifact-free claimed batch across preserve removal and enqueues once", async () => {
    await manager.addBinding({
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: false,
      expectedRevision: 1,
    });
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      captureId: "capture-preserve-remove",
    });
    manager.commitCapture({
      ...captureIdentity("capture-preserve-remove"),
      speakerId: "speaker-1",
      speakerName: "Speaker",
      transcript: "preserve through remove",
      audioMs: 500,
      forwardedAudioMs: 500,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    const inspection = deferred<"missing">();
    vi.mocked(dispatch.inspectArtifact)
      .mockImplementationOnce(async () => inspection.promise)
      .mockResolvedValue("missing");
    const releasing = manager.releaseIfIdle("bind-a");
    await flush();
    const removing = manager.removeBinding("bind-a", {
      expectedRevision: store.getVoiceConsole("tvc_1")!.revision,
      discardPending: false,
      reason: "preserve removal",
    });
    await flush();
    inspection.resolve("missing");
    await releasing;
    expect(await removing).toEqual({ ok: true, discarded: 0, consoleEnded: false });
    expect(dispatch.enqueue).toHaveBeenCalledTimes(1);
    expect(store.listVoiceConsoleSegments("bind-a")[0]).toMatchObject({ state: "dispatched" });
  });

  it("requeues an artifact-free claimed batch across preserve stop and enqueues once", async () => {
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      captureId: "capture-preserve-stop",
    });
    manager.commitCapture({
      ...captureIdentity("capture-preserve-stop"),
      speakerId: "speaker-1",
      speakerName: "Speaker",
      transcript: "preserve through stop",
      audioMs: 500,
      forwardedAudioMs: 500,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    const inspection = deferred<"missing">();
    vi.mocked(dispatch.inspectArtifact)
      .mockImplementationOnce(async () => inspection.promise)
      .mockResolvedValue("missing");
    const releasing = manager.releaseIfIdle("bind-a");
    await flush();
    const stopping = manager.stopConsole("tvc_1", {
      expectedRevision: 1,
      discardPending: false,
      reason: "preserve stop",
    });
    await flush();
    inspection.resolve("missing");
    await releasing;
    expect(await stopping).toEqual({ ok: true, discarded: 0 });
    expect(dispatch.enqueue).toHaveBeenCalledTimes(1);
    expect(store.listVoiceConsoleSegments("bind-a")[0]).toMatchObject({ state: "dispatched" });
  });

  it.each(["pending", "running", "done"] as const)(
    "preserve stop retains a %s artifact without replacement enqueue",
    async (artifactState) => {
      manager.allocateCapture({
        consoleId: "tvc_1",
        speakerId: "speaker-1",
        speakerName: "Speaker",
        captureId: `capture-owned-${artifactState}`,
      });
      manager.commitCapture({
        ...captureIdentity(`capture-owned-${artifactState}`),
        speakerId: "speaker-1",
        speakerName: "Speaker",
        transcript: `owned by ${artifactState}`,
        audioMs: 500,
        forwardedAudioMs: 500,
        capturedEndedUtc: NOW,
        speakerAuthorized: true,
      });
      const inspection = deferred<typeof artifactState>();
      vi.mocked(dispatch.inspectArtifact)
        .mockImplementationOnce(async () => inspection.promise)
        .mockResolvedValue(artifactState);
      const releasing = manager.releaseIfIdle("bind-a");
      await flush();
      const stopping = manager.stopConsole("tvc_1", {
        expectedRevision: 1,
        discardPending: false,
        reason: `preserve ${artifactState}`,
      });
      await flush();
      inspection.resolve(artifactState);
      await releasing;
      expect(await stopping).toEqual({ ok: true, discarded: 0 });
      expect(dispatch.enqueue).not.toHaveBeenCalled();
      expect(store.listVoiceConsoleSegments("bind-a")[0]).toMatchObject({
        state: "dispatched",
        dispatchId: expect.stringMatching(/^tvd_/),
        transcript: `owned by ${artifactState}`,
      });
    }
  );

  it("replays a durable binding removal after reopen without repeating host teardown", async () => {
    const added = await manager.addBinding({
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: false,
      expectedRevision: 1,
    });
    if (!added.ok) throw new Error(added.error);
    const expectedRevision = added.value.console.revision;
    const first = await manager.removeBinding("bind-a", {
      expectedRevision,
      interactionId: "remove-interaction-1",
      reason: "owner removed binding",
    });
    expect(first).toEqual({ ok: true, discarded: 0, consoleEnded: false });
    expect(host.stopBinding).toHaveBeenCalledOnce();

    manager.shutdown();
    const dbPath = path.join(dir, "test.db");
    store.close();
    store = new SessionStore(dbPath);
    manager = createManager();
    const replay = await manager.removeBinding("bind-a", {
      expectedRevision,
      interactionId: "remove-interaction-1",
      reason: "owner removed binding",
    });
    expect(replay).toEqual({
      ok: true,
      discarded: 0,
      consoleEnded: false,
      duplicate: true,
    });
    expect(host.stopBinding).toHaveBeenCalledOnce();
    expect(
      await manager.removeBinding("bind-b", {
        expectedRevision: store.getVoiceConsole("tvc_1")!.revision,
        interactionId: "remove-interaction-1",
        reason: "owner removed binding",
      })
    ).toEqual({
      ok: false,
      error: "Interaction ID is already used by a different Voice Console action or input.",
    });
    expect(
      await manager.removeBinding("bind-a", {
        expectedRevision,
        discardPending: true,
        interactionId: "remove-interaction-1",
        reason: "owner removed binding",
      })
    ).toEqual({
      ok: false,
      error: "Interaction ID is already used by a different Voice Console action or input.",
    });
    expect(store.getVoiceConsoleBinding("bind-b")?.status).toBe("active");
    expect(host.stopBinding).toHaveBeenCalledOnce();
  });

  it("rejects a remove interaction collision without changing binding or host state", async () => {
    const selected = store.replaceVoiceConsoleInputTargets("tvc_1", {
      bindingIds: ["bind-a"],
      fanoutArmed: true,
      expectedRevision: 1,
      interactionId: "collision-interaction",
    });
    if (!selected.ok) throw new Error(selected.error);
    const result = await manager.removeBinding("bind-a", {
      expectedRevision: selected.value.console.revision,
      interactionId: "collision-interaction",
    });
    expect(result).toEqual({
      ok: false,
      error: "Interaction ID is already used by a different Voice Console action or input.",
    });
    expect(store.getVoiceConsoleBinding("bind-a")?.status).toBe("active");
    expect(host.stopBinding).not.toHaveBeenCalled();
  });

  it("replays the exact stop interaction idempotently without stopping the host twice", async () => {
    const first = await manager.stopConsole("tvc_1", {
      expectedRevision: 1,
      interactionId: "stop-interaction-1",
      reason: "owner stopped",
    });
    expect(first).toEqual({ ok: true, discarded: 0 });
    const replay = await manager.stopConsole("tvc_1", {
      expectedRevision: 1,
      interactionId: "stop-interaction-1",
      reason: "owner stopped",
    });
    expect(replay).toEqual({ ok: true, discarded: 0, duplicate: true });
    expect(host.stopConsole).toHaveBeenCalledOnce();
    expect(
      await manager.stopConsole("tvc_1", {
        expectedRevision: 1,
        discardPending: true,
        interactionId: "stop-interaction-1",
        reason: "owner stopped",
      })
    ).toEqual({
      ok: false,
      error: "Interaction ID is already used by a different Voice Console action or input.",
    });
    expect(host.stopConsole).toHaveBeenCalledOnce();
    expect(
      await manager.stopConsole("tvc_1", {
        expectedRevision: 1,
        interactionId: "stop-interaction-2",
      })
    ).toEqual({ ok: false, error: "Voice Console has already ended." });
  });

  it("re-enqueues a missing dispatched artifact once and recognizes existing artifacts", async () => {
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      captureId: "capture-dispatched-recovery",
    });
    manager.commitCapture({
      ...captureIdentity("capture-dispatched-recovery"),
      speakerId: "speaker-1",
      speakerName: "Speaker",
      transcript: "recover stable dispatch",
      audioMs: 500,
      forwardedAudioMs: 500,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    const batch = store.claimPendingVoiceConsoleBatch("bind-a", "dispatch-stable");
    expect(batch).not.toBeNull();
    store.markThreadVoiceBatchDispatched("dispatch-stable", NOW);
    let artifact: "missing" | "pending" | "done" = "missing";
    vi.mocked(dispatch.inspectArtifact).mockImplementation(async () => artifact);
    vi.mocked(dispatch.enqueue).mockImplementation(async () => {
      artifact = "pending";
    });

    expect(await manager.recoverDispatches()).toEqual({ enqueued: 1, found: 0, failures: 0 });
    expect(dispatch.enqueue).toHaveBeenCalledOnce();
    manager.shutdown();
    manager = new VoiceConsoleManager({ store, logger: silent, host, dispatch, leases, now: () => NOW });
    expect(await manager.recoverDispatches()).toEqual({ enqueued: 0, found: 1, failures: 0 });
    expect(dispatch.enqueue).toHaveBeenCalledOnce();

    artifact = "done";
    manager.shutdown();
    manager = new VoiceConsoleManager({ store, logger: silent, host, dispatch, leases, now: () => NOW });
    expect(await manager.recoverDispatches()).toEqual({ enqueued: 0, found: 1, failures: 0 });
    expect(dispatch.enqueue).toHaveBeenCalledOnce();
  });

  it("linearizes quarantine while a claimed batch is awaiting artifact inspection", async () => {
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-bad",
      speakerName: "Bad attribution",
      captureId: "capture-quarantine-race",
      capturedStartedUtc: NOW,
    });
    manager.commitCapture({
      ...captureIdentity("capture-quarantine-race"),
      speakerName: "Bad attribution",
      transcript: "must never enqueue",
      audioMs: 100,
      forwardedAudioMs: 50,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
      resultSource: "live",
    });
    const inspection = deferred<"missing">();
    vi.mocked(dispatch.inspectArtifact).mockImplementationOnce(async () => inspection.promise);
    const releasing = manager.releaseIfIdle("bind-a");
    await flush();
    expect(store.listVoiceConsoleSegments("bind-a")[0]).toMatchObject({
      state: "batched",
      transcript: "must never enqueue",
    });
    store.quarantineVoiceConsoleCapture("capture-quarantine-race", "identity changed", NOW);
    expect(store.getVoiceConsoleBatch(store.listVoiceConsoleSegments("bind-a")[0]!.dispatchId!)).toBeNull();
    inspection.resolve("missing");

    expect(await releasing).toBe(false);
    expect(dispatch.enqueue).not.toHaveBeenCalled();
    expect(store.listVoiceConsoleSegments("bind-a")[0]).toMatchObject({
      state: "capture_dropped",
      transcript: "",
      error: expect.stringContaining("invalid legacy capture identity"),
    });
    expect(store.listVoiceConsoleQuarantinedDispatches()).toEqual([]);
  });

  it("terminalizes an artifact-free quarantined batch without creating an artifact", async () => {
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-bad",
      speakerName: "Bad attribution",
      captureId: "capture-quarantine-missing",
      capturedStartedUtc: NOW,
    });
    manager.commitCapture({
      ...captureIdentity("capture-quarantine-missing"),
      speakerName: "Bad attribution",
      transcript: "artifact free",
      audioMs: 100,
      forwardedAudioMs: 50,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    expect(store.claimPendingVoiceConsoleBatch("bind-a", "dispatch-quarantine-missing")).not.toBeNull();
    store.quarantineVoiceConsoleCapture("capture-quarantine-missing", "invalid target", NOW);
    vi.mocked(dispatch.inspectArtifact).mockResolvedValue("missing");

    expect(await manager.recoverQuarantinedDispatches()).toEqual({
      resolved: 1,
      blocked: 0,
      failures: 0,
    });
    expect(dispatch.enqueue).not.toHaveBeenCalled();
    expect(dispatch.quarantineArtifact).not.toHaveBeenCalled();
    expect(store.listVoiceConsoleSegments("bind-a")[0]).toMatchObject({
      state: "capture_dropped",
      transcript: "",
    });
    expect(store.listVoiceConsoleQuarantinedDispatches({ includeReconciled: true })).toEqual([
      expect.objectContaining({
        dispatchId: "dispatch-quarantine-missing",
        artifactState: "missing",
        reconciledUtc: NOW,
      }),
    ]);
    expect(await manager.recoverDispatches()).toEqual({ enqueued: 0, found: 0, failures: 0 });

    manager.shutdown();
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    manager = createManager();
    expect(store.getVoiceConsoleBatch("dispatch-quarantine-missing")).toBeNull();
    expect(store.getThreadVoiceBatch("dispatch-quarantine-missing")).toBeNull();
    expect(await manager.recoverQuarantinedDispatches()).toEqual({
      resolved: 0,
      blocked: 0,
      failures: 0,
    });
    expect(store.listVoiceConsoleQuarantinedDispatches({ includeReconciled: true })).toEqual([
      expect.objectContaining({
        dispatchId: "dispatch-quarantine-missing",
        artifactState: "missing",
        reconciledUtc: NOW,
      }),
    ]);
  });

  it.each(["pending", "running", "done"] as const)(
    "routes a quarantined %s artifact only through Package E terminalization",
    async (artifactState) => {
      const captureId = `capture-quarantine-${artifactState}`;
      manager.allocateCapture({
        consoleId: "tvc_1",
        speakerId: "speaker-bad",
        speakerName: "Bad attribution",
        captureId,
        capturedStartedUtc: NOW,
      });
      manager.commitCapture({
        ...captureIdentity(captureId),
        speakerName: "Bad attribution",
        transcript: `owned ${artifactState}`,
        audioMs: 100,
        forwardedAudioMs: 50,
        capturedEndedUtc: NOW,
        speakerAuthorized: true,
      });
      expect(store.claimPendingVoiceConsoleBatch("bind-a", `dispatch-${artifactState}`)).not.toBeNull();
      if (artifactState !== "pending") {
        store.markThreadVoiceBatchDispatched(`dispatch-${artifactState}`, NOW);
      }
      store.quarantineVoiceConsoleCapture(captureId, "invalid speaker identity", NOW);
      vi.mocked(dispatch.inspectArtifact).mockResolvedValue(artifactState);

      expect(await manager.recoverQuarantinedDispatches()).toEqual({
        resolved: 1,
        blocked: 0,
        failures: 0,
      });
      expect(dispatch.enqueue).not.toHaveBeenCalled();
      expect(dispatch.quarantineArtifact).toHaveBeenCalledWith({
        dispatchId: `dispatch-${artifactState}`,
        bindingId: "bind-a",
        captureIds: [captureId],
        artifactState,
        reason: expect.stringContaining("invalid legacy capture identity"),
      });
      expect(store.listVoiceConsoleSegments("bind-a")[0]).toMatchObject({
        state: "capture_dropped",
        transcript: "",
      });
    }
  );

  it("quarantines every artifact in a fan-out without releasing either transcript", async () => {
    const added = await manager.addBinding({
      binding: binding("bind-b", { status: "adding", alias: "Beta" }),
      claim: false,
      expectedRevision: 1,
    });
    if (!added.ok) throw new Error(added.error);
    const selected = store.replaceVoiceConsoleInputTargets("tvc_1", {
      bindingIds: ["bind-a", "bind-b"],
      fanoutArmed: true,
      expectedRevision: added.value.console.revision,
    });
    if (!selected.ok) throw new Error(selected.error);
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-bad",
      speakerName: "Bad attribution",
      captureId: "capture-quarantine-fanout",
      capturedStartedUtc: NOW,
    });
    manager.commitCapture({
      ...captureIdentity("capture-quarantine-fanout"),
      speakerName: "Bad attribution",
      transcript: "must not reach either target",
      audioMs: 100,
      forwardedAudioMs: 50,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    expect(store.claimPendingVoiceConsoleBatch("bind-a", "dispatch-fanout-a")).not.toBeNull();
    expect(store.claimPendingVoiceConsoleBatch("bind-b", "dispatch-fanout-b")).not.toBeNull();
    store.quarantineVoiceConsoleCapture("capture-quarantine-fanout", "invalid fan-out", NOW);
    vi.mocked(dispatch.inspectArtifact).mockResolvedValue("running");

    expect(await manager.recoverQuarantinedDispatches()).toEqual({
      resolved: 2,
      blocked: 0,
      failures: 0,
    });
    expect(dispatch.enqueue).not.toHaveBeenCalled();
    expect(dispatch.quarantineArtifact).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dispatch.quarantineArtifact).mock.calls.map(([input]) => input.dispatchId)).toEqual([
      "dispatch-fanout-a",
      "dispatch-fanout-b",
    ]);
    for (const bindingId of ["bind-a", "bind-b"]) {
      expect(store.listVoiceConsoleSegments(bindingId)[0]).toMatchObject({
        state: "capture_dropped",
        transcript: "",
      });
    }
  });

  it("keeps an owned quarantined artifact blocked when Package E cancellation is unavailable", async () => {
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-bad",
      speakerName: "Bad attribution",
      captureId: "capture-quarantine-blocked",
      capturedStartedUtc: NOW,
    });
    manager.commitCapture({
      ...captureIdentity("capture-quarantine-blocked"),
      speakerName: "Bad attribution",
      transcript: "blocked artifact text",
      audioMs: 100,
      forwardedAudioMs: 50,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    expect(store.claimPendingVoiceConsoleBatch("bind-a", "dispatch-quarantine-blocked")).not.toBeNull();
    store.quarantineVoiceConsoleCapture("capture-quarantine-blocked", "invalid identity", NOW);
    vi.mocked(dispatch.inspectArtifact).mockResolvedValue("pending");
    dispatch.quarantineArtifact = undefined;

    expect(await manager.recoverQuarantinedDispatches()).toEqual({
      resolved: 0,
      blocked: 1,
      failures: 0,
    });
    expect(dispatch.enqueue).not.toHaveBeenCalled();
    expect(store.listVoiceConsoleQuarantinedDispatches()).toEqual([
      expect.objectContaining({
        dispatchId: "dispatch-quarantine-blocked",
        artifactState: "pending",
        captureIds: ["capture-quarantine-blocked"],
      }),
    ]);
    expect(store.getVoiceConsoleBatch("dispatch-quarantine-blocked")).toBeNull();
    expect(store.claimPendingVoiceConsoleBatch("bind-a", "escape-dispatch")).toBeNull();
  });
});
