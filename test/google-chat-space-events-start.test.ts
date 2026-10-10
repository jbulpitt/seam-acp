import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { GoogleChatSpaceEvents } from "../packages/core/src/platforms/google-chat/space-events.js";
import { GOOGLE_CHAT_MESSAGE_CREATED, WorkspaceEventsOperationError,
  type GoogleChatSpaceSubscription } from "../packages/core/src/platforms/google-chat/space-subscriptions.js";

const topic = "projects/test/topics/events";
const space = { name: "spaces/team", spaceType: "SPACE", spaceThreadingState: "UNTHREADED_MESSAGES" };
const adapters: GoogleChatAdapter[] = [], stores: SessionStore[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T20:00:00Z")); });
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  stores.splice(0).forEach(store => store.close());
  vi.useRealTimers();
});

function untilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

function setup() {
  const logs: any[] = [], logger = pino({ level: "debug" }, { write: line => logs.push(JSON.parse(line)) });
  const store = new SessionStore(":memory:"); stores.push(store);
  const request = vi.fn(async (scope: string, r: any): Promise<any> => {
    if (scope === "pubsub" && r.url.endsWith(":pull")) return untilAbort(r.signal);
    if (scope === "chat" && r.url.endsWith("/spaces")) return { spaces: [space] };
    return {};
  });
  const subscription = (): GoogleChatSpaceSubscription => ({ name: "subscriptions/one",
    targetResource: "//chat.googleapis.com/spaces/team", notificationEndpoint: { pubsubTopic: topic },
    eventTypes: [GOOGLE_CHAT_MESSAGE_CREATED], payloadOptions: { includeResource: true },
    expireTime: new Date(Date.now() + 3_600_000).toISOString(), state: "ACTIVE" });
  const client = { list: vi.fn(async (_space?: string, _signal?: AbortSignal): Promise<GoogleChatSpaceSubscription[]> => []),
    create: vi.fn(async () => subscription()), delete: vi.fn(async () => {}), renew: vi.fn(async () => subscription()) };
  const worker = new GoogleChatSpaceEvents({ api: { request }, pubsubTopic: topic,
    subscriptions: client, store: store.googleChatSpaces, logger });
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), defaultCwd: "/projects", logger,
    spaceEvents: worker, hasSession: () => true, writeIntervalMs: 0 });
  adapters.push(adapter);
  return { adapter, worker, client, request, store, logs, logger };
}

describe("Google Chat startup isolates Workspace reconciliation", () => {
  it.each(["rejects", "pending"])("starts pulling and resolves even if spaceEvents.start %s", async mode => {
    const h = setup(), cause = new Error("Google: startup unavailable");
    const start = vi.spyOn(h.worker, "start").mockImplementation(() => mode === "rejects"
      ? Promise.reject(cause) : new Promise<void>(() => {}));
    let outcome: unknown;
    void h.adapter.start().then(() => { outcome = "started"; }, err => { outcome = err; });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("started");
    const pull = h.request.mock.calls.findIndex(([, r]) => r.url.endsWith(":pull"));
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(h.request.mock.invocationCallOrder[pull]).toBeLessThan(start.mock.invocationCallOrder[0]!);
    if (mode === "rejects") expect(h.logs.some(row => row.err?.message === cause.message)).toBe(true);
  });

  it.each(["rejects", "pending"])("starts pulling while the real subscription list %s", async mode => {
    const h = setup(), cause = new WorkspaceEventsOperationError({ code: 14, message: "Google: list unavailable" });
    h.client.list.mockImplementation((_space, signal) => mode === "rejects"
      ? Promise.reject(cause) : untilAbort(signal!));
    let outcome: unknown;
    void h.adapter.start().then(() => { outcome = "started"; }, err => { outcome = err; });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("started");
    expect(h.request.mock.calls.some(([scope, r]) => scope === "pubsub" && r.url.endsWith(":pull"))).toBe(true);
    expect(h.client.list).toHaveBeenCalledOnce();
  });

  it("admits and ACKs a Workspace delivery using durable state before list finishes", async () => {
    const h = setup();
    h.store.googleChatSpaces.put({ space, appUser: "users/seam" });
    h.client.list.mockImplementation((_space, signal) => untilAbort(signal!));
    const message = { name: "spaces/team/messages/one", text: "unmentioned reply",
      sender: { name: "users/42", type: "HUMAN" }, thread: { name: "spaces/team/threads/native" } };
    let delivered = false;
    h.request.mockImplementation(async (scope, r): Promise<any> => {
      if (scope === "pubsub" && r.url.endsWith(":pull")) {
        if (delivered) return untilAbort(r.signal);
        delivered = true;
        return { receivedMessages: [{ ackId: "ack-one", message: { messageId: "delivery-one",
          attributes: { "ce-type": GOOGLE_CHAT_MESSAGE_CREATED, "ce-id": "event-one" },
          data: Buffer.from(JSON.stringify({ message })).toString("base64") } }] };
      }
      return {};
    });
    const incoming: any[] = [];
    h.adapter.onMessage(msg => {
      incoming.push(msg);
      h.store.admitInbound({ ...msg, messageId: msg.messageId!, platform: "google-chat", channelRef: msg.channel.id,
        sessionRecordId: `google-chat:${msg.channel.id}`, createdUtc: new Date().toISOString() });
      msg.onAdmitted?.();
    });
    let started = false;
    void h.adapter.start().then(() => { started = true; }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(true); expect(incoming).toHaveLength(1);
    expect(h.store.getInbound(incoming[0].messageId)).toMatchObject({ text: "unmentioned reply", channelRef: "team" });
    expect(h.request).toHaveBeenCalledWith("pubsub", expect.objectContaining({ data: { ackIds: ["ack-one"] } }));
  });

  it.each(["list", "spaces", "create"])("retries reconciliation after %s fails, then succeeds with the original cause logged", async stage => {
    const h = setup(), cause = new WorkspaceEventsOperationError({ code: 14, message: `Google: ${stage} unavailable` });
    if (stage === "list") h.client.list.mockRejectedValueOnce(cause);
    if (stage === "create") h.client.create.mockRejectedValueOnce(cause);
    if (stage === "spaces") h.request.mockImplementation(async (scope, r): Promise<any> => {
      if (scope === "pubsub") return untilAbort(r.signal);
      h.request.mockImplementation(async (nextScope, next): Promise<any> => nextScope === "pubsub"
        ? untilAbort(next.signal) : { spaces: [space] });
      throw cause;
    });
    let outcome: unknown;
    void h.worker.start().then(() => { outcome = "reconciled"; }, err => { outcome = err; });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.logs.some(row => row.err?.message.includes(cause.message) && row.err?.code === 14)).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.store.googleChatSpaces.get(space.name)?.subscription).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("reconciled");
    expect(h.store.googleChatSpaces.get(space.name)?.subscription?.name).toBe("subscriptions/one");
  });

  it("caps reconciliation retry delays at 30 seconds and stops after success", async () => {
    const h = setup(), cause = new Error("Google: list temporarily unavailable");
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (let i = 0; i < delays.length; i++) h.client.list.mockRejectedValueOnce(cause);
    void h.worker.start().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.list).toHaveBeenCalledTimes(1);
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.client.list).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.client.list).toHaveBeenCalledTimes(index + 2 + (index === delays.length - 1 ? 1 : 0));
    }
    expect(h.logs.filter(row => row.err?.message === cause.message)).toHaveLength(delays.length);
    expect(h.client.create).toHaveBeenCalledOnce();
    const calls = h.client.list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.client.list).toHaveBeenCalledTimes(calls);
  });

  it("stop cancels the reconciliation backoff without another request", async () => {
    const h = setup(); h.client.list.mockRejectedValue(new Error("Google: list unavailable"));
    void h.worker.start().catch(() => {});
    await vi.advanceTimersByTimeAsync(0); await h.worker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.client.list).toHaveBeenCalledOnce(); expect(h.client.create).not.toHaveBeenCalled();
  });

  it("stop aborts an in-flight list and ignores its late result", async () => {
    const h = setup(); let finish!: (subs: GoogleChatSpaceSubscription[]) => void, signal!: AbortSignal;
    h.client.list.mockImplementationOnce((_space, incoming) => {
      signal = incoming!; return new Promise(resolve => { finish = resolve; });
    });
    void h.worker.start().catch(() => {});
    await vi.advanceTimersByTimeAsync(0); await h.worker.stop();
    expect(signal.aborted).toBe(true); finish([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).not.toHaveBeenCalled(); expect(h.store.googleChatSpaces.list()).toEqual([]);
  });
});
