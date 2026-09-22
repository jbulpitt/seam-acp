/**
 * #423 — "the silent death": a card sits at Working… forever.
 *
 * The mechanism, confirmed live on 2026-09-19/20: something suspends an attempt
 * on a thread, that attempt holds the thread's queue with no timeout and no
 * retry, and every later message admits an attempt that stays `state=pending`,
 * `prompt_started=0` indefinitely. The card is rendered at ADMISSION, so it
 * shows Working… and never changes. Two of Jesse's threads sat that way for 7
 * and 13 hours while unrelated threads completed turns normally.
 *
 * Nothing about detection or repair was missing. `inspectChannelQueue` already
 * computed `state: "wedged"`, `CHANNEL_QUEUE_WEDGE_GRACE_SECONDS` already
 * defined it, and `recoverChannel(ref, "auto")` already fixed it. The detector
 * ran only when a human typed `/seam cancel`, and the repair only when an admin
 * typed back the command Seam had just printed. So these tests are about the
 * wiring, and the headline one is behavioural: build a real wedge, run one
 * sweep, assert the thread is live again and the audit says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  AUTO_RECOVERY_ACTOR,
  Orchestrator,
  shouldAutoRecoverQueue,
} from "../packages/core/src/platforms/discord/orchestrator.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const CHANNEL = "1543325326166196264"; // one of the three threads named in #423

let dir: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "seam-423-"));
  store = new SessionStore(path.join(dir, "sessions.db"));
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function makeHost(config: Record<string, unknown> = {}) {
  const record = {
    id: "discord:auto", platform: "discord", channelRef: CHANNEL, parentRef: "10",
    agentId: "codex", acpSessionId: "acp-1", repoPath: "/repo",
    configJson: "{}", namePrefix: null,
    createdUtc: "2026-09-19T00:00:00.000Z", updatedUtc: "2026-09-19T00:00:00.000Z",
  } as never;
  store.upsert(record);
  const router = {
    ensureSessionRecord: () => record,
    getRuntime: () => undefined,
    hasRuntime: () => false,
    // Idle runtime: this is the half of "wedged" that makes it decidable.
    isBusy: () => false,
    listProfiles: () => [],
    describeConfig: () => ({
      agent: { value: "codex" }, model: { value: "test" },
      effort: { value: null }, cwd: { value: "/repo" },
    }),
    abortTurn: vi.fn(async () => "idle" as const),
    invalidate: vi.fn(async () => undefined),
  };
  const host = new Orchestrator({
    modelCatalog: fixtureModelCatalog([]),
    logger: silent,
    config: {
      DATA_DIR: dir, REPOS_ROOT: "/repo", TURN_TIMEOUT_SECONDS: 60,
      CHANNEL_QUEUE_WEDGE_GRACE_SECONDS: 1,
      channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map(),
      ...config,
    } as never,
    adapter: {} as never, router: router as never, store, renderer: {} as never,
  });
  Object.assign(host as never, {
    tryConsumeConfigEditorRiderUpload: async () => false,
    wouldParkForOfflineBridge: () => false,
    tryParkForOfflineBridge: async () => false,
    clearTurnMarkersForChannel: async () => undefined,
    clearParkedForChannel: async () => null,
    tryFireParked: async () => undefined,
    handleIncomingMessageInner: vi.fn(async () => undefined),
  });
  return { host, router, record };
}

/** A durable admission old enough to be past the grace period. */
function admitStale(messageId: string, createdUtc = "2026-09-19T00:00:00.000Z"): boolean {
  return store.admitInbound({
    messageId, platform: "discord", channelRef: CHANNEL, parentRef: "10",
    sessionRecordId: "discord:auto", authorId: "user", text: `message ${messageId}`,
    createdUtc,
  } as never);
}

describe("#423 a wedged thread self-heals without an operator", () => {
  it("recovers a real wedge in one sweep, with no human action", async () => {
    // The acceptance case, built rather than asserted: a durable admission
    // sitting behind an idle runtime, older than the grace period.
    const { host } = makeHost();
    expect(admitStale("300")).toBe(true);
    expect(host.inspectChannelQueue(CHANNEL).state).toBe("wedged");
    expect(store.getInbound("300")?.state).toBe("pending");

    // Exactly what the timer does, once. Nobody typed anything.
    const recovered = await host.sweepWedgedQueues();

    expect(recovered).toEqual([CHANNEL]);
    // The thread is live again: the epoch moved, so new turns are admitted
    // into a generation the dead tail cannot fence.
    expect(host.inspectChannelQueue(CHANNEL).state).not.toBe("wedged");
  });

  it("writes an audit row naming the system actor and the prior state", async () => {
    // A bumped epoch with no explanation is how an operator loses trust in the
    // thing that is supposed to be helping them.
    const { host } = makeHost();
    admitStale("301");
    await host.sweepWedgedQueues();

    const audit = store.listConfigMutations().filter((m) => m.scope === `thread:${CHANNEL}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tier: "operator",
      actorId: AUTO_RECOVERY_ACTOR.id,
      actorName: AUTO_RECOVERY_ACTOR.name,
      summary: "Recovered channel queue (auto)",
    });
    // The "why": the state it was in before, so the row stands on its own.
    expect(JSON.parse(audit[0]!.beforeJson!).state).toBe("wedged");
    expect(JSON.parse(audit[0]!.afterJson!).priorState).toBe("wedged");
  });

  it("does nothing at all to a healthy thread", async () => {
    const { host } = makeHost();
    expect(host.inspectChannelQueue(CHANNEL).state).toBe("idle");
    expect(await host.sweepWedgedQueues()).toEqual([]);
    expect(store.listConfigMutations()).toHaveLength(0);
  });

  it("leaves a queue inside the grace period alone", async () => {
    // Recovering here would fight ordinary queueing rather than repair a wedge.
    const { host } = makeHost({ CHANNEL_QUEUE_WEDGE_GRACE_SECONDS: 3600 });
    admitStale("302", new Date().toISOString());
    expect(host.inspectChannelQueue(CHANNEL).state).toBe("queued");
    expect(await host.sweepWedgedQueues()).toEqual([]);
  });

  it("refuses to fence a busy runtime, which stays a human's call", async () => {
    const { host, router } = makeHost();
    admitStale("303");
    router.isBusy = () => true;
    expect(host.inspectChannelQueue(CHANNEL).state).toBe("runtime_busy");
    expect(await host.sweepWedgedQueues()).toEqual([]);
    expect(store.listConfigMutations()).toHaveLength(0);
  });

  it("leaves a wedge it cannot safely replay to a human, and does not claim success", async () => {
    // The boundary #423 asks to be stated explicitly. `recoverChannel` refuses
    // a legacy `running` admission that has no frozen execution identity,
    // because replaying it is not provably safe. The sweep must report that as
    // NOT recovered — counting a refusal as a fix would restore the original
    // failure with a reassuring log line on top, which is worse than silence.
    const { host } = makeHost();
    admitStale("306");
    // Exactly the shape recoverChannel refuses: state=running, no attempt row.
    (store as never as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } })
      .db.prepare("UPDATE inbound_admissions SET state='running' WHERE message_id=?")
      .run("306");
    expect(host.inspectChannelQueue(CHANNEL).state).toBe("wedged");

    expect(await host.sweepWedgedQueues()).toEqual([]);
    // Nothing was fenced and no epoch moved, so a human still has a thread to
    // look at rather than a silently-altered one.
    expect(store.listConfigMutations()).toHaveLength(0);
    expect(store.getInbound("306")?.state).toBe("running");
  });

  it("does not report recovery while a prompted attempt still blocks the target (#428)", async () => {
    // The sweep fenced the channel queue and logged success while the attempt
    // layer stayed dead: one suspended attempt that had already started its
    // prompt, and pending handoffs that nothing had claimed. Replaying the
    // suspended attempt would bill the interrupted turn again, and an empty
    // owner_boot on the pending rows is not a dead owner — admit writes it
    // that way. The repair may fence the queue. It may not call that recovered.
    const { host } = makeHost();
    expect(admitStale("428")).toBe(true);
    const suspended = {
      id: "suspended-prompted", target: CHANNEL, prompt: "already ran", session: "live",
    } as never;
    const pending = {
      id: "pending-never", target: CHANNEL, prompt: "never claimed", session: "live",
    } as never;
    const claimed = store.turnAttempts.claim(
      store.turnAttempts.admit(suspended),
      "identity",
      "boot-1",
    );
    store.turnAttempts.bind(claimed, "acp-suspended");
    store.turnAttempts.startPrompt(claimed);
    store.turnAttempts.suspend(claimed.id, "boot-1");
    store.turnAttempts.admit(pending);
    expect(host.inspectChannelQueue(CHANNEL).state).toBe("wedged");

    expect(await host.sweepWedgedQueues()).toEqual([]);

    expect(store.turnAttempts.get("suspended-prompted")).toMatchObject({
      state: "suspended",
      promptStarted: true,
    });
    expect(store.turnAttempts.get("pending-never")).toMatchObject({
      state: "pending",
      promptStarted: false,
      ownerBoot: "",
      generation: 0,
    });
    const audit = store.listConfigMutations().filter((m) => m.scope === `thread:${CHANNEL}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toBe(
      "Fenced channel queue (auto); prompted attempt still blocks it",
    );
    expect(audit[0]!.summary).not.toMatch(/Recovered channel queue/);
  });

  it("detects but does not repair when auto-recovery is switched off", async () => {
    // Degrading to visibility, not back to silence.
    const { host } = makeHost({ CHANNEL_QUEUE_AUTO_RECOVER: false });
    admitStale("304");
    expect(host.inspectChannelQueue(CHANNEL).state).toBe("wedged");
    expect(await host.sweepWedgedQueues()).toEqual([]);
    expect(store.listConfigMutations()).toHaveLength(0);
  });
});

describe("#423 the sweep finds threads a restart would have hidden", () => {
  it("considers channels known only from durable attempts, not just the hot set", () => {
    // The 7-and-13-hour threads. `channelQueueMeta` is in-memory and empty
    // after a restart; the attempts are in SQL and are the only trace left.
    const { host } = makeHost();
    const spec = { id: "574a377f", target: CHANNEL, prompt: "p", session: "live" } as never;
    store.turnAttempts.admit(spec);
    expect(store.turnAttempts.get("574a377f")?.state).toBe("pending");
    expect((host as never as { wedgeSweepCandidates(): string[] })
      .wedgeSweepCandidates()).toContain(CHANNEL);
  });

  it("considers suspended attempts too, which hold a queue just as effectively", () => {
    // #423 is explicit that a BENIGN suspension with no stalled_reason wedges a
    // thread exactly as well as a quarantine does.
    const { host } = makeHost();
    const spec = { id: "cf7e1e1e", target: "1543324940713988188", prompt: "p", session: "live" } as never;
    store.turnAttempts.admit(spec);
    const claimed = store.turnAttempts.claim(spec, "identity", "boot-1");
    store.turnAttempts.suspend(claimed.id, "boot-1");
    expect((host as never as { wedgeSweepCandidates(): string[] })
      .wedgeSweepCandidates()).toContain("1543324940713988188");
  });

  it("keeps sweeping after one channel throws", async () => {
    // The sweep exists because nobody is watching; a throw would restore the
    // exact silence it was built to end.
    const { host } = makeHost();
    admitStale("305");
    const real = host.inspectChannelQueue.bind(host);
    let first = true;
    (host as never as { inspectChannelQueue: unknown }).inspectChannelQueue =
      (ref: string, now?: number) => {
        if (first) { first = false; throw new Error("unreadable"); }
        return real(ref, now);
      };
    (host as never as { channelQueueMeta: Map<string, unknown> })
      .channelQueueMeta.set("poison", { epoch: 1, queued: 1, admittedAtMs: 0, lastProgressAtMs: 0 });
    await expect(host.sweepWedgedQueues()).resolves.toContain(CHANNEL);
  });
});

describe("#423 the auto-apply condition", () => {
  it.each([
    ["wedged", true],
    ["runtime_busy", false],
    ["queued", false],
    ["idle", false],
    ["stalled", false],
  ])("%s -> %s", (state, expected) => {
    expect(shouldAutoRecoverQueue({ state } as never, true)).toBe(expected);
  });

  it("is off for every state when auto-recovery is disabled", () => {
    for (const state of ["wedged", "runtime_busy", "queued", "idle", "stalled"]) {
      expect(shouldAutoRecoverQueue({ state } as never, false)).toBe(false);
    }
  });
});
