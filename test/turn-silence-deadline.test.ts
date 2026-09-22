import { describe, expect, it } from "vitest";
import {
  raceUntilSilence,
  settleWithTurnWatchdog,
  turnSilenceDeadlineMs,
  turnStalenessBoundMs,
  TURN_WATCHDOG_GRACE_MS,
  TurnWatchdogTimeoutError,
} from "../packages/core/src/core/turn-watchdog.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("#460 silence deadline", () => {
  it("puts the staleness verdict strictly after the silence deadline", () => {
    expect(turnSilenceDeadlineMs(900)).toBe(900_000);
    expect(turnStalenessBoundMs(900)).toBe(900_000 + TURN_WATCHDOG_GRACE_MS);
  });

  it("times out a prompt that stays silent, and does not consult a hang probe", async () => {
    const started = Date.now();
    const outcome = await raceUntilSilence(new Promise(() => {}), {
      silenceMs: 40,
      lastActivityAt: () => started,
    });
    expect(outcome).toBe("timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("does not time out a prompt that keeps producing output", async () => {
    const started = Date.now();
    let activity = started;
    const bumps = setInterval(() => { activity = Date.now(); }, 15);
    try {
      const outcome = await raceUntilSilence(wait(90).then(() => "done"), {
        silenceMs: 40,
        lastActivityAt: () => activity,
      });
      expect(outcome).toBe("done");
      expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    } finally {
      clearInterval(bumps);
    }
  });

  it("lets the promise win and does not leave the silence timer running", async () => {
    const outcome = await raceUntilSilence(wait(20).then(() => "ok"), {
      silenceMs: 5_000,
      lastActivityAt: () => Date.now(),
    });
    expect(outcome).toBe("ok");
  });

  it("slides the watchdog with the same activity mark, and still fires once silence exceeds it", async () => {
    const started = Date.now();
    let activity = started;
    const bumps = setInterval(() => { activity = Date.now(); }, 15);
    const sliding = settleWithTurnWatchdog(() => wait(80).then(() => "kept"), {
      timeoutMs: 40,
      label: "sliding",
      lastActivityAt: () => activity,
    });
    await expect(sliding).resolves.toBe("kept");
    clearInterval(bumps);
    const quiet = Date.now();
    await expect(settleWithTurnWatchdog(() => new Promise(() => {}), {
      timeoutMs: 40,
      label: "quiet",
      lastActivityAt: () => quiet,
    })).rejects.toBeInstanceOf(TurnWatchdogTimeoutError);
  });

  it("keeps a watchdog with no activity mark on the wall clock", async () => {
    await expect(settleWithTurnWatchdog(() => new Promise(() => {}), {
      timeoutMs: 30,
      label: "wall",
    })).rejects.toBeInstanceOf(TurnWatchdogTimeoutError);
  });
});
