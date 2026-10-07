import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handoverProof, loadOutageProof, savedSessionHost, sessionGoneProof, SAVED_SESSION } from "./helpers/saved-session-recovery.js";
import { prepareSessionExecutables } from "./helpers/saved-session-executables.js";

const executables = await prepareSessionExecutables();
afterAll(() => executables.close());
afterEach(() => vi.useRealTimers());

describe("saved conversations survive load failures and settlement", () => {
  it("keeps the SQL binding through a load outage and resumes through the existing recovery owner", async () => {
    // Only the existing recovery backoff/cooldown advances; ACP and OS process
    // activity use real timers and real streams.
    vi.useFakeTimers({ toFake: ["Date"] });
    const sleep = vi.fn(async (ms: number) => { vi.setSystemTime(Date.now() + ms); });
    const result = await loadOutageProof(sleep, executables);
    expect(result).toMatchObject({ afterFailure: SAVED_SESSION, finalId: SAVED_SESSION,
      loadsBeforeRepair: 1, newSessions: 0, promptSession: SAVED_SESSION,
      loadError: { code: -32603, data: { trace: "fixture-resume" } } });
    expect(result.loadError.message).toContain("native thread/resume failed: fixture load outage");
    expect(sleep.mock.calls).toEqual([[30_000]]);
  }, 20_000);

  it.each([false, true])("the next turn reuses the settled attempt's living child; legacy=%s", async legacy => {
    const result = await handoverProof(legacy, { holderPath: executables.holderPath,
      adapterChildPath: legacy ? executables.legacyAdapterChildPath : executables.adapterChildPath });
    expect(result).toMatchObject({ boundAfterSettlement: true, state: "completed", response: "end_turn",
      processes: 1, loads: 1, delegated: true, prompts: [{ session: SAVED_SESSION }] });
    expect(result.afterPid).toBe(result.beforePid);
    expect(result.newSlot).toBe(result.slot);
  }, 20_000);

  describe("missing sessions", () => {
    let host: Awaited<ReturnType<typeof savedSessionHost>>;
    let router: ReturnType<typeof host.makeRouter>;
    const sleep = vi.fn(async (ms: number) => { vi.setSystemTime(Date.now() + ms); });

    beforeEach(async () => {
      sleep.mockClear();
      host = await savedSessionHost({ ...executables, sessionGone: true, recoverySleep: sleep });
      router = host.makeRouter();
      const plan = router.planRuntimeSpawn(host.record);
      const runtime = (router as any).makeRuntime(host.record, plan, plan.model, plan.effort);
      // Await native ACP initialization only; session/load still runs in the test.
      await runtime.start();
      vi.spyOn(router as any, "makeRuntime").mockReturnValueOnce(runtime);
    });

    afterEach(async () => {
      await host.close();
      vi.restoreAllMocks();
    });

    it.each([false, true])("a missing session recovers visibly without load retries and later turns keep working; recorded=%s", async recorded => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const result = await sessionGoneProof(host, router, recorded);
      expect(result).toMatchObject({ afterRecovery: "replacement-conversation", finalId: "replacement-conversation",
        missingLoads: 1, laterLoads: 1, newSessions: 1,
        promptSessions: ["replacement-conversation", "replacement-conversation"],
        notices: [{ channel: { platform: "discord", id: "fixture-thread" },
          text: expect.stringContaining(SAVED_SESSION) }] });
      expect(result.notices[0].text).toContain("no rollout found");
      expect(result.notices[0].text).toContain("fresh conversation");
      expect(sleep).not.toHaveBeenCalled();
    }, 20_000);
  });
});
