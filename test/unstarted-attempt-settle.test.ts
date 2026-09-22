/**
 * #559 — an active claim that never reached session/prompt stays
 * `assigned_not_started` forever unless something settles it.
 *
 * The sweep is the net: active, prompt_started=0, no session, and a later
 * non-isolated completion on the same target (finishedUtc, not a later
 * touch of updated_utc). prompt_started=1 is #428 and must survive.
 * Deleting the predicate, or keying it on updated_utc, fails the tests
 * below. The watcher tick is what runs it during operation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  UNSTARTED_SUPERSEDED_REASON,
  type TurnAttemptStore,
} from "../packages/core/src/core/dispatch/attempt-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;

function spec(id: string, target = "thread-1", session: "live" | "isolated" = "live"): DispatchSpec {
  return {
    id,
    target,
    prompt: id,
    session,
    kind: "handoff",
    correlationId: id,
    createdUtc: "2026-09-22T09:45:28.000Z",
  };
}

describe("settleSupersededUnstartedAttempts", () => {
  const dirs: string[] = [];
  const stores: SessionStore[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function attempts() {
    const dir = await mkdtemp(path.join(tmpdir(), "seam-559-"));
    dirs.push(dir);
    const store = new SessionStore(path.join(dir, "t.db"));
    stores.push(store);
    return store.turnAttempts;
  }

  function claim(store: TurnAttemptStore, id: string, target = "thread-a", session: "live" | "isolated" = "live") {
    return store.claim(store.admit(spec(id, target, session)), "identity", "boot-1");
  }

  function complete(store: TurnAttemptStore, id: string, target: string, finishedUtc: string, session: "live" | "isolated" = "live") {
    const row = claim(store, id, target, session);
    store.bind(row, `acp-${id}`);
    store.startPrompt(row);
    expect(store.complete(row, {
      id, target, status: "completed", finishedUtc,
    })).toBe(true);
  }

  it("cancels an active never-started row once a later attempt on the target has completed", async () => {
    const store = await attempts();
    const stranded = claim(store, "stranded");
    complete(store, "later", "thread-a", "2099-01-01T00:00:00.000Z");
    expect(store.settleSupersededUnstartedAttempts()).toEqual([
      { target: "thread-a", settledId: "stranded", laterId: "later" },
    ]);
    expect(store.get("stranded")).toMatchObject({
      state: "cancelled",
      promptStarted: false,
      acpSessionId: null,
      generation: stranded.generation,
      outcome: { error: UNSTARTED_SUPERSEDED_REASON, suppressedOnward: true },
    });
    expect(store.settleSupersededUnstartedAttempts()).toEqual([]);
  });

  it("does not treat an older completion as supersession, even if its updated_utc moves later", async () => {
    const store = await attempts();
    complete(store, "older", "thread-a", "2020-01-01T00:00:00.000Z");
    const stranded = claim(store, "stranded");
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } })
      .db.prepare("UPDATE turn_attempts SET updated_utc=? WHERE id=?").run("2099-01-01T00:00:00.000Z", "older");
    expect(store.get("older")?.updatedUtc).toBe("2099-01-01T00:00:00.000Z");
    expect(stranded.updatedUtc < "2099-01-01T00:00:00.000Z").toBe(true);
    expect(store.settleSupersededUnstartedAttempts()).toEqual([]);
    expect(store.get("stranded")?.state).toBe("active");
  });

  it("does not cancel a prompted row, a bound session, an isolated completion, or another target", async () => {
    const store = await attempts();
    const prompted = claim(store, "prompted");
    store.bind(prompted, "acp-prompted");
    store.startPrompt(prompted);
    const bound = claim(store, "bound");
    store.bind(bound, "acp-bound");
    claim(store, "stranded");
    claim(store, "other-target", "thread-b");
    complete(store, "later", "thread-a", "2099-01-01T00:00:00.000Z");
    complete(store, "isolated-later", "thread-b", "2099-01-01T00:00:00.000Z", "isolated");
    expect(store.settleSupersededUnstartedAttempts()).toEqual([
      { target: "thread-a", settledId: "stranded", laterId: "later" },
    ]);
    expect(store.get("prompted")).toMatchObject({ state: "active", promptStarted: true });
    expect(store.get("bound")).toMatchObject({ state: "active", promptStarted: false, acpSessionId: "acp-bound" });
    expect(store.get("other-target")?.state).toBe("active");
  });

  it("releases a superseded unstarted claim and leaves a started prompt alone", async () => {
    const store = await attempts();
    const open = claim(store, "open");
    expect(store.releaseUnstartedClaim(open, "superseded", "the channel queue was fenced to a newer epoch"))
      .toBe("cancelled");
    expect(store.get("open")).toMatchObject({
      state: "cancelled",
      promptStarted: false,
      outcome: { error: "the channel queue was fenced to a newer epoch" },
    });
    const shutdown = claim(store, "shutdown");
    expect(store.releaseUnstartedClaim(shutdown, "shutdown", "restart cutoff")).toBe("suspended");
    expect(store.get("shutdown")).toMatchObject({ state: "suspended", stalledUtc: null });
    const defect = claim(store, "defect");
    expect(store.releaseUnstartedClaim(defect, "defect", "provider acquisition failed")).toBe("stalled");
    expect(store.get("defect")).toMatchObject({
      state: "suspended",
      stalledReason: "provider acquisition failed",
    });
    const started = claim(store, "started");
    store.bind(started, "acp-started");
    store.startPrompt(started);
    expect(store.releaseUnstartedClaim(started, "superseded", "fenced")).toBe("unchanged");
    expect(store.get("started")?.state).toBe("active");
  });
});

describe("watcher tick settles a stranded unstarted attempt during operation", () => {
  const dirs: string[] = [];
  const stores: SessionStore[] = [];
  const watchers: DispatchWatcher[] = [];
  afterEach(async () => {
    for (const watcher of watchers.splice(0)) watcher.stop();
    for (const store of stores.splice(0)) store.close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("cancels the active row on a tick, without owner_boot and without running it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "seam-559-watch-"));
    dirs.push(dir);
    const store = new SessionStore(path.join(dir, "t.db"));
    stores.push(store);
    const attempts = store.turnAttempts;
    const stranded = attempts.claim(attempts.admit(spec("stranded", "thread-a")), "identity", "live-boot");
    const later = attempts.claim(attempts.admit(spec("later", "thread-a")), "identity", "live-boot");
    attempts.bind(later, "acp-later");
    attempts.startPrompt(later);
    attempts.complete(later, {
      id: "later", target: "thread-a", status: "completed", finishedUtc: "2099-01-01T00:00:00.000Z",
    });
    const seen: string[] = [];
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger,
      attempts,
      onDispatch: async (dispatched) => {
        seen.push(dispatched.id);
        return { output: "ran", stopReason: "end_turn" };
      },
    });
    watchers.push(watcher);
    await watcher.start({ waitForInitialDispatches: true });
    expect(seen).toEqual([]);
    expect(attempts.get("stranded")).toMatchObject({
      state: "cancelled",
      ownerBoot: stranded.ownerBoot,
      outcome: { error: UNSTARTED_SUPERSEDED_REASON },
    });
    expect(attempts.get("later")?.state).toBe("completed");
  });
});
