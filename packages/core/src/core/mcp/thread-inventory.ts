import type { ConfigDescription } from "../session-router.js";
import type { SessionRecord } from "../types.js";
import type { ChatAdapter } from "../../platforms/chat-adapter.js";
import type { ThreadEntry } from "./seam-mcp-server.js";
import type { ThreadWorkProgress } from "../dispatch/types.js";
import { setImmediate } from "node:timers/promises";

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
  inspectChannels: (channelRefs: readonly string[]) => Promise<ReadonlyMap<string, {
    queue: QueueHealth; workProgress: ThreadWorkProgress;
  }>>;
  locationFor: (channelRef: string) => { location: string; hostEmoji: string };
}

/** Compose platform presence with one batched queue/progress read per inventory. */
export async function listSiblingThreadEntries(
  caller: SessionRecord,
  deps: ThreadInventoryDeps
): Promise<ThreadEntry[]> {
  if (!caller.parentRef) return [];
  const siblings = deps.listSessionsByParent(caller.platform, caller.parentRef);
  const presentation = await Promise.all(
    siblings.map(async (session) => {
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
      return { name, status };
    })
  );
  const inspections = await deps.inspectChannels(siblings.map(session => session.channelRef));
  const entries: ThreadEntry[] = [];
  for (let i = 0; i < siblings.length; i++) {
    if (i > 0 && i % 8 === 0) await setImmediate();
    const session = siblings[i]!;
    const { name, status } = presentation[i]!;
    const cfg = deps.describeConfig(session);
    const { queue, workProgress } = inspections.get(session.channelRef)!;
    const runtimeBusy = deps.isRuntimeBusy(session.id);
    const location = deps.locationFor(session.channelRef);
    entries.push({
      id: session.channelRef,
      name,
      isSelf: session.id === caller.id,
      agent: cfg.agent.value,
      model: cfg.model.value,
      effort: cfg.effort.value,
      fastMode: cfg.fastMode?.value === true,
      cwd: cfg.cwd.value,
      // A bridge-owned retry is distinct from a locally running turn.
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
    });
  }
  return entries;
}
