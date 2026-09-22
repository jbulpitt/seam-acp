import type { ConfigDescription } from "../session-router.js";
import type { SessionRecord } from "../types.js";
import type { ChatAdapter } from "../../platforms/chat-adapter.js";
import type { ThreadEntry } from "./seam-mcp-server.js";
import type { ThreadWorkProgress } from "../dispatch/types.js";

type QueueHealth = {
  state: NonNullable<ThreadEntry["queueState"]>;
  epoch: number;
  queued: number;
  ageMs: number;
  runtimeBusy: boolean;
  stalledDispatchCount: number;
  stalledDispatchIds: string[];
  unsettledDispatchCount: number;
  unsettledDispatchIds: string[];
};

export interface ThreadInventoryDeps {
  listSessionsByParent: (platform: string, parentRef: string) => SessionRecord[];
  describeConfig: (record: SessionRecord) => ConfigDescription;
  isRuntimeBusy: (sessionId: string) => boolean;
  adapter: Pick<ChatAdapter, "getThreadName" | "getThreadLiveState">;
  inspectQueue: (channelRef: string) => QueueHealth;
  inspectWorkProgress: (
    channelRef: string,
    nowMs: number,
    queue: QueueHealth
  ) => ThreadWorkProgress;
  locationFor: (channelRef: string) => { location: string; hostEmoji: string };
  now?: () => number;
}

/**
 * Production composer for the agent-facing `threads()` inventory (#530).
 *
 * Keeping this as one callable path is what makes the progress contract
 * testable at its real consumer. Removing `inspectWorkProgress` from here
 * restores the incident: the underlying classifier can remain correct while
 * every orchestrator still sees only routing `busy`.
 */
export async function listSiblingThreadEntries(
  caller: SessionRecord,
  deps: ThreadInventoryDeps
): Promise<ThreadEntry[]> {
  if (!caller.parentRef) return [];
  const siblings = deps.listSessionsByParent(caller.platform, caller.parentRef);
  return Promise.all(
    siblings.map(async (session) => {
      const cfg = deps.describeConfig(session);
      let name: string | null = null;
      let status: ThreadEntry["status"] = "active";
      try {
        name =
          (await deps.adapter.getThreadName?.({
            platform: session.platform,
            id: session.channelRef,
          })) ?? null;
      } catch {
        name = null;
      }
      try {
        const live = deps.adapter.getThreadLiveState
          ? await deps.adapter.getThreadLiveState({
              platform: session.platform,
              id: session.channelRef,
            })
          : { locked: false, archived: false };
        if (live === undefined) status = "gone";
        else if (live.archived) status = "archived";
      } catch {
        // A transient platform read cannot turn an addressable thread into a
        // confirmed deletion. The existing active fallback remains unchanged.
        status = "active";
      }
      const queue = deps.inspectQueue(session.channelRef);
      const workProgress = deps.inspectWorkProgress(
        session.channelRef,
        (deps.now ?? Date.now)(),
        queue
      );
      const runtimeBusy = deps.isRuntimeBusy(session.id);
      const location = deps.locationFor(session.channelRef);
      return {
        id: session.channelRef,
        name,
        isSelf: session.id === caller.id,
        agent: cfg.agent.value,
        model: cfg.model.value,
        effort: cfg.effort.value,
        fastMode: cfg.fastMode?.value === true,
        cwd: cfg.cwd.value,
        busy: runtimeBusy || (queue.state !== "idle" && queue.state !== "stalled"),
        queueState: queue.state,
        queueAgeMs: queue.ageMs,
        queueEpoch: queue.epoch,
        stalledDispatchCount: queue.stalledDispatchCount,
        stalledDispatchIds: queue.stalledDispatchIds,
        unsettledDispatchCount: queue.unsettledDispatchCount,
        unsettledDispatchIds: queue.unsettledDispatchIds,
        workProgress,
        status,
        lastActivityUtc: session.updatedUtc,
        location: location.location,
        hostEmoji: location.hostEmoji,
      };
    })
  );
}
