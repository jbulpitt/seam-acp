import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
const stores: SessionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
describe("move notice stays in the historical channel", () => {
  it("posts to the source thread, not the rebound session, through the space write queue", async () => {
    const store = new SessionStore(":memory:"); stores.push(store);
    const now = new Date().toISOString();
    store.upsert({ id: "google-chat:old.topic", platform: "google-chat", channelRef: "new", parentRef: null,
      agentId: "codex", acpSessionId: "keep-acp", repoPath: "/", configJson: "{}", createdUtc: now, updatedUtc: now });
    const request = vi.fn(async (_scope: string, r: any) => ({ name: "spaces/old/messages/notice", thread: r.data.thread }));
    const adapter = new GoogleChatAdapter({ api: { request } as any, subscription: "test", defaultCwd: "/",
      logger: pino({ level: "silent" }), allowedUserIds: new Set(), writeIntervalMs: 0 });
    adapter.setCommandDeps({ store, deliveryForChannel: () => ({ channel: { platform: "google-chat", id: "new" } }) } as any);
    await (adapter as any).sendChannelNotice({ platform: "google-chat", id: "old.topic", parentId: "old" }, "Moved to new");
    expect(request.mock.calls[0]![1]).toMatchObject({ method: "POST", url: "https://chat.googleapis.com/v1/spaces/old/messages",
      data: { text: "Moved to new", thread: { name: "spaces/old/threads/topic" } },
      params: { messageReplyOption: "REPLY_MESSAGE_OR_FAIL" } });
    expect(store.get("google-chat:old.topic")?.channelRef).toBe("new");
  });
});
