/**
 * #76 pure helpers: marker lifecycle (writeDone commit ordering), max-age,
 * preconditions, stagger, and the continue/resume-mark substitutions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CONTINUE_PROMPT,
  RESUME_ANNOUNCE,
  TURN_RESUME_MAX_AGE_SECONDS,
  abandonedNotice,
  createResumeScheduler,
  decideResume,
  finishLiveTurn,
  isPastMaxAge,
  listAbandonedLiveTurns,
  listLiveMarkers,
  markSpecAsResume,
  parseLiveMarker,
  patchLiveMarker,
  turnDirs,
  writeLiveMarker,
  type LiveTurnMarker,
} from "../src/core/dispatch/turn-resume.js";

let dataDir: string;

const marker = (over: Partial<LiveTurnMarker> = {}): LiveTurnMarker => ({
  id: "live-abc",
  kind: "live",
  channelRef: "thread-1",
  sessionRecordId: "discord:thread-1",
  acpSessionId: "acp-sess-1",
  authorId: "user-1",
  startedUtc: "2026-08-18T12:00:00.000Z",
  ...over,
});

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-turn-resume-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("markSpecAsResume / CONTINUE_PROMPT", () => {
  it("marks a spec resume:true without rewriting the original prompt", () => {
    const spec = markSpecAsResume({
      id: "d1",
      target: "t",
      prompt: "do the overnight run",
      session: "isolated",
      createdUtc: "2026-08-18T00:00:00.000Z",
    });
    expect(spec.resume).toBe(true);
    expect(spec.prompt).toBe("do the overnight run");
    expect(CONTINUE_PROMPT).toBe("continue");
    expect(RESUME_ANNOUNCE).toMatch(/resuming after restart/);
  });
});

describe("isPastMaxAge / decideResume", () => {
  const now = new Date("2026-08-18T14:00:00.000Z");

  it("mirrors catchupSeconds: within window is not stale", () => {
    expect(isPastMaxAge("2026-08-18T13:00:00.000Z", 7200, now)).toBe(false);
    expect(isPastMaxAge("2026-08-18T10:00:00.000Z", 7200, now)).toBe(true);
    expect(isPastMaxAge("2026-08-18T10:00:00.000Z", 0, now)).toBe(false);
  });

  it("abandons a deleted thread or a missing session pointer", () => {
    expect(
      decideResume({
        startedUtc: "2026-08-18T13:00:00.000Z",
        maxAgeSeconds: 7200,
        now,
        precondition: "deleted",
        acpSessionId: "s",
      })
    ).toEqual({ action: "abandon", reason: "thread deleted" });
    expect(
      decideResume({
        startedUtc: "2026-08-18T13:00:00.000Z",
        maxAgeSeconds: 7200,
        now,
        precondition: "ok",
        acpSessionId: undefined,
      })
    ).toEqual({ action: "abandon", reason: "no recorded ACP session" });
  });

  it("skips locked / archived / unreachable rather than abandoning", () => {
    for (const pre of ["locked", "archived", "unreachable"] as const) {
      const d = decideResume({
        startedUtc: "2026-08-18T13:00:00.000Z",
        maxAgeSeconds: 7200,
        now,
        precondition: pre,
        acpSessionId: "s",
      });
      expect(d.action).toBe("skip");
    }
  });

  it("abandons past max-age with a notice, not a resume", () => {
    const d = decideResume({
      startedUtc: "2026-08-18T10:00:00.000Z",
      maxAgeSeconds: 7200,
      now,
      precondition: "ok",
      acpSessionId: "s",
    });
    expect(d).toEqual({ action: "abandon", reason: "past max-age" });
    expect(abandonedNotice("past max-age", TURN_RESUME_MAX_AGE_SECONDS)).toMatch(/older than 2h/);
  });

  it("resumes when in-window, reachable, and a session pointer exists", () => {
    expect(
      decideResume({
        startedUtc: "2026-08-18T13:30:00.000Z",
        maxAgeSeconds: 7200,
        now,
        precondition: "ok",
        acpSessionId: "acp-1",
      })
    ).toEqual({ action: "resume", reason: "ok" });
  });
});

describe("live marker lifecycle (writeDone commit ordering)", () => {
  it("writes the marker at start into running/", async () => {
    await writeLiveMarker(dataDir, marker());
    const dirs = turnDirs(dataDir);
    expect(await readdir(dirs.running)).toEqual(["live-abc.json"]);
    const parsed = parseLiveMarker(
      "live-abc",
      await readFile(path.join(dirs.running, "live-abc.json"), "utf8")
    );
    expect(parsed.channelRef).toBe("thread-1");
    expect(parsed.acpSessionId).toBe("acp-sess-1");
    expect(await listLiveMarkers(dataDir)).toHaveLength(1);
  });

  it("patches acpSessionId in place without dropping the marker", async () => {
    await writeLiveMarker(dataDir, marker({ acpSessionId: undefined }));
    await patchLiveMarker(dataDir, "live-abc", { acpSessionId: "acp-later" });
    const [m] = await listLiveMarkers(dataDir);
    expect(m?.acpSessionId).toBe("acp-later");
  });

  it("writes done THEN removes running; leaves running if done write cannot land", async () => {
    await writeLiveMarker(dataDir, marker());
    const ok = await finishLiveTurn(dataDir, {
      id: "live-abc",
      status: "completed",
      channelRef: "thread-1",
      finishedUtc: "2026-08-18T12:05:00.000Z",
    });
    expect(ok).toBe(true);
    const dirs = turnDirs(dataDir);
    expect(await readdir(dirs.running)).toEqual([]);
    expect(await readdir(dirs.done)).toEqual(["live-abc.json"]);
  });

  it("does not overwrite a command-layer cancelled done-file", async () => {
    await writeLiveMarker(dataDir, marker());
    await finishLiveTurn(dataDir, {
      id: "live-abc",
      status: "cancelled",
      channelRef: "thread-1",
      finishedUtc: "2026-08-18T12:01:00.000Z",
      reason: "cancelled by operator",
    });
    await finishLiveTurn(dataDir, {
      id: "live-abc",
      status: "completed",
      channelRef: "thread-1",
      finishedUtc: "2026-08-18T12:02:00.000Z",
    });
    const dirs = turnDirs(dataDir);
    const done = JSON.parse(await readFile(path.join(dirs.done, "live-abc.json"), "utf8"));
    expect(done.status).toBe("cancelled");
    expect(await readdir(dirs.running)).toEqual([]);
  });

  it("lists abandoned done-files for the operator inventory", async () => {
    await writeLiveMarker(dataDir, marker());
    await finishLiveTurn(dataDir, {
      id: "live-abc",
      status: "abandoned",
      channelRef: "thread-1",
      finishedUtc: "2026-08-18T16:00:00.000Z",
      reason: "past max-age",
    });
    const abandoned = await listAbandonedLiveTurns(dataDir);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.reason).toBe("past max-age");
    expect(await listLiveMarkers(dataDir)).toEqual([]);
  });

  it("leaves the running-file when the done path is not writable", async () => {
    await writeLiveMarker(dataDir, marker());
    const dirs = turnDirs(dataDir);
    // Plant a DIRECTORY where the done-file should go so the write/rename fails.
    await mkdir(path.join(dirs.done, "live-abc.json"));
    const ok = await finishLiveTurn(dataDir, {
      id: "live-abc",
      status: "completed",
      channelRef: "thread-1",
      finishedUtc: "2026-08-18T12:05:00.000Z",
    });
    expect(ok).toBe(false);
    expect(await readdir(dirs.running)).toEqual(["live-abc.json"]);
  });
});

describe("createResumeScheduler (stagger + concurrency)", () => {
  it("does not start N jobs simultaneously", async () => {
    let fakeNow = 0;
    const scheduler = createResumeScheduler({
      concurrency: 2,
      staggerMs: 100,
      now: () => fakeNow,
      sleep: async (ms) => {
        fakeNow += ms;
      },
    });
    const starts: number[] = [];
    const jobs = [0, 1, 2, 3, 4].map((i) =>
      scheduler.run(async () => {
        starts.push(fakeNow);
        // hold the slot briefly so concurrency is observable
        await new Promise((r) => setTimeout(r, 5));
        return i;
      })
    );
    await Promise.all(jobs);
    expect(scheduler.started()).toBe(5);
    // First start is immediate; later starts are at least staggerMs apart
    // when a slot is free, or wait for concurrency.
    expect(starts[0]).toBe(0);
    expect(Math.max(...starts)).toBeGreaterThanOrEqual(100);
    // Never more than `concurrency` conceptually: we had 2 slots, 5 jobs,
    // stagger 100ms — last start cannot be 0.
    expect(new Set(starts).size).toBeGreaterThan(1);
  });
});
