import { describe, expect, it, vi } from "vitest";
import {
  VoiceConsoleCaptureRouter,
  type VoiceConsoleArmedCapture,
  type VoiceConsoleCapturePersistencePort,
  type VoiceConsoleCaptureSnapshotDraft,
} from "../packages/core/src/core/voice-console/capture-router.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fixture(opts: {
  allowed?: string[];
  targets?: Array<{ bindingId: string; sequence: number }>;
} = {}) {
  const allowed = new Set(opts.allowed ?? ["alice", "bob"]);
  let serial = 0;
  let targets = opts.targets ?? [{ bindingId: "binding-a", sequence: 1 }];
  const snapshots: VoiceConsoleCaptureSnapshotDraft[] = [];
  const persistence: VoiceConsoleCapturePersistencePort = {
    snapshotCapture: vi.fn(async ({ speakerId, speakerName, capturedStartedUtc }) => {
      if (targets.length === 0) return null;
      serial += 1;
      const snapshot: VoiceConsoleCaptureSnapshotDraft = {
        consoleId: "console-1",
        captureId: `capture-${serial}`,
        fanoutGroupId: targets.length > 1 ? `fanout-${serial}` : null,
        consoleRevision: 7,
        speakerId,
        speakerName,
        capturedStartedUtc,
        targets,
      };
      snapshots.push(snapshot);
      return snapshot;
    }),
    commitCapture: vi.fn(async ({ snapshot }) =>
      snapshot.targets.map((target) => ({
        bindingId: target.bindingId,
        sequence: target.sequence,
        status: "committed" as const,
        segmentId: `segment-${snapshot.captureId}-${target.bindingId}`,
      }))
    ),
    dropCapture: vi.fn(async () => {}),
  };
  const armed: VoiceConsoleArmedCapture[] = [];
  const finalized: VoiceConsoleArmedCapture[] = [];
  const aborted: Array<{ capture: VoiceConsoleArmedCapture; reason: string }> = [];
  const interims: string[] = [];
  const byteEvents: Array<{ bytes: number; totalBytes: number }> = [];
  const settled: string[] = [];
  let clock = 0;
  const router = new VoiceConsoleCaptureRouter({
    persistence,
    isAllowedUser: (userId) => allowed.has(userId),
    inputActive: true,
    now: () => `t-${++clock}`,
    callbacks: {
      onCaptureArmed: (capture) => armed.push(capture),
      onCaptureFinalize: (capture) => finalized.push(capture),
      onCaptureAbort: (capture, reason) => aborted.push({ capture, reason }),
      onInterim: (_capture, text) => interims.push(text),
      onForwardedBytes: ({ bytes, totalBytes }) => byteEvents.push({ bytes, totalBytes }),
      onSettled: (settlement) => settled.push(`${settlement.captureId}:${settlement.status}`),
    },
  });
  return {
    router,
    persistence,
    allowed,
    armed,
    finalized,
    aborted,
    interims,
    byteEvents,
    settled,
    snapshots,
    setTargets(next: Array<{ bindingId: string; sequence: number }>) {
      targets = next;
    },
  };
}

async function arm(
  f: ReturnType<typeof fixture>,
  userId: string,
  speakerName = userId
): Promise<VoiceConsoleArmedCapture> {
  expect(f.router.speakerPresent({ userId, speakerName, selfMuted: true })).toBe(true);
  await f.router.setSpeakerMuted({ userId, speakerName, selfMuted: false });
  return f.armed.at(-1)!;
}

describe("VoiceConsoleCaptureRouter", () => {
  it("checks the speaker allowlist before allocating or arming", async () => {
    const f = fixture({ allowed: ["alice"] });
    expect(f.router.speakerPresent({ userId: "mallory", speakerName: "Mallory", selfMuted: true }))
      .toBe(false);
    await f.router.setSpeakerMuted({ userId: "mallory", selfMuted: false });
    expect(f.persistence.snapshotCapture).not.toHaveBeenCalled();
    expect(f.router.getLane("mallory")).toBeUndefined();
  });

  it("requires a fresh mute/unmute when input becomes active while already unmuted", async () => {
    const f = fixture();
    await f.router.setInputEnabled(false);
    f.router.speakerPresent({ userId: "alice", speakerName: "Alice", selfMuted: false });
    await f.router.setInputEnabled(true);
    expect(f.router.getLane("alice")?.state).toBe("awaiting_safe_mute");
    expect(f.persistence.snapshotCapture).not.toHaveBeenCalled();

    await f.router.setSpeakerMuted({ userId: "alice", selfMuted: true });
    await f.router.setSpeakerMuted({ userId: "alice", selfMuted: false });
    expect(f.persistence.snapshotCapture).toHaveBeenCalledOnce();
    expect(f.router.getLane("alice")?.state).toBe("capturing");
  });

  it("freezes the edge-time target snapshot and fans one final into binding-local results", async () => {
    const targetDraft = [
      { bindingId: "binding-a", sequence: 11 },
      { bindingId: "binding-b", sequence: 42 },
    ];
    const f = fixture({ targets: targetDraft });
    const capture = await arm(f, "alice", "Alice");
    expect(Object.isFrozen(capture.snapshot)).toBe(true);
    expect(Object.isFrozen(capture.snapshot.targets)).toBe(true);
    expect(Object.isFrozen(capture.snapshot.targets[0])).toBe(true);

    targetDraft.splice(0, targetDraft.length, { bindingId: "binding-c", sequence: 99 });
    f.router.recordForwardedBytes("alice", 3_200);
    await f.router.setSpeakerMuted({ userId: "alice", selfMuted: true });
    const result = await f.router.settleCapture(capture.captureId, {
      ok: true,
      transcript: "  one shared transcript  ",
      audioMs: 100,
      capturedEndedUtc: "ended",
      source: "live",
    });

    expect(result).toEqual({
      status: "committed",
      captureId: capture.captureId,
      results: [
        {
          bindingId: "binding-a",
          sequence: 11,
          status: "committed",
          segmentId: `segment-${capture.captureId}-binding-a`,
        },
        {
          bindingId: "binding-b",
          sequence: 42,
          status: "committed",
          segmentId: `segment-${capture.captureId}-binding-b`,
        },
      ],
    });
    expect(f.persistence.commitCapture).toHaveBeenCalledOnce();
    expect(f.persistence.commitCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: "one shared transcript",
        forwardedBytes: 3_200,
        snapshot: expect.objectContaining({
          targets: [
            { bindingId: "binding-a", sequence: 11 },
            { bindingId: "binding-b", sequence: 42 },
          ],
        }),
      })
    );
    expect(f.byteEvents).toEqual([{ bytes: 3_200, totalBytes: 3_200 }]);
  });

  it("isolates overlapping allowed speakers and permits out-of-order finals", async () => {
    const f = fixture();
    const alice = await arm(f, "alice", "Alice");
    const bob = await arm(f, "bob", "Bob");
    expect(f.router.activeLaneCount).toBe(2);
    expect(alice.captureId).not.toBe(bob.captureId);

    await f.router.setSpeakerMuted({ userId: "alice", selfMuted: true });
    await f.router.setSpeakerMuted({ userId: "bob", selfMuted: true });
    await f.router.settleCapture(bob.captureId, {
      ok: true,
      transcript: "Bob spoke",
      audioMs: 300,
      capturedEndedUtc: "bob-end",
      source: "live",
    });
    await f.router.settleCapture(alice.captureId, {
      ok: true,
      transcript: "Alice spoke",
      audioMs: 400,
      capturedEndedUtc: "alice-end",
      source: "unary",
    });

    expect(f.persistence.commitCapture).toHaveBeenCalledTimes(2);
    const commits = vi.mocked(f.persistence.commitCapture).mock.calls.map(([input]) => ({
      speakerId: input.snapshot.speakerId,
      transcript: input.transcript,
      source: input.source,
    }));
    expect(commits).toEqual([
      { speakerId: "bob", transcript: "Bob spoke", source: "live" },
      { speakerId: "alice", transcript: "Alice spoke", source: "unary" },
    ]);
  });

  it("drops at the final boundary when an allowed speaker is revoked", async () => {
    const f = fixture();
    const capture = await arm(f, "alice");
    await f.router.setSpeakerMuted({ userId: "alice", selfMuted: true });
    f.allowed.delete("alice");
    const result = await f.router.settleCapture(capture.captureId, {
      ok: true,
      transcript: "must not persist",
      audioMs: 250,
      capturedEndedUtc: "ended",
      source: "live",
    });

    expect(result).toEqual({
      status: "dropped",
      captureId: capture.captureId,
      reason: "speaker_unauthorized",
    });
    expect(f.persistence.commitCapture).not.toHaveBeenCalled();
    expect(f.persistence.dropCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "speaker_unauthorized",
        error: expect.stringContaining("DISCORD_ALLOWED_USER_IDS"),
      })
    );
  });

  it("Input off aborts every lane and late Live/unary losers cannot commit", async () => {
    const f = fixture({
      targets: [
        { bindingId: "binding-a", sequence: 1 },
        { bindingId: "binding-b", sequence: 1 },
      ],
    });
    const alice = await arm(f, "alice");
    const bob = await arm(f, "bob");
    f.router.recordForwardedBytes("alice", 640);
    f.router.recordForwardedBytes("bob", 960);
    await f.router.setInputEnabled(false);

    expect(f.aborted.map(({ capture, reason }) => [capture.captureId, reason])).toEqual([
      [alice.captureId, "input_off"],
      [bob.captureId, "input_off"],
    ]);
    expect(f.persistence.dropCapture).toHaveBeenCalledTimes(2);
    expect(f.router.forwardedBytes).toBe(1_600);
    expect(f.router.canForward("alice")).toBe(false);
    await expect(
      f.router.settleCapture(alice.captureId, {
        ok: true,
        transcript: "late live",
        audioMs: 10,
        capturedEndedUtc: "later",
        source: "live",
      })
    ).resolves.toEqual({ status: "ignored", captureId: alice.captureId });
    await expect(
      f.router.settleCapture(bob.captureId, {
        ok: true,
        transcript: "late unary",
        audioMs: 10,
        capturedEndedUtc: "later",
        source: "unary",
      })
    ).resolves.toEqual({ status: "ignored", captureId: bob.captureId });
    expect(f.persistence.commitCapture).not.toHaveBeenCalled();
  });

  it("rebinds one user lane without duplication and fails safe when continuity is unknown", async () => {
    const f = fixture();
    const capture = await arm(f, "alice", "Alice");
    await f.router.rebindSpeaker({
      userId: "alice",
      speakerName: "Alice (new device)",
      selfMuted: false,
      continuityProven: true,
    });
    expect(f.router.listLanes()).toHaveLength(1);
    expect(f.router.getLane("alice")).toMatchObject({
      captureId: capture.captureId,
      state: "capturing",
      transportEpoch: 1,
    });
    expect(f.aborted).toHaveLength(0);

    await f.router.rebindSpeaker({
      userId: "alice",
      speakerName: "Alice (unknown continuity)",
      selfMuted: false,
      continuityProven: false,
    });
    expect(f.router.listLanes()).toHaveLength(1);
    expect(f.router.getLane("alice")).toMatchObject({
      state: "awaiting_safe_mute",
      transportEpoch: 2,
    });
    expect(f.aborted).toHaveLength(1);
    expect(f.aborted[0]).toMatchObject({ reason: "unsafe_rebind" });
  });

  it("arbitrates duplicate final callers before persistence resolves", async () => {
    const f = fixture();
    const capture = await arm(f, "alice");
    await f.router.setSpeakerMuted({ userId: "alice", selfMuted: true });
    const pending = deferred<ReadonlyArray<{
      bindingId: string;
      sequence: number;
      status: "committed";
    }>>();
    vi.mocked(f.persistence.commitCapture).mockImplementationOnce(() => pending.promise);
    const outcome = {
      ok: true as const,
      transcript: "winner",
      audioMs: 250,
      capturedEndedUtc: "ended",
      source: "live" as const,
    };
    const first = f.router.settleCapture(capture.captureId, outcome);
    const duplicate = f.router.settleCapture(capture.captureId, {
      ...outcome,
      transcript: "late loser",
      source: "unary",
    });
    expect(duplicate).toBe(first);
    expect(f.persistence.commitCapture).toHaveBeenCalledOnce();
    pending.resolve([{ bindingId: "binding-a", sequence: 1, status: "committed" }]);
    await expect(first).resolves.toMatchObject({ status: "committed" });
    expect(f.persistence.commitCapture).toHaveBeenCalledOnce();
  });
});
