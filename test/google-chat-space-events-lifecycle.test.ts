import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { GoogleChatSpaceEvents } from "../packages/core/src/platforms/google-chat/space-events.js";
import { WorkspaceEventsOperationError, GOOGLE_CHAT_MESSAGE_CREATED,
  type GoogleChatSpaceSubscription } from "../packages/core/src/platforms/google-chat/space-subscriptions.js";

const topic = "projects/test/topics/events";
const space = { name: "spaces/team", spaceType: "SPACE", spaceThreadingState: "UNTHREADED_MESSAGES" };
const saved = (name = "subscriptions/one", seconds = 3600): GoogleChatSpaceSubscription => ({ name,
  targetResource: "//chat.googleapis.com/spaces/team", notificationEndpoint: { pubsubTopic: topic },
  eventTypes: [GOOGLE_CHAT_MESSAGE_CREATED], payloadOptions: { includeResource: true },
  expireTime: new Date(Date.now() + seconds * 1000).toISOString(), state: "ACTIVE" });
const stores: SessionStore[] = [], workers: GoogleChatSpaceEvents[] = [], dirs: string[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T20:00:00Z")); });
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  stores.splice(0).forEach(store => store.close());
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true }));
  vi.useRealTimers();
});

function fixture(dbPath = ":memory:", allowedSpaceIds = new Set(["spaces/team"])) {
  const store = new SessionStore(dbPath); stores.push(store);
  const remote: GoogleChatSpaceSubscription[] = [];
  const memberships = [space];
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => {
    if (r.url.endsWith("/spaces")) return { spaces: memberships };
    throw new Error(`Unexpected API request ${r.url}`);
  });
  const client = {
    list: vi.fn(async (target?: string) => remote.filter(sub => !target || sub.targetResource.endsWith(target))),
    create: vi.fn(async () => { const sub = saved(); remote.push(sub); return sub; }),
    delete: vi.fn(async (name: string) => { const index = remote.findIndex(sub => sub.name === name); if (index >= 0) remote.splice(index, 1); }),
    renew: vi.fn(async (name: string) => { const sub = saved(name); remote.splice(remote.findIndex(sub => sub.name === name), 1, sub); return sub; }),
  };
  const logs: any[] = [], logger = pino({ level: "debug" }, { write: line => logs.push(JSON.parse(line)) });
  const worker = new GoogleChatSpaceEvents({ api: { request }, pubsubTopic: topic,
    subscriptions: client, store: store.googleChatSpaces, allowedSpaceIds, logger, renewalLeadMs: 300_000 });
  workers.push(worker);
  return { worker, store, client, remote, request, logs, memberships };
}

describe("Google Chat Workspace subscription lifecycle", () => {
  it("discovers existing Space memberships on boot and saves server expiry and our reply's app identity", async () => {
    const h = fixture(); await h.worker.start();
    h.worker.recordAppUser("spaces/team", "users/seam");
    expect(h.request.mock.calls.some(([, request]) => request.url.includes("pubsub.googleapis.com"))).toBe(false);
    expect(h.client.list).toHaveBeenCalled(); expect(h.client.create).toHaveBeenCalledWith("spaces/team", expect.anything());
    expect(h.store.googleChatSpaces.get("spaces/team")).toEqual({ space, appUser: "users/seam", subscription: h.remote[0] });
    expect(h.worker.space("spaces/team")).toEqual(space); expect(h.worker.appUser("spaces/team")).toBe("users/seam");
    await vi.advanceTimersByTimeAsync(3_300_000);
    expect(h.client.renew).toHaveBeenCalledWith("subscriptions/one", "0s", expect.any(AbortSignal));
    expect(h.store.googleChatSpaces.get("spaces/team")!.subscription!.expireTime).toBe("2026-10-10T21:55:00.000Z");
  });

  it("reopens durable state, reconciles list(), and rearms Google's new expiry without another create", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gchat-subscriptions-")); dirs.push(dir);
    const h = fixture(join(dir, "seam.db")); await h.worker.start(); await h.worker.stop();
    h.store.close(); stores.splice(stores.indexOf(h.store), 1);
    const next = fixture(join(dir, "seam.db")); next.remote.push(saved("subscriptions/one", 1800));
    await next.worker.start();
    expect(next.client.create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500_000);
    expect(next.client.renew).toHaveBeenCalledOnce(); expect(h.client.renew).not.toHaveBeenCalled();
  });

  it("keeps app identity learned while a renewal request is in flight", async () => {
    const h = fixture(); await h.worker.start(); let finish!: () => void;
    h.client.renew.mockImplementationOnce(async name => {
      await new Promise<void>(resolve => { finish = resolve; }); return saved(name);
    });
    await vi.advanceTimersByTimeAsync(3_300_000);
    h.worker.recordAppUser(space.name, "users/seam"); finish(); await Promise.resolve(); await Promise.resolve();
    await h.worker.stop();
    expect(h.worker.appUser(space.name)).toBe("users/seam");
  });

  it("paginates the app's Space memberships before deciding what to reconcile", async () => {
    const h = fixture();
    h.request.mockImplementation(async (_scope, r): Promise<any> => r.params?.pageToken === "second" ? { spaces: [space] }
      : { spaces: [], nextPageToken: "second" });
    await h.worker.start(); expect(h.client.create).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenLastCalledWith("chat", expect.objectContaining({ params: { pageToken: "second" } }));
  });

  it("does not delete durable state when Google rejects the removal operation", async () => {
    const h = fixture(); await h.worker.start(); const cause = new Error("Google permission denied deleting subscription");
    h.client.delete.mockRejectedValueOnce(cause);
    await expect(h.worker.handle({ type: "REMOVED_FROM_SPACE", space })).rejects.toBe(cause);
    expect(h.store.googleChatSpaces.get(space.name)?.subscription?.name).toBe("subscriptions/one");
  });

  it("recovers a create that committed in Google before SQLite recorded it", async () => {
    const h = fixture(); h.remote.push(saved());
    await h.worker.handle({ type: "ADDED_TO_SPACE", space });
    expect(h.client.create).not.toHaveBeenCalled();
    expect(h.store.googleChatSpaces.get(space.name)!.subscription!.name).toBe("subscriptions/one");
  });

  it("recreates a subscription that expired while the controller was stopped", async () => {
    const h = fixture(); h.store.googleChatSpaces.put({ space, appUser: "users/seam", subscription: saved("subscriptions/expired", -10) });
    await h.worker.start(); expect(h.client.create).toHaveBeenCalledOnce();
    expect(h.store.googleChatSpaces.get(space.name)!.subscription!.name).toBe("subscriptions/one");
  });

  it("deletes on removal and clears the timer and durable membership, even if its allowlist changed", async () => {
    const h = fixture(); await h.worker.start();
    await h.worker.handle({ type: "REMOVED_FROM_SPACE", space });
    expect(h.client.delete).toHaveBeenCalledWith("subscriptions/one", expect.any(AbortSignal));
    expect(h.store.googleChatSpaces.get(space.name)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(4 * 3600_000); expect(h.client.renew).not.toHaveBeenCalled();
  });

  it("reconciles removed memberships but never touches another topic's subscription", async () => {
    const h = fixture(); h.remote.push(saved(), { ...saved("subscriptions/other"), notificationEndpoint: { pubsubTopic: "projects/test/topics/other" } });
    h.memberships.splice(0); h.store.googleChatSpaces.put({ space, subscription: h.remote[0] });
    await h.worker.start(); expect(h.client.delete.mock.calls.map(call => call[0])).toEqual(["subscriptions/one"]);
    expect(h.store.googleChatSpaces.list()).toEqual([]); expect(h.remote.map(sub => sub.name)).toEqual(["subscriptions/other"]);
  });

  it.each([new Set(["other"]), new Set(["team"]), new Set<string>()])("respects full/bare/unrestricted Space IDs", async ids => {
    const h = fixture(undefined, ids); await h.worker.start();
    expect(h.client.create.mock.calls.length).toBe(ids.has("other") ? 0 : 1);
  });

  it("does not create subscriptions for DMs", async () => {
    const h = fixture(); h.memberships.splice(0, 1, { ...space, spaceType: "DIRECT_MESSAGE" });
    await h.worker.start(); await h.worker.handle({ type: "ADDED_TO_SPACE", space: h.memberships[0]! });
    expect(h.client.create).not.toHaveBeenCalled();
  });

  it("serializes add/removal so the later removal cannot leave an orphan subscription", async () => {
    const h = fixture(); let release!: () => void;
    h.client.create.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; });
      const sub = saved(); h.remote.push(sub); return sub; });
    const add = h.worker.handle({ type: "ADDED_TO_SPACE", space });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const remove = h.worker.handle({ type: "REMOVED_FROM_SPACE", space });
    release(); await Promise.all([add, remove]);
    expect(h.remote).toEqual([]); expect(h.store.googleChatSpaces.list()).toEqual([]);
  });

  it("returns an operation failure unchanged rather than acknowledging a successful membership effect", async () => {
    const h = fixture(); const cause = new WorkspaceEventsOperationError({ code: 7, message: "Google: scope not approved", details: [{ reason: "DENIED" }] });
    h.client.create.mockRejectedValueOnce(cause);
    await expect(h.worker.handle({ type: "ADDED_TO_SPACE", space })).rejects.toBe(cause);
    expect(h.store.googleChatSpaces.get(space.name)?.subscription).toBeUndefined();
    expect(h.logs.some(row => row.msg.includes("renewal armed"))).toBe(false);
  });

  it("logs the real renewal cause and keeps its durable deadline for reconciliation on restart", async () => {
    const h = fixture(); await h.worker.start();
    const cause = new Error("Google renewal rejected: administrator revoked scope"); h.client.renew.mockRejectedValueOnce(cause);
    await vi.advanceTimersByTimeAsync(3_300_000);
    expect(h.logs.some(row => row.err?.message === cause.message)).toBe(true);
    expect(h.store.googleChatSpaces.get(space.name)?.subscription?.name).toBe("subscriptions/one");
  });

  it("retries failed renewals with capped backoff, logs every native cause, and resets after success", async () => {
    const h = fixture(); await h.worker.start();
    const cause = new WorkspaceEventsOperationError({ code: 14, message: "Google: subscription renewal temporarily unavailable" });
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (let i = 0; i <= delays.length; i++) h.client.renew.mockRejectedValueOnce(cause);
    await vi.advanceTimersByTimeAsync(3_300_000);
    expect(h.client.renew).toHaveBeenCalledTimes(1);
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.client.renew).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.client.renew).toHaveBeenCalledTimes(index + 2);
    }
    const failures = h.logs.filter(row => row.msg === "Google Chat Workspace subscription renewal failed");
    expect(failures).toHaveLength(8);
    expect(failures.every(row => row.err.message.includes(cause.message) && row.err.code === cause.code)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.client.renew).toHaveBeenCalledTimes(9);
    expect(Date.parse(h.store.googleChatSpaces.get(space.name)!.subscription!.expireTime)).toBe(Date.now() + 3600_000);
    h.client.renew.mockRejectedValueOnce(cause);
    await vi.advanceTimersByTimeAsync(3_300_000);
    expect(h.client.renew).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.client.renew).toHaveBeenCalledTimes(11);
  });

  it("recreates after expiry and keeps retrying if recreation also fails", async () => {
    const h = fixture(); h.remote.push(saved("subscriptions/old", 3)); await h.worker.start();
    h.worker.recordAppUser(space.name, "users/seam");
    const renewalCause = new Error("Google: renewal request unavailable");
    const createCause = new WorkspaceEventsOperationError({ code: 14, message: "Google: create request unavailable" });
    h.client.renew.mockRejectedValue(renewalCause); h.client.create.mockRejectedValueOnce(createCause);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.client.renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.client.renew).toHaveBeenCalledTimes(2);
    expect(h.client.create).toHaveBeenCalledTimes(1);
    expect(h.logs.some(row => row.err?.message.includes(createCause.message))).toBe(true);
    expect(h.store.googleChatSpaces.get(space.name)?.subscription).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3999);
    expect(h.client.create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.create).toHaveBeenCalledTimes(2);
    expect(h.store.googleChatSpaces.get(space.name)).toEqual({ space, appUser: "users/seam", subscription: h.remote[1] });
    expect(h.store.googleChatSpaces.get(space.name)!.subscription!.name).toBe("subscriptions/one");
  });

  it("rearms a failed renewal from the durable expiry after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gchat-renewal-retry-")); dirs.push(dir);
    const dbPath = join(dir, "seam.db"), h = fixture(dbPath);
    await h.worker.start(); h.client.renew.mockRejectedValueOnce(new Error("Google: temporary renewal failure"));
    const original = h.remote[0]!;
    await vi.advanceTimersByTimeAsync(3_300_000); await h.worker.stop();
    h.store.close(); stores.splice(stores.indexOf(h.store), 1);
    const next = fixture(dbPath); next.remote.push(original); await next.worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(next.client.create).not.toHaveBeenCalled(); expect(next.client.renew).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); expect(h.client.renew).toHaveBeenCalledOnce();
  });

  it.each(["removal", "stop"])("cancels a failed renewal's retry on %s without recreating the subscription", async action => {
    const h = fixture(); await h.worker.start();
    h.client.renew.mockRejectedValueOnce(new Error("Google: temporary renewal failure"));
    await vi.advanceTimersByTimeAsync(3_300_000);
    if (action === "removal") await h.worker.handle({ type: "REMOVED_FROM_SPACE", space });
    else await h.worker.stop();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(h.client.renew).toHaveBeenCalledOnce(); expect(h.client.create).toHaveBeenCalledOnce();
    if (action === "removal") expect(h.store.googleChatSpaces.get(space.name)).toBeUndefined();
  });
});
