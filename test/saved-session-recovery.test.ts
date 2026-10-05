import { afterEach, describe, expect, it, vi } from "vitest";
import { handoverProof, loadOutageProof, SAVED_SESSION } from "./helpers/saved-session-recovery.js";

afterEach(() => vi.useRealTimers());

describe("saved conversations survive load failures and settlement", () => {
  it("keeps the SQL binding through a load outage and resumes through the existing recovery owner", async () => {
    // Only the existing recovery backoff/cooldown advances; ACP and OS process
    // activity use real timers and real streams.
    vi.useFakeTimers({ toFake: ["Date"] });
    const sleep = vi.fn(async (ms: number) => { vi.setSystemTime(Date.now() + ms); });
    const result = await loadOutageProof(sleep);
    expect(result).toMatchObject({ afterFailure: SAVED_SESSION, finalId: SAVED_SESSION,
      loadsBeforeRepair: 1, newSessions: 0, promptSession: SAVED_SESSION,
      loadError: { code: -32603, data: { trace: "fixture-resume" } } });
    expect(result.loadError.message).toContain("native thread/resume failed: fixture load outage");
    expect(sleep.mock.calls).toEqual([[30_000]]);
  }, 20_000);

  it.each([false, true])("the next turn reuses the settled attempt's living child; legacy=%s", async legacy => {
    const result = await handoverProof(legacy);
    expect(result).toMatchObject({ boundAfterSettlement: true, state: "completed", response: "end_turn",
      processes: 1, loads: 1, delegated: true, prompts: [{ session: SAVED_SESSION }] });
    expect(result.afterPid).toBe(result.beforePid);
    expect(result.newSlot).toBe(result.slot);
  }, 20_000);
});
