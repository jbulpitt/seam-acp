import { describe, expect, it } from "vitest";
import { projectAttemptCard } from "../packages/core/src/core/attempt-card-projection.js";
import type { TurnAttempt } from "../packages/core/src/core/dispatch/attempt-store.js";

const base = (): TurnAttempt => ({
  id: "inbound-1",
  generation: 1,
  ownerBoot: "old-owner",
  state: "active",
  identity: "identity",
  spec: {
    id: "inbound-1",
    target: "worker",
    prompt: "not rendered",
    session: "live",
    kind: "parked",
    createdUtc: "2026-09-23T06:47:33.278Z",
  },
  acpSessionId: "acp-1",
  promptStarted: true,
  outcome: null,
  runtimeOwner: null,
  providerIdentity: "synthetic",
  source: "inbound",
  deliveryDone: false,
  deliveryProtocol: false,
  deliveryNonce: null,
  deliveryChannel: null,
  deliveryPayload: null,
  deliveryStartedUtc: null,
  deliveryAbandonedReason: null,
  deliveryUncertainReason: null,
  updatedUtc: "2026-09-23T06:48:12.685Z",
  stalledUtc: null,
  stalledReason: null,
  stallNoticeUtc: null,
});

describe("durable attempt status-card projection (#576)", () => {
  it("keeps cancellation, suspension, supersession and failure visibly distinct", () => {
    const invocation = base();
    const cancelled = projectAttemptCard({
      ...base(),
      state: "cancelled",
      outcome: {
        id: "inbound-1",
        target: "worker",
        status: "failed",
        error: "cancelled by operator",
        finishedUtc: "2026-09-23T06:48:12.685Z",
      },
    }, invocation);
    const suspended = projectAttemptCard({ ...base(), state: "suspended" }, invocation);
    const superseded = projectAttemptCard({
      ...base(),
      generation: 2,
      ownerBoot: "new-owner",
    }, invocation);
    const failed = projectAttemptCard({
      ...base(),
      state: "completed",
      outcome: {
        id: "inbound-1",
        target: "worker",
        status: "failed",
        error: "provider disconnected",
        finishedUtc: "2026-09-23T06:48:12.685Z",
      },
    }, invocation);

    // Protects operator intent: deleting this assertion makes cancellation read
    // like an arbitrary provider failure instead of the durable cancelled row.
    expect(cancelled).toEqual({ state: "Failed", action: "Cancelled" });
    // Protects restart recovery: deleting this assertion makes retained work look
    // terminally failed even though the ledger says it is resumable.
    expect(suspended).toEqual({ state: "Waiting", action: "Suspended — awaiting recovery" });
    // Protects replacement ownership: deleting this assertion lets the stale card
    // claim completion or failure while a newer generation still owns the work.
    expect(superseded).toEqual({
      state: "Waiting",
      action: "Superseded — a newer attempt owns this turn",
    });
    // Protects real failures: deleting this assertion erases the durable failure
    // reason and makes it indistinguishable from cancellation.
    expect(failed).toEqual({ state: "Failed", action: "Failed — provider disconnected" });
    expect(new Set([cancelled?.action, suspended?.action, superseded?.action, failed?.action]).size).toBe(4);
  });

  it("refuses to infer a terminal card from the same active generation", () => {
    const attempt = base();
    // Protects the active-owner guard: deleting this check lets an in-flight turn
    // terminalize its own card without any durable terminal or replacement fact.
    expect(projectAttemptCard(attempt, attempt)).toBeNull();
  });
});
