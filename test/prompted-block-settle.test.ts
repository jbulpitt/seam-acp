/**
 * #428 — a prompted suspension holds its target ahead of work that has not
 * started. Settling it must not resend the interrupted prompt, and it must
 * not treat an empty owner_boot or a never-started suspension as the same
 * thing. Deleting the prompt_started check cancels work that has not billed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  PROMPTED_BLOCK_SETTLED_REASON,
  type TurnAttemptStore,
} from "../packages/core/src/core/dispatch/attempt-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;

function spec(id: string, target = "thread-1", prompt = id): DispatchSpec {
  return {
    id,
    target,
    prompt,
    session: "live",
    kind: "handoff",
    correlationId: id,
    createdUtc: "2026-09-22T04:48:31.200Z",
  };
}

describe("settleBlockedPromptedAttempts", () => {
  const dirs: string[] = [];
  const stores: SessionStore[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function attempts() {
    const dir = await mkdtemp(path.join(tmpdir(), "seam-428-"));
    dirs.push(dir);
    const store = new SessionStore(path.join(dir, "t.db"));
    stores.push(store);
    return store.turnAttempts;
  }

  function prompted(store: TurnAttemptStore, id: string, target: string) {
    const drafted = spec(id, target, "original prompt that already ran");
    store.admit(drafted);
    const claimed = store.claim(drafted, "identity", "boot-1");
    store.bind(claimed, "acp-1");
    store.startPrompt(claimed);
    store.suspend(claimed.id, "boot-1");
  }

  it("cancels a prompted suspension and leaves the never-started sibling pending", async () => {
    const store = await attempts();
    prompted(store, "blocked", "thread-a");
    store.admit(spec("waiting", "thread-a", "continue"));
    const settled = store.settleBlockedPromptedAttempts();
    expect(settled).toEqual([
      { target: "thread-a", settledId: "blocked", pendingIds: ["waiting"] },
    ]);
    expect(store.get("blocked")).toMatchObject({
      state: "cancelled",
      promptStarted: true,
      acpSessionId: "acp-1",
      outcome: { error: PROMPTED_BLOCK_SETTLED_REASON, suppressedOnward: true },
    });
    expect(store.get("waiting")).toMatchObject({
      state: "pending",
      promptStarted: false,
      ownerBoot: "",
      generation: 0,
    });
    expect(store.get("blocked")?.spec.prompt).toBe("original prompt that already ran");
  });

  it("does not settle a prompted suspension that has no never-started successor", async () => {
    const store = await attempts();
    prompted(store, "alone", "thread-a");
    expect(store.settleBlockedPromptedAttempts()).toEqual([]);
    expect(store.get("alone")?.state).toBe("suspended");
  });

  it("does not cancel a suspension that never started, even when a sibling is pending", async () => {
    const store = await attempts();
    const drafted = spec("never", "thread-a");
    store.admit(drafted);
    const claimed = store.claim(drafted, "identity", "boot-1");
    store.suspend(claimed.id, "boot-1");
    store.admit(spec("waiting", "thread-a"));
    expect(store.get("never")?.promptStarted).toBe(false);
    expect(store.settleBlockedPromptedAttempts()).toEqual([]);
    expect(store.get("never")?.state).toBe("suspended");
    expect(store.get("waiting")?.state).toBe("pending");
  });

  it("does not consult owner_boot, including an empty one", async () => {
    const store = await attempts();
    prompted(store, "blocked", "thread-a");
    store.admit(spec("waiting", "thread-a"));
    expect(store.get("waiting")?.ownerBoot).toBe("");
    expect(store.get("blocked")?.ownerBoot).toBe("boot-1");
    store.settleBlockedPromptedAttempts();
    expect(store.get("waiting")?.ownerBoot).toBe("");
    expect(store.get("blocked")?.state).toBe("cancelled");
  });
});

describe("watcher releases a prompted block ahead of never-started work", () => {
  const dirs: string[] = [];
  const stores: SessionStore[] = [];
  const watchers: DispatchWatcher[] = [];
  afterEach(async () => {
    for (const watcher of watchers.splice(0)) watcher.stop();
    for (const store of stores.splice(0)) store.close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("does not dispatch the interrupted prompt when a never-started sibling is waiting", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "seam-428-watch-"));
    dirs.push(dir);
    const store = new SessionStore(path.join(dir, "t.db"));
    stores.push(store);
    const attempts = store.turnAttempts;
    const blocked = spec("blocked", "thread-a", "original prompt that already ran");
    attempts.admit(blocked);
    const claimed = attempts.claim(blocked, "identity", "boot-1");
    attempts.bind(claimed, "acp-1");
    attempts.startPrompt(claimed);
    attempts.suspend(claimed.id, "boot-1");
    attempts.admit(spec("waiting", "thread-a", "continue"));
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
    expect(await watcher.requeueStale("blocked")).toBe(true);
    await watcher.start({ waitForInitialDispatches: true });
    watcher.stop();
    expect(seen).toEqual(["waiting"]);
    expect(attempts.get("blocked")).toMatchObject({ state: "cancelled", promptStarted: true });
    expect(attempts.get("waiting")?.promptStarted).toBe(false);
  });
});
