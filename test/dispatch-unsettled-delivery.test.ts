/**
 * #419 — a completion whose onward delivery was suppressed never settled, and
 * the state it was left in was invisible to every operator control.
 *
 * `b27578fe-528b-4b3e-a227-e0ec00c340a5` was a card-click dispatch that
 * COMPLETED successfully at 17:36:57 on 2026-09-17 and then sat holding thread
 * `1516907689874161764` for ~25 minutes. Its row, verbatim from the live
 * database, had:
 *
 *     state                     = completed
 *     delivery_done             = 0
 *     delivery_started_utc      = (null)   <- transport never began
 *     delivery_abandoned_reason = (null)
 *     delivery_uncertain_reason = (null)
 *     stalled_utc               = (null)   <- so /seam workflows cannot see it
 *     outcome_json              = ... inlinedReportBack, suppressedOnward ...
 *
 * `isDeliveryDispositionTerminal` needs one of deliveryDone / abandoned /
 * uncertain. It had none, so it was neither done nor failed — permanently
 * outstanding.
 *
 * Two halves are tested, and the second matters more: fixing the trigger alone
 * would leave the NEXT unsettled completion equally unrecoverable.
 *
 * The distinction this file guards hardest is that settling is not delivering.
 * `markDeliveryDone` asserts the output was transported; `isDeliveryProven`
 * exists to stop a terminal refusal reading as transport proof, and its comment
 * warns that removing that check makes retained output deletable. So every
 * assertion below that checks the disposition also checks `deliveryDone` is
 * still false.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  TurnAttemptStore,
  suppressedOnwardDeliveryReason,
} from "../packages/core/src/core/dispatch/attempt-store.js";
import type { DispatchResult, DispatchSpec } from "../packages/core/src/core/dispatch/types.js";

let dir: string;
let db: Database.Database;
let store: TurnAttemptStore;

const TARGET = "1516907689874161764";
const BOOT = "f56b56cb-1fff-49f3-bfda-cc5f81bac3f7";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-419-"));
  db = new Database(path.join(dir, "t.db"));
  store = new TurnAttemptStore(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The card-click spec shape, from the preserved row. */
function spec(id: string): DispatchSpec {
  return {
    id, target: TARGET, session: "live",
    prompt: `<seam-choice>\nCard ZVFNU6eQdzhQ option "Test and reconcile (Recommended)" clicked`,
    createdUtc: "2026-09-17T22:36:00.000Z",
  } as DispatchSpec;
}

/** Drive an attempt to the point where the live path records its outcome. */
function completeWith(id: string, outcome: Partial<DispatchResult>): void {
  store.admit(spec(id));
  const claimed = store.claim(spec(id), "identity", BOOT);
  store.complete(claimed, {
    id, target: TARGET, status: "completed",
    output: "I'm proceeding with the approved repair.",
    finishedUtc: "2026-09-17T22:36:57.301Z",
    ...outcome,
  } as DispatchResult);
}

describe("#419 the trigger: suppressing delivery settles the disposition", () => {
  it("settles an inlined card report-back instead of leaving it outstanding", () => {
    // The exact b27578fe shape.
    completeWith("b27578fe", { inlinedReportBack: true, suppressedOnward: true });
    const row = store.get("b27578fe")!;
    expect(row.state).toBe("completed");
    expect(store.isDeliveryDispositionTerminal("b27578fe")).toBe(true);
    expect(row.deliveryAbandonedReason).toMatch(/inlined onto the card/);
    // Settled is NOT delivered. This is the line that must never relax.
    expect(row.deliveryDone).toBe(false);
    expect(store.isDeliveryProven("b27578fe")).toBe(false);
  });

  it("settles an interrupt-suppressed completion, naming a different cause", () => {
    completeWith("superseded-1", { suppressedOnward: true });
    const row = store.get("superseded-1")!;
    expect(store.isDeliveryDispositionTerminal("superseded-1")).toBe(true);
    expect(row.deliveryAbandonedReason).toMatch(/superseded before transport/);
    expect(row.deliveryDone).toBe(false);
  });

  it("leaves an ordinary completion owing delivery, which is the whole point", () => {
    // The dangerous direction. Settling a completion whose report-back is still
    // in flight silently drops the answer — worse than a blocked thread,
    // because a blocked thread is at least visible.
    completeWith("ordinary", { returnTo: "caller-thread" });
    const row = store.get("ordinary")!;
    expect(row.deliveryAbandonedReason).toBeNull();
    expect(store.isDeliveryDispositionTerminal("ordinary")).toBe(false);
  });

  it("settles in the same write as the completion, leaving no window", () => {
    // A follow-up call would be the same hole, just narrower: a crash between
    // the two writes reproduces exactly the row this fixes. One statement means
    // no interleaving can observe completed-without-disposition.
    completeWith("atomic", { inlinedReportBack: true });
    const raw = db.prepare(
      "SELECT state, delivery_done, delivery_abandoned_reason FROM turn_attempts WHERE id=?"
    ).get("atomic") as { state: string; delivery_done: number; delivery_abandoned_reason: string | null };
    expect(raw.state).toBe("completed");
    expect(raw.delivery_abandoned_reason).not.toBeNull();
    expect(raw.delivery_done).toBe(0);
  });

  it("cannot rewrite an operator's abandon reason, because it only matches an active row", () => {
    // The settlement rides on `complete()`, whose WHERE clause is
    // `state='active'`. Once an operator has abandoned a completed attempt the
    // row is no longer active, so no later completion can reach it — the reason
    // they wrote is what survives. (The COALESCE in the UPDATE is belt and
    // braces for a future path that settles earlier; it is not load-bearing
    // today, and this asserts the guard that actually is.)
    completeWith("pre-settled", { returnTo: "caller" });
    expect(store.abandonDelivery("pre-settled", "operator abandoned this first")).toBe(true);
    const stale = { id: "pre-settled", generation: 1, ownerBoot: BOOT } as never;
    expect(store.complete(stale, {
      id: "pre-settled", target: TARGET, status: "completed", output: "x",
      inlinedReportBack: true, finishedUtc: "2026-09-17T22:40:00.000Z",
    } as DispatchResult)).toBe(false);
    expect(store.get("pre-settled")!.deliveryAbandonedReason).toBe("operator abandoned this first");
  });
});

describe("#419 the predicate, narrowly", () => {
  it("fires on exactly the two intentional-suppression flags", () => {
    expect(suppressedOnwardDeliveryReason({ inlinedReportBack: true })).toMatch(/inlined/);
    expect(suppressedOnwardDeliveryReason({ suppressedOnward: true })).toMatch(/superseded/);
  });

  it.each([
    ["nothing set", {}],
    ["both explicitly false", { suppressedOnward: false, inlinedReportBack: false }],
    ["a returnTo alone", { returnTo: "caller" }],
    ["a chainId alone", { chainId: "chain-1" }],
  ])("returns null for %s, so delivery stays owed", (_label, outcome) => {
    expect(suppressedOnwardDeliveryReason(outcome as DispatchResult)).toBeNull();
  });

  it("names transport explicitly in both reasons", () => {
    // An operator reading the row later must be able to tell "we chose not to
    // send it" from "we sent it".
    for (const o of [{ inlinedReportBack: true }, { suppressedOnward: true }]) {
      expect(suppressedOnwardDeliveryReason(o)).toMatch(/transport/);
      expect(suppressedOnwardDeliveryReason(o)).toMatch(/suppressed/);
    }
  });
});

describe("#419 the trap: unsettled completions are reachable by an operator", () => {
  /** Force the pre-fix row shape directly, since the fix now prevents it. */
  function forceUnsettled(id: string): void {
    completeWith(id, { inlinedReportBack: true });
    db.prepare("UPDATE turn_attempts SET delivery_abandoned_reason=NULL WHERE id=?").run(id);
  }

  it("lists a completed attempt that has no delivery disposition at all", () => {
    forceUnsettled("b27578fe");
    expect(store.isDeliveryDispositionTerminal("b27578fe")).toBe(false);
    expect(store.listUnsettledCompletions().map((a) => a.id)).toEqual(["b27578fe"]);
    expect(store.listUnsettledCompletions(TARGET).map((a) => a.id)).toEqual(["b27578fe"]);
  });

  it("does not list attempts that are already settled, by any of the three routes", () => {
    completeWith("done", { returnTo: "c" });
    store.prepareDelivery("done", "chan", { kind: "text", body: "x" } as never);
    store.markDeliveryDone("done");
    completeWith("abandoned", { returnTo: "c" });
    store.abandonDelivery("abandoned", "refused");
    completeWith("uncertain", { returnTo: "c" });
    store.markDeliveryUncertain("uncertain", "ambiguous");
    expect(store.listUnsettledCompletions()).toEqual([]);
  });

  it("does not list an attempt that is still running, which is not stuck", () => {
    store.admit(spec("running"));
    store.claim(spec("running"), "identity", BOOT);
    expect(store.listUnsettledCompletions()).toEqual([]);
  });

  it("scopes to the asking thread, so one thread's problem is not another's", () => {
    forceUnsettled("mine");
    store.admit({ ...spec("theirs"), target: "other-thread" });
    const other = store.claim({ ...spec("theirs"), target: "other-thread" }, "identity", BOOT);
    store.complete(other, {
      id: "theirs", target: "other-thread", status: "completed", output: "x",
      finishedUtc: "2026-09-17T22:36:57.301Z",
    } as DispatchResult);
    expect(store.listUnsettledCompletions(TARGET).map((a) => a.id)).toEqual(["mine"]);
  });

  it("maps a real unsettled attempt into an actionable workflows row", async () => {
    // Drives the ACTUAL mapping the orchestrator uses, from a real store row —
    // the previous version of this test built the row by hand and so never
    // exercised the code under change. Mutation testing caught that.
    const { interruptedRowForCompletedAttempt, interruptedRowActions } = await import(
      "../packages/core/src/platforms/discord/workflows-view.js");
    forceUnsettled("b27578fe");
    const attempt = store.get("b27578fe")!;
    const row = interruptedRowForCompletedAttempt(attempt)!;
    expect(row).not.toBeNull();
    expect(row.id).toBe("b27578fe");
    expect(row.status).toBe("interrupted");
    expect(row.targetRef).toBeNull();
    expect(row.reason).toMatch(/holds thread admission until abandoned/);
    expect(interruptedRowActions(row)).toEqual(["abandon"]);
  });

  it("maps a settled attempt the way it always did, and a delivered one not at all", async () => {
    const { interruptedRowForCompletedAttempt } = await import(
      "../packages/core/src/platforms/discord/workflows-view.js");
    completeWith("abandoned", { returnTo: "c" });
    store.abandonDelivery("abandoned", "refused");
    const abandonedRow = interruptedRowForCompletedAttempt(store.get("abandoned")!)!;
    expect(abandonedRow.status).toBe("abandoned");
    expect(abandonedRow.targetRef).toBe(TARGET);

    completeWith("done", { returnTo: "c" });
    store.prepareDelivery("done", "chan", { kind: "text", body: "x" } as never);
    store.markDeliveryDone("done");
    expect(interruptedRowForCompletedAttempt(store.get("done")!)).toBeNull();
  });

  it("an unsettled row is offered Abandon and NOT Resume", async () => {
    // The `/seam workflows` inventory decides controls from `status` and
    // `targetRef` (#159). An unsettled completion must be "interrupted"
    // (actionable) with a null targetRef (no Resume) — marking it "abandoned"
    // would list the trap and still offer no way out, and offering Resume
    // would re-run a turn that already ran.
    const { buildInterruptedInventory, interruptedRowActions } = await import(
      "../packages/core/src/platforms/discord/workflows-view.js");
    const row = {
      id: "b27578fe", source: "dispatch" as const, channelRef: TARGET,
      correlationId: null, status: "interrupted" as const,
      startedUtc: "2026-09-17T22:36:57.301Z", acpSessionId: "01a078e3",
      targetRef: null,
      reason: "completed but never settled its delivery disposition; it holds thread admission until abandoned",
    };
    // Abandon offered, Resume withheld — the precise control set.
    expect(interruptedRowActions(row)).toEqual(["abandon"]);

    // And it lands in the ACTIONABLE section, not the inert one. Listing it as
    // inert would show the trap and still give no way out.
    const slice = buildInterruptedInventory([row], 0, new Date());
    expect(slice.actionable).not.toBeNull();
    expect(slice.inert).toBeNull();
    expect(slice.actionable!.value).toContain("b27578fe");

    // The pre-fix shape, for contrast: had it been listed "abandoned", #159
    // would correctly give it no controls at all.
    expect(interruptedRowActions({ ...row, status: "abandoned" })).toEqual([]);
  });

  it("is reachable by the same abandon the operator already has", () => {
    // End to end: the state that trapped b27578fe is now visible AND clearable,
    // with the truthful terminal reason rather than a delivery claim.
    forceUnsettled("b27578fe");
    const [found] = store.listUnsettledCompletions(TARGET);
    expect(found!.id).toBe("b27578fe");
    expect(store.abandonDelivery(found!.id, "transport never started")).toBe(true);
    expect(store.isDeliveryDispositionTerminal("b27578fe")).toBe(true);
    expect(store.isDeliveryProven("b27578fe")).toBe(false);
    expect(store.listUnsettledCompletions(TARGET)).toEqual([]);
  });
});
