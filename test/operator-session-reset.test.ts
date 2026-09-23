import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { DispatchSuspendedError } from "../packages/core/src/core/dispatch/attempt-store.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
let dir: string;
let store: SessionStore;
let router: SessionRouter;
const identity = executionIdentity({
  agent: "codex",
  location: "local",
  session: "live",
  model: "default",
  effort: "high",
  cwd: "/repo",
  config: {},
});

function spec(id: string, target = "worker"): DispatchSpec {
  return {
    id,
    target,
    prompt: "synthetic private task",
    session: "live",
    kind: "handoff",
    createdUtc: "2026-09-23T08:00:00.000Z",
  };
}

function suspended(id: string, acpSessionId: string, target = "worker"): void {
  const dispatch = spec(id, target);
  store.turnAttempts.registerOwner("fixture-boot");
  store.turnAttempts.admit(dispatch);
  const attempt = store.turnAttempts.claim(dispatch, identity, "fixture-boot");
  store.turnAttempts.bind(attempt, acpSessionId);
  expect(store.turnAttempts.suspend(id, "fixture-boot")).toBe(true);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "seam-580-reset-"));
  store = new SessionStore(path.join(dir, "seam.db"));
  store.upsert({
    id: "discord:worker",
    platform: "discord",
    channelRef: "worker",
    parentRef: "channel",
    agentId: "codex",
    acpSessionId: "acp-old",
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: "2026-09-23T08:00:00.000Z",
    updatedUtc: "2026-09-23T08:00:00.000Z",
  });
  router = new SessionRouter({
    logger,
    store,
    profiles: [],
    modelCatalog: fixtureModelCatalog([]),
    defaultAgentId: "codex",
    defaultModel: "default",
  });
});

afterEach(async () => {
  await router.disposeAll();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("#580 operator session replacement", () => {
  it("settles only nonterminal dispatches bound to the operator-replaced session", async () => {
    suspended("old-bound", "acp-old");
    suspended("other-session", "acp-other");
    suspended("other-target", "acp-old", "different-worker");
    const finishedSpec = spec("already-finished");
    const finished = store.turnAttempts.claim(finishedSpec, identity, "fixture-boot");
    store.turnAttempts.bind(finished, "acp-old");
    expect(store.turnAttempts.complete(finished, {
      id: finished.id,
      target: finishedSpec.target,
      status: "completed",
      output: "synthetic result",
      finishedUtc: "2026-09-23T08:00:01.000Z",
    })).toBe(true);

    await router.invalidate("discord:worker", {
      operatorIntent: "replace-session",
    });

    // Removing the explicit intent settlement revives Jesse's reset dispatch at every boot.
    expect(store.turnAttempts.get("old-bound")).toMatchObject({
      state: "cancelled",
      outcome: {
        error: "cancelled because an operator replaced the bound ACP session",
        suppressedOnward: true,
      },
    });
    // Removing receipt separation would let silent settlement masquerade as delivered output.
    expect(store.turnAttempts.isDeliveryProven("old-bound")).toBe(false);
    // Removing either binding predicate lets one reset cancel another thread or conversation.
    expect(store.turnAttempts.get("other-session")?.state).toBe("suspended");
    expect(store.turnAttempts.get("other-target")?.state).toBe("suspended");
    expect(store.turnAttempts.get("already-finished")?.state).toBe("completed");
  });

  it("leaves timeout and warm-eviction clears recoverable when operator intent is absent", async () => {
    suspended("runtime-failure", "acp-old");

    await router.invalidate("discord:worker", { clearAcpSession: true });

    // Removing this distinction silently swallows genuine timeout/eviction failures.
    expect(store.turnAttempts.get("runtime-failure")?.state).toBe("suspended");
    const sendMessage = vi.fn(async () => ({ id: "warning" }));
    const observer = Object.assign(Object.create(Orchestrator.prototype) as Orchestrator, {
      store,
      adapter: { sendMessage },
      logger,
    });
    await observer.observeRetainedDispatch(
      spec("runtime-failure"),
      DispatchSuspendedError.defect("runtime-failure", "runtime disappeared")
    );
    // Removing the warning projection would turn a preserved failure into silent limbo.
    expect(sendMessage).toHaveBeenCalledWith(
      { platform: "discord", id: "worker" },
      expect.stringContaining("could not resume: runtime disappeared")
    );
  });

  it("does not re-arm an identical stall notice after a failed reclaim", () => {
    suspended("repeat", "acp-old");
    const attempts = store.turnAttempts;
    const reason = "Strict resume refused: thread now belongs to a different ACP session";
    expect(attempts.markStalled("repeat", reason, "2026-09-23T08:01:00.000Z")).toBe(true);
    expect(attempts.markStallNoticeDelivered("repeat", "2026-09-23T08:02:00.000Z")).toBe(true);
    // The live #580 row predates stall_notice_reason; claim must carry its
    // already-delivered reason forward during the schema transition.
    (store as unknown as { db: { prepare(sql: string): { run(id: string): void } } }).db
      .prepare("UPDATE turn_attempts SET stall_notice_reason=NULL WHERE id=?")
      .run("repeat");
    const reclaimed = attempts.claim(spec("repeat"), identity, "fixture-boot");
    expect(reclaimed.state).toBe("active");

    expect(attempts.markStalled("repeat", reason, "2026-09-23T08:31:00.000Z")).toBe(true);

    // Removing durable same-reason dedup recreates the byte-identical once-per-boot warning.
    expect(attempts.get("repeat")).toMatchObject({
      state: "suspended",
      stalledUtc: "2026-09-23T08:01:00.000Z",
      stallNoticeUtc: "2026-09-23T08:02:00.000Z",
      stallNoticeReason: reason,
      stalledReason: reason,
    });
    // Removing the preserved notice makes the observer send the same warning again.
    expect(attempts.markStallNoticeDelivered("repeat")).toBe(false);
  });
});
