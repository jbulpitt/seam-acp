import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { GoogleChatSpaceEvents } from "../packages/core/src/platforms/google-chat/space-events.js";

const stores: SessionStore[] = [], workers: GoogleChatSpaceEvents[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.stop()));
  stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });
const mention = { type: "USER_MENTION", startIndex: 0, length: 5,
  userMention: { type: "MENTION", user: { name: "users/seam", type: "BOT" } } };

function fixture() {
  const store = new SessionStore(":memory:"); stores.push(store);
  const logger = pino({ level: "silent" });
  let creates = 0, sends = 0;
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => {
    if (r.method === "POST" && r.url.endsWith("/spaces")) return {
      name: `spaces/created-${++creates}`, displayName: r.data.displayName, spaceType: "SPACE",
      spaceThreadingState: "THREADED_MESSAGES", spaceUri: `https://chat.google.com/room/created-${creates}` };
    if (r.method === "POST" && r.url.endsWith("/members")) return { name: `${r.url.replace("https://chat.googleapis.com/v1/", "")}/42` };
    if (r.method === "POST" && r.url.endsWith("/messages")) {
      const name = r.url.replace("https://chat.googleapis.com/v1/", "").replace(/\/messages$/, "");
      return { name: `${name}/messages/sent-${++sends}`, thread: r.data.thread ?? { name: `${name}/threads/sent-${sends}` } };
    }
    return {};
  });
  const topic = "projects/test/topics/events";
  const subscriptions = { list: vi.fn(async () => []), create: vi.fn(async (name: string) => ({
    name: `subscriptions/${name.split("/")[1]}`, targetResource: `//chat.googleapis.com/${name}`,
    notificationEndpoint: { pubsubTopic: topic }, expireTime: new Date(Date.now() + 3_600_000).toISOString(), state: "ACTIVE" })),
    renew: vi.fn(), delete: vi.fn(async () => {}) };
  const events = new GoogleChatSpaceEvents({ api: { request }, subscriptions: subscriptions as any,
    pubsubTopic: topic, store: store.googleChatSpaces, logger }); workers.push(events);
  const adapter = new GoogleChatAdapter({ api: { request }, logger, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), defaultCwd: "/projects", writeIntervalMs: 0, spaceEvents: events });
  const ensureSessionRecord = vi.fn((input: any) => {
    const prior = store.getByChannel("google-chat", input.channelRef); if (prior) return prior;
    const now = new Date().toISOString();
    const record = { id: `google-chat:${input.channelRef}`, platform: "google-chat", channelRef: input.channelRef,
      parentRef: input.parentRef ?? null, agentId: "codex", acpSessionId: "", repoPath: input.cwd,
      configJson: "{}", createdUtc: now, updatedUtc: now }; store.upsert(record); return record;
  });
  adapter.setCommandDeps({ store, router: { ensureSessionRecord, bindRecordLocation: () => "local" },
    mutation: { readThreadPresetEntry: vi.fn(), applyThreadOverlay: () => ({ ok: true }), restoreThreadPresetEntry: () => ({ ok: true }) },
    runtimeTransition: {}, cancelChannel: vi.fn() } as any);
  const prepare = vi.fn(async (snapshot: any) => snapshot);
  const bind = vi.fn(async (channel: any, snapshot: any) => ensureSessionRecord({
    platform: channel.platform, channelRef: channel.id, cwd: snapshot.repo }));
  (adapter as any).installSessionSpaces({ config: { DEFAULT_AGENT: "codex", REPOS_ROOT: "/projects",
    GOOGLE_CHAT_DEFAULT_AGENT: "codex@remote", GOOGLE_CHAT_DEFAULT_LOCATION: "local",
    GOOGLE_CHAT_DEFAULT_MODEL: "org-model", GOOGLE_CHAT_DEFAULT_EFFORT: "medium", GOOGLE_CHAT_DEFAULT_CWD: "/org/repo" },
    prepare, bind });
  const incoming: any[] = [], admitted: string[] = [];
  adapter.onMessage(msg => {
    incoming.push(msg);
    if (store.admitInbound({ ...msg, messageId: msg.messageId!, platform: "google-chat", channelRef: msg.channel.id,
      parentRef: msg.channel.parentId, sessionRecordId: store.getByChannel("google-chat", msg.channel.id)!.id,
      createdUtc: new Date().toISOString() })) admitted.push(msg.messageId!);
    msg.onAdmitted?.();
  });
  const raw = (text: string, shared = false) => ({ type: "MESSAGE", space: { name: "spaces/launcher",
    spaceType: shared ? "SPACE" : "DIRECT_MESSAGE", spaceThreadingState: "THREADED_MESSAGES" },
    user: { name: "users/42", displayName: "Tester" }, message: { name: "spaces/launcher/messages/invocation",
      text, thread: { name: "spaces/launcher/threads/invocation" }, threadReply: false,
      ...(shared ? { annotations: [mention] } : {}) } });
  return { store, adapter, request, incoming, admitted, prepare, bind, raw, ensureSessionRecord, subscriptions };
}

describe("Chat launches new session Spaces instead of thread sessions", () => {
  it.each(["DIRECT_MESSAGE", "SPACE"])("native /new in %s creates a Space without admitting a prompt", async type => {
    const h = fixture(), raw = h.raw("/new Multi word name agent=codex@local model=chosen effort=high repo=/chosen", type === "SPACE");
    Object.assign(raw.message, { argumentText: raw.message.text, slashCommand: { commandId: 1 }, annotations: [] });
    await h.adapter.receiveEvent(raw);
    expect(h.request.mock.calls.filter(([, r]) => r.method === "POST" && r.url.endsWith("/spaces"))).toHaveLength(1);
    expect(h.prepare).toHaveBeenCalledWith({ agentId: "codex", location: "local", model: "chosen", effort: "high", repo: "/chosen" });
    expect(h.incoming).toHaveLength(0);
    expect(h.store.getByChannel("google-chat", "launcher.invocation")).toBeNull();
    expect(h.store.getByChannel("google-chat", "created-1")?.parentRef).toBeNull();
    expect(h.subscriptions.create).toHaveBeenCalledWith("spaces/created-1", expect.any(Object));
  });

  it("automatically launches from plain DM text without parsing prompt key=value as /new options", async () => {
    const h = fixture(); await h.adapter.receiveEvent(h.raw("Explain x=y in this report"));
    expect(h.request).toHaveBeenCalledWith("spaces", expect.objectContaining({ data: expect.objectContaining({ displayName: "Explain x=y in this report" }) }));
    expect(h.incoming).toHaveLength(1);
    expect(h.incoming[0]).toMatchObject({ channel: { platform: "google-chat", id: "created-1" },
      deliveryChannel: { platform: "google-chat", id: "created-1" }, text: "Explain x=y in this report", preemptive: false });
    expect(h.prepare).toHaveBeenCalledWith({ agentId: "codex", location: "remote", model: "org-model", effort: "medium", repo: "/org/repo" });
    expect(h.store.getByChannel("google-chat", "launcher.invocation")).toBeNull();
  });

  it("shares one creation/first-prompt admission across concurrent direct and Workspace mention deliveries", async () => {
    const h = fixture(), raw = h.raw("@Seam New report", true);
    await Promise.all([h.adapter.receiveEvent(raw), h.adapter.receiveEvent(raw, undefined, undefined, "workspace")]);
    expect(h.request.mock.calls.filter(([, r]) => r.method === "POST" && r.url.endsWith("/spaces"))).toHaveLength(1);
    expect(h.admitted).toHaveLength(1);
    expect(h.incoming.every(msg => msg.channel.id === "created-1" && msg.text === "New report")).toBe(true);
  });

  it("does not launch or admit an unmentioned message in a manually added Space", async () => {
    const h = fixture(), raw = h.raw("Not addressed to Seam", true); raw.message.annotations = [];
    await h.adapter.receiveEvent(raw, undefined, undefined, "workspace");
    expect(h.request).not.toHaveBeenCalled(); expect(h.incoming).toHaveLength(0);
  });
});
