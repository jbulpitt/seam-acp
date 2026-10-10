import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ configurations: [] as unknown[], request: vi.fn() }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {
  constructor(options: unknown) { auth.configurations.push(options); }
  request = auth.request;
} }));

import { GOOGLE_CHAT_APP_MESSAGES_SCOPE, GOOGLE_CHAT_BOT_SCOPE, GOOGLE_CHAT_MESSAGE_CREATED,
  GoogleChatSpaceSubscriptions, GoogleWorkspaceEventsApi, nextGoogleChatSubscriptionRenewalTime,
  WorkspaceEventsOperationError, type GoogleChatSpaceSubscription, type WorkspaceEventsRequest,
  type WorkspaceEventsRequestor, type WorkspaceEventsScope } from "../packages/core/src/platforms/google-chat/space-subscriptions.js";

const root = "https://workspaceevents.googleapis.com/v1";
const topic = "projects/example/topics/chat-events";
const subscription: GoogleChatSpaceSubscription = {
  name: "subscriptions/space-one", targetResource: "//chat.googleapis.com/spaces/SPACE",
  notificationEndpoint: { pubsubTopic: topic }, eventTypes: [GOOGLE_CHAT_MESSAGE_CREATED],
  payloadOptions: { includeResource: true }, expireTime: "2026-10-10T20:00:00Z", state: "ACTIVE",
};
function setup(...responses: unknown[]) {
  const request = vi.fn(async (_scope: WorkspaceEventsScope, _options: WorkspaceEventsRequest): Promise<unknown> => responses.shift());
  const api: WorkspaceEventsRequestor = { request: request as WorkspaceEventsRequestor["request"] };
  const manager = new GoogleChatSpaceSubscriptions({ pubsubTopic: topic, operationPollIntervalMs: 0 }, api);
  return { manager, request };
}

beforeEach(() => { auth.configurations.length = 0; auth.request.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("Google Chat space subscription API", () => {
  it("creates message subscriptions with app auth, full resource data and Google's maximum TTL", async () => {
    const { manager, request } = setup({ name: "operations/create", done: true, response: subscription });
    expect(await manager.create("spaces/SPACE")).toBe(subscription);
    expect(request).toHaveBeenCalledExactlyOnceWith("messages", {
      method: "POST", url: `${root}/subscriptions`, signal: undefined,
      data: { targetResource: "//chat.googleapis.com/spaces/SPACE", eventTypes: [GOOGLE_CHAT_MESSAGE_CREATED],
        notificationEndpoint: { pubsubTopic: topic }, payloadOptions: { includeResource: true }, ttl: "0s" },
    });
  });

  it("passes an explicit TTL and native message-prefixed field mask unchanged", async () => {
    const { manager, request } = setup({ name: "operations/create", done: true, response: subscription });
    const signal = new AbortController().signal;
    await manager.create("spaces/SPACE", { fieldMask: "message.name,message.sender,message.thread,message.text", ttl: "7200s", signal });
    expect(request.mock.calls[0]![1]).toMatchObject({ signal, data: { ttl: "7200s",
      payloadOptions: { includeResource: true, fieldMask: "message.name,message.sender,message.thread,message.text" } } });
  });

  it("allows names-only payloads without changing Google's seven-day TTL policy", async () => {
    const { manager, request } = setup({ name: "operations/create", done: true, response: subscription });
    await manager.create("spaces/SPACE", { includeResource: false });
    expect(request.mock.calls[0]![1].data).toMatchObject({ payloadOptions: { includeResource: false }, ttl: "0s" });
  });

  it("waits for the create operation and polls with the bot scope", async () => {
    const { manager, request } = setup({ name: "operations/space/create" },
      { name: "operations/space/create", done: false }, { name: "operations/space/create", done: true, response: subscription });
    expect(await manager.create("spaces/SPACE")).toBe(subscription);
    expect(request.mock.calls.slice(1)).toEqual([
      ["bot", { method: "GET", url: `${root}/operations/space/create`, signal: undefined }],
      ["bot", { method: "GET", url: `${root}/operations/space/create`, signal: undefined }],
    ]);
  });

  it("renews via PATCH ttl, returning the new expiry rather than assuming the requested lifetime", async () => {
    const renewed = { ...subscription, expireTime: "2026-10-11T00:00:00Z" };
    const { manager, request } = setup({ name: "operations/renew", done: true, response: renewed });
    expect(await manager.renew(subscription.name)).toBe(renewed);
    expect(request).toHaveBeenCalledExactlyOnceWith("messages", { method: "PATCH", url: `${root}/${subscription.name}`,
      params: { updateMask: "ttl" }, data: { ttl: "0s" }, signal: undefined });
  });

  it("passes custom renewal TTLs and AbortSignals through", async () => {
    const { manager, request } = setup({ name: "operations/renew", done: true, response: subscription });
    const signal = new AbortController().signal;
    await manager.renew(subscription.name, "3600s", signal);
    expect(request.mock.calls[0]![1]).toMatchObject({ data: { ttl: "3600s" }, signal });
  });

  it("awaits deletion with bot auth and accepts the API's empty operation response", async () => {
    const { manager, request } = setup({ name: "operations/delete", done: false }, { name: "operations/delete", done: true });
    await expect(manager.delete(subscription.name)).resolves.toBeUndefined();
    expect(request.mock.calls).toEqual([
      ["bot", { method: "DELETE", url: `${root}/${subscription.name}`, signal: undefined }],
      ["bot", { method: "GET", url: `${root}/operations/delete`, signal: undefined }],
    ]);
  });

  it("lists all pages using the required event filter and an optional space filter", async () => {
    const other = { ...subscription, name: "subscriptions/space-two" };
    const { manager, request } = setup({ subscriptions: [subscription], nextPageToken: "opaque+/token=" }, { subscriptions: [other] });
    const signal = new AbortController().signal;
    expect(await manager.list("spaces/SPACE", signal)).toEqual([subscription, other]);
    const params = { filter: `event_types:"${GOOGLE_CHAT_MESSAGE_CREATED}" AND target_resource="//chat.googleapis.com/spaces/SPACE"`, pageSize: 100 };
    expect(request.mock.calls).toEqual([
      ["bot", { method: "GET", url: `${root}/subscriptions`, params, signal }],
      ["bot", { method: "GET", url: `${root}/subscriptions`, params: { ...params, pageToken: "opaque+/token=" }, signal }],
    ]);
  });

  it("lists the app's subscriptions across spaces and handles an empty result", async () => {
    const { manager, request } = setup({});
    expect(await manager.list()).toEqual([]);
    expect(request.mock.calls[0]![1].params).toEqual({ filter: `event_types:"${GOOGLE_CHAT_MESSAGE_CREATED}"`, pageSize: 100 });
  });

  it.each(["create", "renew", "delete", "list"] as const)("preserves the exact HTTP/auth/transport cause from %s", async method => {
    const error = Object.assign(new Error("Permission denied: app scope has not been approved by your administrator"), {
      code: 403, response: { data: { error: { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } } },
      cause: new Error("socket closed"),
    });
    const { manager, request } = setup();
    request.mockRejectedValueOnce(error);
    const promise = method === "create" ? manager.create("spaces/SPACE") : method === "list" ? manager.list()
      : method === "renew" ? manager.renew(subscription.name) : manager.delete(subscription.name);
    await expect(promise).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps Google's operation failure message, numeric code, details and whole Status cause", async () => {
    const status = { code: 7, message: "The app is not a member of this space", details: [{ reason: "APP_NOT_IN_SPACE" }] };
    const { manager } = setup({ name: "operations/create" }, { name: "operations/create", done: true, error: status });
    await expect(manager.create("spaces/SPACE")).rejects.toMatchObject({
      name: "WorkspaceEventsOperationError", message: status.message, code: 7, details: status.details, cause: status,
    });
    expect(new WorkspaceEventsOperationError(status).cause).toBe(status);
  });

  it("also surfaces an already-completed failed operation without polling", async () => {
    const { manager, request } = setup({ name: "operations/delete", done: true, error: { code: 5, message: "Subscription not found" } });
    await expect(manager.delete(subscription.name)).rejects.toThrow("Subscription not found");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never retries a failed operation poll or substitutes a generic failure", async () => {
    const { manager, request } = setup({ name: "operations/create" });
    const error = new Error("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    request.mockRejectedValueOnce(error);
    await expect(manager.create("spaces/SPACE")).rejects.toBe(error);
    // Also cover a failure after the mutation was accepted.
    request.mockResolvedValueOnce({ name: "operations/create" }).mockRejectedValueOnce(error);
    await expect(manager.create("spaces/SPACE")).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("allows stopping an operation wait without issuing another request or deleting the subscription", async () => {
    const controller = new AbortController();
    const { manager, request } = setup({ name: "operations/create" });
    controller.abort(new Error("caller stopped waiting"));
    await expect(manager.create("spaces/SPACE", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError", cause: controller.signal.reason,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("Workspace Events service-account authentication", () => {
  it("uses GOOGLE_CHAT_CREDENTIALS_FILE for both documented app scopes, without impersonation", () => {
    vi.stubEnv("GOOGLE_CHAT_CREDENTIALS_FILE", "/credentials/chat-sa.json");
    new GoogleChatSpaceSubscriptions({ pubsubTopic: topic });
    expect(auth.configurations).toEqual([
      { keyFilename: "/credentials/chat-sa.json", scopes: [GOOGLE_CHAT_APP_MESSAGES_SCOPE] },
      { keyFilename: "/credentials/chat-sa.json", scopes: [GOOGLE_CHAT_BOT_SCOPE] },
    ]);
  });

  it("requires the named key instead of silently using default/user credentials", () => {
    vi.stubEnv("GOOGLE_CHAT_CREDENTIALS_FILE", undefined);
    expect(() => new GoogleChatSpaceSubscriptions({ pubsubTopic: topic })).toThrow("GOOGLE_CHAT_CREDENTIALS_FILE is required");
  });

  it("returns API data and disables HTTP retries while preserving original errors", async () => {
    const api = new GoogleWorkspaceEventsApi("/credentials/chat-sa.json");
    auth.request.mockResolvedValueOnce({ data: subscription });
    const request = { method: "GET" as const, url: `${root}/subscriptions` };
    expect(await api.request("bot", request)).toBe(subscription);
    expect(auth.request).toHaveBeenCalledWith({ ...request, retry: false });
    const error = Object.assign(new Error("Google rejected the scope"), { code: 403 });
    auth.request.mockRejectedValueOnce(error);
    await expect(api.request("messages", request)).rejects.toBe(error);
  });
});

describe("renewal time", () => {
  it("uses the returned expiry and the caller's explicit lead time", () => {
    expect(nextGoogleChatSubscriptionRenewalTime(subscription, 15 * 60_000)).toBe(Date.parse("2026-10-10T19:45:00Z"));
    expect(nextGoogleChatSubscriptionRenewalTime(subscription, 0)).toBe(Date.parse(subscription.expireTime));
  });
});
