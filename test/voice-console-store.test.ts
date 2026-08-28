import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/core/src/core/session-store.js";
import type {
  ThreadVoiceBinding,
  VoiceConsoleSession,
} from "../packages/core/src/core/voice-console/types.js";

const NOW = "2026-08-28T12:00:00.000Z";
let dir: string;
let store: SessionStore;

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
    cardMessageId: "card-1",
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

function binding(id: string, over: Partial<ThreadVoiceBinding> = {}): ThreadVoiceBinding {
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-voice-console-store-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore Voice Console state", () => {
  it("rejects authority ids that cannot fit safely in card custom ids", () => {
    expect(() =>
      store.createVoiceConsole({
        console: consoleRow({ id: "bad:console" }),
        binding: binding("bind-a", { consoleId: "bad:console" }),
      })
    ).toThrow(/colon-free/);
    expect(() =>
      store.createVoiceConsole({
        console: consoleRow(),
        binding: binding(`bind-${"x".repeat(49)}`),
      })
    ).toThrow(/1-48/);
  });

  it("creates one console/binding/target atomically and enforces active guild and thread constraints", () => {
    const state = store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    expect(state.console).toEqual(consoleRow());
    expect(state.bindings.map((row) => row.id)).toEqual(["bind-a"]);
    expect(state.targets.map((row) => row.bindingId)).toEqual(["bind-a"]);
    expect(store.getActiveVoiceConsoleForOwner("guild-1", "admin-1")?.id).toBe("tvc_1");
    expect(store.getActiveVoiceConsoleForVoiceChannel("vc-1")?.id).toBe("tvc_1");
    expect(() =>
      store.createVoiceConsole({
        console: consoleRow({ id: "tvc_2" }),
        binding: binding("bind-b", { consoleId: "tvc_2", channelRef: "thread-b" }),
      })
    ).toThrow();
  });

  it("applies target state and revision once per interaction id", () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    const added = store.addVoiceConsoleBinding({
      binding: binding("bind-b", { alias: "Beta", aliasNormalized: "ignored" }),
      claim: false,
      expectedRevision: 1,
      interactionId: "interaction-add",
    });
    expect(added.ok && added.value.console.revision).toBe(2);
    const activated = store.activateVoiceConsoleBinding("bind-b", {
      expectedRevision: 2,
      claim: false,
    });
    if (!activated.ok) throw new Error(activated.error);

    const changed = store.replaceVoiceConsoleInputTargets("tvc_1", {
      bindingIds: ["bind-a", "bind-b"],
      fanoutArmed: true,
      expectedRevision: 3,
      interactionId: "interaction-targets",
      updatedUtc: "2026-08-28T12:01:00.000Z",
    });
    expect(changed.ok && changed.value).toMatchObject({
      applied: true,
      duplicate: false,
      console: { revision: 4, fanoutArmed: true },
    });
    expect(changed.ok && changed.value.targets.map((row) => row.bindingId)).toEqual([
      "bind-a",
      "bind-b",
    ]);

    const duplicate = store.replaceVoiceConsoleInputTargets("tvc_1", {
      bindingIds: [],
      fanoutArmed: false,
      expectedRevision: 2,
      interactionId: "interaction-targets",
    });
    expect(duplicate.ok && duplicate.value).toMatchObject({
      applied: false,
      duplicate: true,
      console: { revision: 4, fanoutArmed: true },
    });
    const stale = store.setVoiceConsoleOutputBindings("tvc_1", {
      enabledBindingIds: [],
      expectedRevision: 2,
    });
    expect(stale).toMatchObject({ ok: false, reason: "stale-revision" });
  });

  it("keeps output preferences independent and generation-invalidated", () => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
    const changed = store.setVoiceConsoleOutputBindings("tvc_1", {
      enabledBindingIds: [],
      expectedRevision: 1,
      interactionId: "outputs-off",
    });
    expect(changed.ok && changed.value.bindings[0]).toMatchObject({
      outputEnabled: false,
      outputGeneration: 1,
    });
    expect(changed.ok && changed.value.targets.map((row) => row.bindingId)).toEqual(["bind-a"]);
  });
});

describe("SessionStore Voice Console capture authority and ordering", () => {
  beforeEach(() => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding("bind-a") });
  });

  it("allocates binding order at cross-speaker capture edges and blocks out-of-order finals", () => {
    const first = store.allocateVoiceConsoleCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-a",
      speakerName: "A",
      captureId: "capture-a",
      capturedStartedUtc: "2026-08-28T12:01:00.000Z",
    });
    const second = store.allocateVoiceConsoleCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-b",
      speakerName: "B",
      captureId: "capture-b",
      capturedStartedUtc: "2026-08-28T12:01:01.000Z",
    });
    expect(first?.assignments[0]?.sequence).toBe(1);
    expect(second?.assignments[0]?.sequence).toBe(2);

    store.finalizeVoiceConsoleCapture({
      captureId: "capture-b",
      speakerId: "speaker-b",
      speakerName: "B",
      transcript: "second final arrived first",
      audioMs: 500,
      capturedEndedUtc: "2026-08-28T12:01:02.000Z",
      speakerAuthorized: true,
      resultSource: "live",
    });
    expect(store.claimPendingVoiceConsoleBatch("bind-a", "dispatch-too-early")).toBeNull();

    store.finalizeVoiceConsoleCapture({
      captureId: "capture-a",
      speakerId: "speaker-a",
      speakerName: "A",
      transcript: "first capture",
      audioMs: 600,
      capturedEndedUtc: "2026-08-28T12:01:03.000Z",
      speakerAuthorized: true,
      resultSource: "live",
    });
    const batchA = store.claimPendingVoiceConsoleBatch("bind-a", "dispatch-a");
    expect(batchA).toMatchObject({ authorId: "speaker-a", authorName: "A" });
    expect(batchA?.segments.map((row) => row.sequence)).toEqual([1]);
    store.markThreadVoiceBatchDispatched("dispatch-a");
    const batchB = store.claimPendingVoiceConsoleBatch("bind-a", "dispatch-b");
    expect(batchB).toMatchObject({ authorId: "speaker-b", authorName: "B" });
    expect(batchB?.segments.map((row) => row.sequence)).toEqual([2]);
  });

  it("fans one capture into stable per-binding sequences and drops only a removed target", () => {
    const added = store.addVoiceConsoleBinding({
      binding: binding("bind-b", { alias: "Beta" }),
      claim: false,
      expectedRevision: 1,
    });
    if (!added.ok) throw new Error(added.error);
    const activated = store.activateVoiceConsoleBinding("bind-b", {
      expectedRevision: added.value.console.revision,
      claim: false,
    });
    if (!activated.ok) throw new Error(activated.error);
    const targets = store.replaceVoiceConsoleInputTargets("tvc_1", {
      bindingIds: ["bind-a", "bind-b"],
      fanoutArmed: true,
      expectedRevision: activated.value.console.revision,
    });
    if (!targets.ok) throw new Error(targets.error);
    const capture = store.allocateVoiceConsoleCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      captureId: "capture-fanout",
    });
    expect(capture?.assignments).toHaveLength(2);
    expect(capture?.fanoutGroupId).toMatch(/^tvfg_/);

    const removing = store.beginVoiceConsoleBindingRemoval("bind-b", {
      expectedRevision: targets.value.console.revision,
      reason: "removed during capture",
    });
    expect(removing.ok).toBe(true);
    const result = store.finalizeVoiceConsoleCapture({
      captureId: "capture-fanout",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      transcript: "same text",
      audioMs: 900,
      capturedEndedUtc: "2026-08-28T12:02:00.000Z",
      speakerAuthorized: true,
    });
    expect(result.committed.map((row) => row.bindingId)).toEqual(["bind-a"]);
    expect(result.dropped.map((row) => row.bindingId)).toEqual(["bind-b"]);
    expect(result.committed[0]?.fanoutGroupId).toBe(capture?.fanoutGroupId);
  });

  it("rechecks speaker authorization and persists no transcript for a revoked speaker", () => {
    store.allocateVoiceConsoleCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-1",
      speakerName: "@Speaker\u0000",
      captureId: "capture-revoked",
    });
    const result = store.finalizeVoiceConsoleCapture({
      captureId: "capture-revoked",
      speakerId: "speaker-1",
      speakerName: "@Speaker\u0000",
      transcript: "must not persist",
      audioMs: 300,
      capturedEndedUtc: "2026-08-28T12:03:00.000Z",
      speakerAuthorized: false,
    });
    expect(result.committed).toEqual([]);
    expect(result.dropped[0]).toMatchObject({
      authorId: "speaker-1",
      authorName: "＠Speaker",
      transcript: "",
      state: "capture_dropped",
      error: "speaker authorization revoked",
    });
    store.finalizeVoiceConsoleCapture({
      captureId: "capture-revoked",
      speakerId: "speaker-1",
      speakerName: "@Speaker\u0000",
      transcript: "late duplicate",
      audioMs: 300,
      capturedEndedUtc: "2026-08-28T12:03:01.000Z",
      speakerAuthorized: false,
    });
    expect(store.getVoiceConsole("tvc_1")?.droppedCount).toBe(1);
  });
});
