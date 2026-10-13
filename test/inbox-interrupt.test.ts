import { testSessionRouter } from "./helpers/session-fixture.js";
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
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

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
  const router = testSessionRouter({
    listProfiles: () => [],
    describeConfig: (r: SessionRecord) => ({
      agent: { value: r.agentId, source: "session config" },
      model: { value: "claude-opus-4.8", source: "default" },
      effort: { value: null, source: "default" },
      location: { value: "local", source: "default" },
      cwd: { value: r.repoPath, source: "session config" },
    }),
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
  });
  const orch = new Orchestrator({
    modelCatalog: fixtureModelCatalog([]),
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      channelPresets: new Map(),
      threadPresets: new Map(),
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
  it("preserves the active dispatch and enqueues a next-turn directive", async () => {
    const { orch, abortTurn, invalidate } = makeOrch();
    // A live handoff is running in the target thread.
    (orch as any).activeLiveDispatch.set("thread-worker", "disp-A");

    const res = await orch.interruptRedirect(caller(), "thread-worker", "pivot to the hotfix", false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fresh).toBe(false);

    expect(abortTurn).not.toHaveBeenCalled();
    // Keep-context: NO session reset when fresh=false.
    expect(invalidate).not.toHaveBeenCalled();

    // The directive retains the same target and its own report-back route.
    const specs = pendingSpecs();
    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.target).toBe("thread-worker");
    expect(spec.session).toBe("live");
    expect(spec.interrupt).toEqual({ fresh: false });
    expect(spec.returnTo).toBe("thread-boss");
    expect(spec.kind).toBe("handoff");
    expect(spec.id).toBe(res.dispatchId);
    expect(spec.correlationId).toBe(res.dispatchId);
    expect(spec.prompt).toContain("<seam-interrupt>");
    expect(spec.prompt).toContain("pivot to the hotfix");
    expect(spec.prompt).toContain("previous turn was not cancelled");
  });

  it("fresh:true records a deferred reset without invalidating the active session", async () => {
    const { orch, invalidate } = makeOrch();
    (orch as any).activeLiveDispatch.set("thread-worker", "disp-A");

    const res = await orch.interruptRedirect(caller(), "thread-worker", "start over", true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fresh).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
    const spec = pendingSpecs()[0]!;
    expect(spec.interrupt).toEqual({ fresh: true });
    expect(spec.prompt).toContain("session was reset");
  });

  it("no active turn still enqueues the same next-turn directive", async () => {
    // No active runtime is needed to admit the directive.
    const abortTurn = vi.fn(async () => "idle");
    const { orch } = makeOrch({ abortTurn });
    // Note: NO activeLiveDispatch registered for the target.

    const res = await orch.interruptRedirect(caller(), "thread-idle", "do this next", false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(abortTurn).not.toHaveBeenCalled();
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

describe("dispatchInjectTurn report-back suppression on explicit cancellation", () => {
  it("an operator-cancelled handoff delivers no stale report-back", async () => {
    const { orch, abortTurn } = makeOrch();
    const reportBack = vi.fn(async () => {});
    (orch as any).enqueueReportBack = reportBack;

    // Explicit operator cancellation, not next-turn prioritization.
    (orch as any).injectTurn = async () => {
      store.turnAttempts.cancel("disp-original");
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
    // #250 cancellation is now a durable terminal winner, not successful
    // completion of the superseded task. Its empty outcome suppresses onward.
    await expect(orch.dispatchInjectTurn(original)).rejects.toMatchObject({
      name: "DispatchTurnError", suppressedOnward: true, stopReason: "cancelled",
    });

    expect(abortTurn).not.toHaveBeenCalled();
    // ...and — the whole point — the aborted handoff's report-back was SKIPPED:
    // its partial/stale output never reaches thread-boss.
    expect(reportBack).not.toHaveBeenCalled();
    expect(pendingSpecs()).toHaveLength(0);
  });

  // Explicit cancellation must keep report-back suppression in the durable error.
  it("marks an operator-cancelled completion as suppressed when the ledger write fails", async () => {
    const { orch } = makeOrch();
    (orch as any).enqueueReportBack = vi.fn(async () => {});
    (orch as any).injectTurn = async () => {
      store.turnAttempts.cancel("disp-suppressed");
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
    const reportBack = vi.fn(async (_spec: DispatchSpec) => {});
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
