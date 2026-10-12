import { afterEach } from "vitest";
import { SessionStore } from "../../packages/core/src/core/session-store.js";
import type { GoogleChatAdapter } from "../../packages/core/src/platforms/google-chat/adapter.js";
import type { SessionRecord } from "../../packages/core/src/core/types.js";

const owned: SessionStore[] = [];
afterEach(() => owned.splice(0).forEach(store => store.close()));

export function seedLegacyChatRecords(store: SessionStore, channels: string[]): SessionRecord[] {
  return channels.map(channelRef => {
    const prior = store.getByChannel("google-chat", channelRef); if (prior) return prior;
    const record: SessionRecord = { id: `google-chat:${channelRef}`, platform: "google-chat", channelRef,
      parentRef: channelRef.includes(".") ? channelRef.split(".")[0]! : null, agentId: "codex", acpSessionId: "fixture-existing-acp",
      repoPath: "/projects", configJson: "{}", createdUtc: "2026-10-10T00:00:00Z", updatedUtc: "2026-10-10T00:00:00Z" };
    store.upsert(record); return record;
  });
}

/** Old thread-session coverage is explicit; unbound messages belong to Space-launch tests. */
export function installLegacyChatFixture(adapter: GoogleChatAdapter, channels: string[]): SessionStore {
  const store = new SessionStore(":memory:"); owned.push(store);
  seedLegacyChatRecords(store, channels);
  adapter.setCommandDeps({ store, router: { ensureSessionRecord: (input: { channelRef: string }) => store.getByChannel("google-chat", input.channelRef),
    bindRecordLocation: () => "local" }, mutation: { readThreadPresetEntry: () => undefined,
    applyThreadOverlay: () => ({ ok: true }), restoreThreadPresetEntry: () => ({ ok: true }) }, runtimeTransition: {}, cancelChannel: async () => {} } as any);
  return store;
}
