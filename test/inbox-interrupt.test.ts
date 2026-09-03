import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  DispatchTurnError,
  dispatchDirs,
  type DispatchSpec,
} from "../packages/core/src/core/dispatch/types.js";
import { completionRoute } from "../packages/core/src/core/dispatch/done-reconcile.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-worker",
  platform: "discord",
  channelRef: "thread-worker",
  parentRef: "channel-1",
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: new Date().toISOString(),
  updatedUtc: new Date().toISOString(),
  ...over,
});

/** Orchestrator with a controllable router stub, a real store, and the heavy
 *  visibility helpers of dispatchInjectTurn stubbed out — so a full live
 *  dispatch can run in-process and its report-back decision is observable. */
function makeOrch(opts?: {
  abortTurn?: ReturnType<typeof vi.fn>;
  invalidate?: ReturnType<typeof vi.fn>;
}) {
  const abortTurn = opts?.abortTurn ?? vi.fn(async () => "cancelled");
  const invalidate = opts?.invalidate ?? vi.fn(async () => {});
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    ensureSessionRecord: (o: { channelRef: string; parentRef?: string }) =>
      record({
        id: `discord:${o.channelRef}`,
        channelRef: o.channelRef,
        ...(o.parentRef ? { parentRef: o.parentRef } : {}),
      }),
    getProfile: () => ({ id: "claude" }),
    hasRuntime: () => true,
    abortTurn,
    invalidate,
  };
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      DISCORD_USER_NAMES: new Map<string, string>(),
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "claude-opus-4.8",
      // Quiet path: no status panel, no streaming renderer — the run falls back
      // to the (stubbed) capture-and-post so we can drive it without an adapter.
      SEAM_DISPATCH_STATUS_PANEL: false,
    } as any,
    adapter: {} as any,
    router: router as any,
    store,
    renderer: {} as any,
  });
  // Stub the visibility helpers so the run has no Discord side effects.
  (orch as any).postDispatchStartIndicator = async () => undefined;
  (orch as any).postDispatchOutput = async () => {};
  return { orch, router, abortTurn, invalidate };
}

const caller = (over: Partial<SessionRecord> = {}): SessionRecord =>
  record({ id: "discord:thread-boss", channelRef: "thread-boss", ...over });

/** Read every enqueued dispatch spec sitting in the pending queue. */
function pendingSpecs(): DispatchSpec[] {
  const { pending } = dispatchDirs(dir);
  if (!fs.existsSync(pending)) return [];
  return fs
    .readdirSync(pending)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(fs.readFileSync(path.join(pending, n), "utf8")) as DispatchSpec);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-inbox-interrupt-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Orchestrator.interruptRedirect (#67)", () => {
  it("cancels (force), marks the active dispatch interrupted, and enqueues a fresh live redirect", async () => {
    const { orch, abortTurn, invalidate } = makeOrch();
    // A live handoff is running in the target thread.
    (orch as any).activeLiveDispatch.set("thread-worker", "disp-A");

    const res = await orch.interruptRedirect(caller(), "thread-worker", "pivot to the hotfix", false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cancelled).toBe("cancelled");
    expect(res.fresh).toBe(false);

    // (a) Reused the steer-now canceller, escalated to force.
    expect(abortTurn).toHaveBeenCalledWith("discord:thread-worker", { force: true });
    // Keep-context: NO session reset when fresh=false.
    expect(invalidate).not.toHaveBeenCalled();

    // (b) The in-flight handoff is marked interrupted so its report-back is skipped.
    expect((orch as any).interruptedDispatches.has("disp-A")).toBe(true);

    // (c) A fresh LIVE dispatch was enqueued into the SAME thread, framed as an
    // interrupt, reporting back to the interrupter.
    const specs = pendingSpecs();
    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.target).toBe("thread-worker");
    expect(spec.session).toBe("live");
    expect(spec.returnTo).toBe("thread-boss");
    expect(spec.kind).toBe("handoff");
    expect(spec.id).toBe(res.dispatchId);
    expect(spec.correlationId).toBe(res.dispatchId);
    expect(spec.prompt).toContain("<seam-interrupt>");
    expect(spec.prompt).toContain("pivot to the hotfix");
    expect(spec.prompt).toContain("Abandon that partial work");
  });

  it("fresh:true resets the target session before redirecting (clean slate)", async () => {
    const { orch, invalidate } = makeOrch();
    (orch as any).activeLiveDispatch.set("thread-worker", "disp-A");

    const res = await orch.interruptRedirect(caller(), "thread-worker", "start over", true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fresh).toBe(true);
    // Session reset: clearAcpSession so the redirected turn starts fresh.
    expect(invalidate).toHaveBeenCalledWith("discord:thread-worker", { clearAcpSession: true });
    const spec = pendingSpecs()[0]!;
    expect(spec.prompt).toContain("session was reset");
  });

  it("no active turn on the target → degrades to immediate delivery (directive never lost)", async () => {
    // abortTurn reports idle (nothing running); interrupt still delivers.
    const abortTurn = vi.fn(async () => "idle");
    const { orch } = makeOrch({ abortTurn });
    // Note: NO activeLiveDispatch registered for the target.

    const res = await orch.interruptRedirect(caller(), "thread-idle", "do this next", false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cancelled).toBe("idle");
    // Nothing to suppress, but the directive is still enqueued.
    expect((orch as any).interruptedDispatches.size).toBe(0);
    const specs = pendingSpecs();
    expect(specs).toHaveLength(1);
    expect(specs[0]!.target).toBe("thread-idle");
    expect(specs[0]!.prompt).toContain("do this next");
  });

  it("rejects an empty message before touching the target", async () => {
    const { orch, abortTurn } = makeOrch();
    const res = await orch.interruptRedirect(caller(), "thread-worker", "   ", false);
    expect(res.ok).toBe(false);
    expect(abortTurn).not.toHaveBeenCalled();
    expect(pendingSpecs()).toHaveLength(0);
  });
});

describe("dispatchInjectTurn report-back suppression on interrupt (#67)", () => {
  it("an interrupted handoff delivers NO report-back to its returnTo (the easy-to-forget bug)", async () => {
    const { orch, abortTurn } = makeOrch();
    const reportBack = vi.fn(async () => {});
    (orch as any).enqueueReportBack = reportBack;

    // The worker's live turn: WHILE it runs, a teammate fires an interrupt at the
    // same thread. This is the real timing — the interrupt marks the in-flight
    // dispatch, then the cancelled turn returns partial output.
    (orch as any).injectTurn = async () => {
      await orch.interruptRedirect(
        caller({ id: "discord:thread-interrupter", channelRef: "thread-interrupter" }),
        "thread-worker",
        "drop it — do the hotfix",
        false
      );
      return { text: "partial, stale work", error: undefined, stopReason: "cancelled" };
    };

    const original: DispatchSpec = {
      id: "disp-original",
      target: "thread-worker",
      prompt: "the original handoff task",
      session: "live",
      returnTo: "thread-boss",
      kind: "handoff",
      correlationId: "corr-original",
      createdUtc: new Date().toISOString(),
    };
    await orch.dispatchInjectTurn(original);

    // The cancel machinery ran against the target...
    expect(abortTurn).toHaveBeenCalledWith("discord:thread-worker", { force: true });
    // ...and — the whole point — the aborted handoff's report-back was SKIPPED:
    // its partial/stale output never reaches thread-boss.
    expect(reportBack).not.toHaveBeenCalled();
    // The flag was consumed (no leak).
    expect((orch as any).interruptedDispatches.has("disp-original")).toBe(false);

    // The interrupt's OWN fresh directive was enqueued into the same thread,
    // reporting back to the interrupter instead.
    const redirect = pendingSpecs().find((s) => s.prompt.includes("<seam-interrupt>"));
    expect(redirect).toBeTruthy();
    expect(redirect!.target).toBe("thread-worker");
    expect(redirect!.returnTo).toBe("thread-interrupter");
  });

  /**
   * #174 × #67. The suppression decision lives only in memory, but the
   * done-file that survives the process copies the spec's `returnTo`/`chainId`
   * unconditionally. If the ledger write then fails (the shutdown race #174 is
   * about), boot replay reads that routing and delivers the report-back the
   * interrupt deliberately withheld — the stale answer landing after the
   * directive that replaced it. So the error that carries the turn into the
   * done-file has to carry the suppression too.
   */
  it("marks an interrupted completion as suppressed when the ledger write fails", async () => {
    const { orch } = makeOrch();
    (orch as any).enqueueReportBack = vi.fn(async () => {});
    (orch as any).injectTurn = async () => {
      await orch.interruptRedirect(
        caller({ id: "discord:thread-interrupter", channelRef: "thread-interrupter" }),
        "thread-worker",
        "drop it — do the hotfix",
        false
      );
      return { text: "partial, stale work", error: undefined, stopReason: "cancelled" };
    };
    // The store closes underneath the completion — the exact #174 failure.
    (orch as any).store.updateDelegationStatus = () => {
      throw new TypeError("The database connection is not open");
    };

    const spec: DispatchSpec = {
      id: "disp-suppressed",
      target: "thread-worker",
      prompt: "the original handoff task",
      session: "live",
      returnTo: "thread-boss",
      kind: "handoff",
      correlationId: "corr-suppressed",
      createdUtc: new Date().toISOString(),
    };
    const err = await orch.dispatchInjectTurn(spec).then(
      () => null,
      (e: unknown) => e as DispatchTurnError
    );
    expect(err).toBeInstanceOf(DispatchTurnError);
    expect(err!.completionPending).toBe(true); // row left non-terminal…
    expect(err!.suppressedOnward).toBe(true); // …but nothing is owed onward
    // And the routing that reaches the done-file is now inert.
    expect(
      completionRoute(
        { returnTo: spec.returnTo, kind: "handoff", suppressedOnward: err!.suppressedOnward },
        { status: "running", kind: "handoff" }
      )
    ).toEqual({ action: "terminalize" });
  });

  it("does NOT mark a plain completion failure as suppressed (negative control)", async () => {
    const { orch } = makeOrch();
    (orch as any).enqueueReportBack = async () => {
      throw new TypeError("The database connection is not open");
    };
    (orch as any).injectTurn = async () => ({
      text: "clean result",
      error: undefined,
      stopReason: "end_turn",
    });

    const spec: DispatchSpec = {
      id: "disp-owed",
      target: "thread-worker",
      prompt: "a normal handoff",
      session: "live",
      returnTo: "thread-boss",
      kind: "handoff",
      correlationId: "corr-owed",
      createdUtc: new Date().toISOString(),
    };
    const err = await orch.dispatchInjectTurn(spec).then(
      () => null,
      (e: unknown) => e as DispatchTurnError
    );
    expect(err).toBeInstanceOf(DispatchTurnError);
    expect(err!.completionPending).toBe(true);
    expect(err!.suppressedOnward).toBe(false);
    // Nothing was interrupted, so the report-back is still owed and replayed.
    expect(
      completionRoute(
        { returnTo: spec.returnTo, kind: "handoff", suppressedOnward: err!.suppressedOnward },
        { status: "running", kind: "handoff" }
      )
    ).toEqual({ action: "report_back", returnTo: "thread-boss" });
  });

  it("a normal (un-interrupted) handoff still reports back to its returnTo (no regression)", async () => {
    const { orch } = makeOrch();
    const reportBack = vi.fn(async () => {});
    (orch as any).enqueueReportBack = reportBack;
    (orch as any).injectTurn = async () => ({ text: "clean result", error: undefined, stopReason: "end_turn" });

    const spec: DispatchSpec = {
      id: "disp-normal",
      target: "thread-worker",
      prompt: "a normal handoff",
      session: "live",
      returnTo: "thread-boss",
      kind: "handoff",
      correlationId: "corr-normal",
      createdUtc: new Date().toISOString(),
    };
    await orch.dispatchInjectTurn(spec);

    // Nothing interrupted it, so report-back fires exactly once, as before.
    expect(reportBack).toHaveBeenCalledTimes(1);
    expect(reportBack.mock.calls[0]![0]).toMatchObject({ id: "disp-normal" });
  });
});
