import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type {
  ThreadVoiceSegment,
  ThreadVoiceSession,
} from "../packages/core/src/core/thread-voice/types.js";

let dir: string;
let dbPath: string;
let store: SessionStore;

function session(over: Partial<ThreadVoiceSession> = {}): ThreadVoiceSession {
  return {
    id: "tv_1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    ownerUserId: "user-1",
    ownerName: "Jesse",
    status: "ready",
    noticeMessageId: null,
    transmittedAudioMs: 0,
    createdUtc: "2026-08-27T12:00:00.000Z",
    updatedUtc: "2026-08-27T12:00:00.000Z",
    endedUtc: null,
    endReason: null,
    ...over,
  };
}

function segment(sequence: number, over: Partial<ThreadVoiceSegment> = {}): ThreadVoiceSegment {
  return {
    id: `tvs_${sequence}`,
    sessionId: "tv_1",
    sequence,
    authorId: "user-1",
    transcript: `segment ${sequence}`,
    state: "pending",
    audioMs: 1000,
    dispatchId: null,
    capturedStartedUtc: `2026-08-27T12:00:0${sequence}.000Z`,
    capturedEndedUtc: `2026-08-27T12:00:0${sequence}.900Z`,
    createdUtc: `2026-08-27T12:00:1${sequence}.000Z`,
    updatedUtc: `2026-08-27T12:00:1${sequence}.000Z`,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-thread-voice-store-"));
  dbPath = path.join(dir, "test.db");
  store = new SessionStore(dbPath);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore Thread Voice sessions", () => {
  it("round-trips rows and enforces one active session per thread and guild", () => {
    const row = session();
    store.insertThreadVoiceSession(row);
    expect(store.getThreadVoiceSession(row.id)).toEqual(row);
    expect(store.getActiveThreadVoiceForThread("discord", "thread-1")?.id).toBe("tv_1");
    expect(store.getActiveThreadVoiceForGuild("guild-1")?.id).toBe("tv_1");
    expect(store.getActiveThreadVoiceForVoiceChannel("vc-1")?.id).toBe("tv_1");
    expect(store.getActiveThreadVoiceForOwner("guild-1", "user-1")?.id).toBe("tv_1");

    expect(() =>
      store.insertThreadVoiceSession(
        session({ id: "tv_same_thread", guildId: "guild-2", voiceChannelId: "vc-2" })
      )
    ).toThrow();
    expect(() =>
      store.insertThreadVoiceSession(
        session({ id: "tv_same_guild", channelRef: "thread-2", voiceChannelId: "vc-2" })
      )
    ).toThrow();
  });

  it("allows a new active binding after the prior row becomes terminal", () => {
    store.insertThreadVoiceSession(session());
    store.updateThreadVoiceSession("tv_1", {
      status: "ended",
      endedUtc: "2026-08-27T13:00:00.000Z",
      endReason: "stopped",
    });
    store.insertThreadVoiceSession(
      session({ id: "tv_2", voiceChannelId: "vc-2", ownerUserId: "user-2" })
    );
    expect(store.getActiveThreadVoiceForThread("discord", "thread-1")?.id).toBe("tv_2");
  });

  it("increments transmitted audio atomically and persists across reopen", () => {
    store.insertThreadVoiceSession(session());
    expect(store.addThreadVoiceTransmittedAudio("tv_1", 250)).toBe(250);
    expect(store.addThreadVoiceTransmittedAudio("tv_1", 750)).toBe(1000);
    store.close();
    store = new SessionStore(dbPath);
    expect(store.getThreadVoiceSession("tv_1")?.transmittedAudioMs).toBe(1000);
  });

  it("does not create any raw-audio persistence column", () => {
    const raw = new Database(dbPath, { readonly: true });
    const columns = raw
      .prepare("PRAGMA table_info(thread_voice_segments)")
      .all()
      .map((row: any) => row.name);
    raw.close();
    expect(columns).not.toContain("audio_blob");
    expect(columns).not.toContain("audio_path");
    expect(columns).not.toContain("pcm");
    expect(columns).not.toContain("opus");
  });
});

describe("SessionStore Thread Voice segments and batches", () => {
  beforeEach(() => store.insertThreadVoiceSession(session()));

  it("appends exactly once and always reads in capture-sequence order", () => {
    store.appendThreadVoiceSegment(segment(3));
    store.appendThreadVoiceSegment(segment(1));
    store.appendThreadVoiceSegment(segment(2));
    expect(store.listThreadVoiceSegments("tv_1").map((row) => row.sequence)).toEqual([1, 2, 3]);

    const duplicate = store.appendThreadVoiceSegment(
      segment(2, { id: "different-id", transcript: "duplicate API completion" })
    );
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.segment.transcript).toBe("segment 2");
    expect(store.listThreadVoiceSegments("tv_1")).toHaveLength(3);
  });

  it("rejects empty finals and authors that do not match the durable owner", () => {
    expect(() => store.appendThreadVoiceSegment(segment(1, { transcript: "   " }))).toThrow(/empty/);
    expect(() => store.appendThreadVoiceSegment(segment(1, { authorId: "user-2" }))).toThrow(/owner/);
  });

  it("persists failure metadata without persisting unfinished transcript content", () => {
    const dropped = store.recordDroppedThreadVoiceSegment(
      segment(1, {
        transcript: "interim text must not survive",
        state: "transcribe_failed",
        error: "live and unary failed",
      })
    );
    expect(dropped.segment).toMatchObject({
      state: "transcribe_failed",
      transcript: "",
      error: "live and unary failed",
    });
  });

  it("claims an atomic ordered snapshot and leaves later finals for the next stable batch", () => {
    store.appendThreadVoiceSegment(segment(2));
    store.appendThreadVoiceSegment(segment(1));
    const first = store.claimPendingThreadVoiceBatch(
      "tv_1",
      "tvd_first",
      "2026-08-27T12:10:00.000Z"
    );
    expect(first?.dispatchId).toBe("tvd_first");
    expect(first?.segments.map((row) => row.sequence)).toEqual([1, 2]);
    expect(first?.prompt.indexOf("Voice segment 1")).toBeLessThan(
      first?.prompt.indexOf("Voice segment 2") ?? -1
    );

    store.appendThreadVoiceSegment(segment(3));
    expect(store.claimPendingThreadVoiceBatch("tv_1", "tvd_too_soon")).toBeNull();
    expect(store.markThreadVoiceBatchDispatched("tvd_first")).toBe(2);
    const second = store.claimPendingThreadVoiceBatch("tv_1", "tvd_second");
    expect(second?.segments.map((row) => row.sequence)).toEqual([3]);
  });

  it("blocks another session on the home thread while one durable batch is unresolved", () => {
    store.appendThreadVoiceSegment(segment(1));
    expect(store.claimPendingThreadVoiceBatch("tv_1", "tvd_old")).not.toBeNull();
    store.updateThreadVoiceSession("tv_1", { status: "ended", endedUtc: "now" });
    store.insertThreadVoiceSession(session({ id: "tv_2", ownerUserId: "user-2" }));
    store.appendThreadVoiceSegment(
      segment(1, { id: "tvs_new", sessionId: "tv_2", authorId: "user-2" })
    );
    expect(store.claimPendingThreadVoiceBatch("tv_2", "tvd_new")).toBeNull();
  });

  it("recovers a stable batched dispatch after reopen without changing its id", () => {
    store.appendThreadVoiceSegment(segment(1));
    store.claimPendingThreadVoiceBatch("tv_1", "tvd_recover");
    store.markThreadVoiceBatchError("tvd_recover", "disk queue unavailable");
    store.close();
    store = new SessionStore(dbPath);
    const recovered = store.listRecoverableThreadVoiceBatches();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.dispatchId).toBe("tvd_recover");
    expect(recovered[0]?.segments[0]?.error).toBe("disk queue unavailable");
  });

  it("reports buffered stats and discards only unclaimed finalized text", () => {
    store.appendThreadVoiceSegment(segment(1, { transcript: "one" }));
    store.appendThreadVoiceSegment(segment(2, { transcript: "second" }));
    expect(store.getThreadVoicePendingStats("discord", "thread-1")).toEqual({
      segmentCount: 2,
      characterCount: 9,
      activeDispatchId: null,
    });
    expect(store.discardPendingThreadVoiceSegments("tv_1")).toBe(2);
    const rows = store.listThreadVoiceSegments("tv_1");
    expect(rows.map((row) => row.state)).toEqual(["discarded", "discarded"]);
    expect(rows.map((row) => row.transcript)).toEqual(["", ""]);
    expect(store.hasThreadVoiceBufferedSegments("discord", "thread-1")).toBe(false);
  });
});
