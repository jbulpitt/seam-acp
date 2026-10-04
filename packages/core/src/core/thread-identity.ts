import path from "node:path";
import type { Config } from "../config.js";
import type { ChatAdapter } from "../platforms/chat-adapter.js";
import type { Logger } from "../lib/logger.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRouter } from "./session-router.js";
import type { SessionRecord } from "./types.js";
import { ThreadNamerConfigStore, type ThreadNamerRecord } from "../platforms/discord/thread-namer.js";
import { createThreadNamingPlugin } from "../plugins/thread-naming/index.js";
import type { PluginHost } from "../plugins/host.js";
import type { NamingThread, ThreadIdentity } from "../plugins/identity-registry.js";

/** Controller-only projection of successful commits into ordered plugin facts. */
export function installThreadNaming(deps: {
  config: Config; store: SessionStore; router: SessionRouter; adapter: ChatAdapter; logger: Logger; plugins: PluginHost;
}): { ready: Promise<void>; flush(sessionId?: string): Promise<void>; presetsCommitted(channels: ReadonlySet<string>): void } {
  const { store, router, adapter, plugins, logger } = deps;
  const known = new Map<string, ThreadIdentity>();
  const dirty = new Map<string, string>();
  let closed = false;
  const pending = new Map<string, Promise<void>>();
  const project = (record: SessionRecord): NamingThread => {
    const config = router.describeConfig(record);
    return { id: record.channelRef, platform: record.platform, parentId: record.parentRef, createdUtc: record.createdUtc,
      identity: { agent: config.agent.value, model: config.model.value, role: config.role.value, disableThreadPrefix: config.disableThreadPrefix.value, prefix: record.namePrefix ?? null } };
  };
  const records = () => store.list(store.countSessions());
  const snapshot = (record: SessionRecord): ThreadNamerRecord => ({
    id: record.id, platform: record.platform, channelRef: record.channelRef, parentRef: record.parentRef, createdUtc: record.createdUtc, namePrefix: record.namePrefix ?? null,
  });
  let unsubscribe = () => {};
  const ready = plugins.loadBuiltins([{ id: "thread-naming", load: async () => {
    for (const record of records()) known.set(record.id, project(record).identity);
    const rules = new ThreadNamerConfigStore(path.join(deps.config.DATA_DIR, "thread-namer.json"), logger);
    const plugin = createThreadNamingPlugin({
      threads: {
        describeConfig: record => {
          const live = store.get(record.id);
          if (!live) throw new Error(`thread ${record.channelRef} no longer exists`);
          const resolved = router.describeConfig(live);
          return { agent: { value: resolved.agent.value }, model: { value: resolved.model.value }, role: { value: resolved.role.value }, disableThreadPrefix: { value: resolved.disableThreadPrefix.value } };
        },
        listSessionsByParent: (platform, parent) => store.listSessionsByParentInCreationOrder(platform, parent).map(snapshot),
        getThreadName: async id => (await adapter.getThreadName?.({ platform: "discord", id })) ?? null,
        getThreadLiveState: async id => {
          if (!adapter.getThreadLiveState) throw new Error("thread liveness check is unavailable");
          return adapter.getThreadLiveState({ platform: "discord", id });
        },
        renameThread: async (id, name) => {
          if (!adapter.renameThread) throw new Error("This platform cannot rename threads.");
          await adapter.renameThread({ platform: "discord", id }, name);
        },
        logger,
      },
      internal: { rules, setNamePrefix: (id, prefix) => store.setNamePrefix(id, prefix), get: threadId => { const record = store.getByChannel("discord", threadId); return record ? snapshot(record) : undefined; }, all: () => records().map(snapshot) },
    });
    plugin.activate = () => { unsubscribe = store.onSessionWrite(record => mark(record.id)); };
    plugin.dispose = () => { closed = true; unsubscribe(); };
    return plugin;
  } }]);
  const changed = async (id: string, reason: string) => {
      const record = store.get(id);
      if (!record) { known.delete(id); return; }
      try {
        const thread = project(record);
        const before = known.get(id);
        known.set(id, thread.identity);
        if (!before) await plugins.identity.emit({ type: "thread-created", thread, reason: "session created" });
        else if (JSON.stringify(before) !== JSON.stringify(thread.identity)) {
          await plugins.identity.emit({ type: "identity-changed", thread, before, reason });
        }
        const after = store.get(id);
        if (after) known.set(id, { ...thread.identity, prefix: after.namePrefix ?? null });
      } catch (err) { logger.error({ err, session: id }, "thread identity publication failed"); }
  };
  const mark = (id: string, reason?: string) => {
    if (closed) return;
    const record = store.get(id);
    if (!record || JSON.stringify(known.get(id)) !== JSON.stringify(project(record).identity)) {
      dirty.set(id, reason ?? dirty.get(id) ?? "configuration committed");
    }
  };
  return {
    ready,
    async flush(sessionId) {
      await ready;
      const started = new Map<string, Promise<void>>();
      for (const [id, reason] of dirty) {
        const run = (pending.get(id) ?? Promise.resolve()).then(() => changed(id, reason));
        pending.set(id, run);
        started.set(id, run);
        void run.then(() => { if (pending.get(id) === run) pending.delete(id); });
      }
      dirty.clear();
      if (sessionId) await pending.get(sessionId);
      else await Promise.all(started.values());
    },
    presetsCommitted(channels) {
      for (const record of records().sort((a, b) => a.createdUtc.localeCompare(b.createdUtc) || a.id.localeCompare(b.id))) {
        mark(record.id, record.parentRef && channels.has(record.parentRef) ? "channel preset committed" : "thread preset committed");
      }
    },
  };
}
