import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import * as actions from "../packages/core/src/platforms/google-chat/command-actions.js";
import { GoogleChatSpaceEvents } from "../packages/core/src/platforms/google-chat/space-events.js";
import { SpaceWriteQueue } from "../packages/core/src/platforms/google-chat/write-queue.js";

const stores: SessionStore[] = [], workers: GoogleChatSpaceEvents[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.stop()));
  stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });

function setup() {
  const store = new SessionStore(":memory:"); stores.push(store);
  const logger = pino({ level: "silent" });
  const space = { name: "spaces/created", spaceType: "SPACE", spaceThreadingState: "THREADED_MESSAGES",
    displayName: "Intake cleanup", spaceUri: "https://chat.google.com/room/created", customer: "customers/org" };
  const membership = { name: "spaces/created/members/person", state: "JOINED", role: "ROLE_MEMBER" };
  const config: any = { DEFAULT_AGENT: "codex", REPOS_ROOT: "/built-in", GOOGLE_CHAT_DEFAULT_LOCATION: "fallback",
    GOOGLE_CHAT_DEFAULT_AGENT: "codex@remote", GOOGLE_CHAT_DEFAULT_MODEL: "org-model",
    GOOGLE_CHAT_DEFAULT_EFFORT: "medium", GOOGLE_CHAT_DEFAULT_CWD: "/org/repo" };
  const requestIds = new Set<string>(); let membershipPresent = false;
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => {
    if (r.method === "POST" && r.url.endsWith("/spaces")) { requestIds.add(r.params.requestId); return { ...space }; }
    if (r.method === "POST" && r.url.endsWith("/members")) {
      if (membershipPresent) throw Object.assign(new Error("Member already exists"), { response: { status: 409 } });
      membershipPresent = true; return { ...membership };
    }
    if (r.method === "GET" && r.url.includes("/members/")) return { ...membership };
    return {};
  });
  const subscription: any = { name: "subscriptions/created", targetResource: "//chat.googleapis.com/spaces/created",
    eventTypes: ["google.workspace.chat.message.v1.created"], payloadOptions: { includeResource: true },
    notificationEndpoint: { pubsubTopic: "projects/test/topics/events" }, expireTime: new Date(Date.now() + 3_600_000).toISOString(), state: "ACTIVE" };
  const client = { list: vi.fn(async () => []), create: vi.fn(async () => subscription),
    renew: vi.fn(async () => subscription), delete: vi.fn(async () => {}) };
  const events = new GoogleChatSpaceEvents({ api: { request }, pubsubTopic: "projects/test/topics/events",
    store: store.googleChatSpaces, subscriptions: client, logger }); workers.push(events);
  const prepare = vi.fn(async (selection: any) => ({ ...selection }));
  const bind = vi.fn(async (channel: any, snapshot: any) => {
    const prior = store.getByChannel("google-chat", channel.id);
    if (prior) return prior;
    const now = new Date().toISOString();
    const record = { id: `google-chat:${channel.id}`, platform: "google-chat", channelRef: channel.id, parentRef: null,
      agentId: snapshot.agentId, acpSessionId: "", repoPath: snapshot.repo,
      configJson: JSON.stringify({ model: snapshot.model, reasoningEffort: snapshot.effort, location: snapshot.location }),
      createdUtc: now, updatedUtc: now };
    store.upsert(record); return record;
  });
  const input = { messageId: "gchat_new_one", origin: { platform: "google-chat", id: "origin.command", parentId: "origin" },
    requester: { id: "users/person", name: "Person" }, args: "Intake cleanup" };
  const make = () => new (actions as any).GoogleChatSessionSpaces({ config, customer: "customers/org", api: { request },
    store, writes: new SpaceWriteQueue({ logger, intervalMs: 0 }), spaceEvents: events, prepare, bind, logger });
  return { store, config, space, membership, request, requestIds, client, events, prepare, bind, input, make, logger };
}

describe("durable Google Chat session Space creation", () => {
  it("creates a private Space, adds/promotes the requester, locks app removal and registers its subscription", async () => {
    const h = setup();
    const result = await h.make().create(h.input);
    expect(result).toMatchObject({ channel: { platform: "google-chat", id: "created" },
      sessionRecordId: "google-chat:created", snapshot: { agentId: "codex", location: "remote", model: "org-model", effort: "medium", repo: "/org/repo" } });
    expect(h.request.mock.calls.slice(0, 4)).toEqual([
      ["spaces", expect.objectContaining({ method: "POST", url: "https://chat.googleapis.com/v1/spaces",
        params: { requestId: expect.any(String) }, data: { spaceType: "SPACE", displayName: "Intake cleanup", customer: "customers/org" } })],
      ["memberships", expect.objectContaining({ method: "POST", url: "https://chat.googleapis.com/v1/spaces/created/members",
        data: { member: { name: "users/person", type: "HUMAN" } } })],
      ["memberships", expect.objectContaining({ method: "PATCH", url: "https://chat.googleapis.com/v1/spaces/created/members/person",
        params: { updateMask: "role" }, data: { role: "ROLE_MANAGER" } })],
      ["spaces", expect.objectContaining({ method: "PATCH", url: "https://chat.googleapis.com/v1/spaces/created",
        params: { updateMask: "permissionSettings.manageApps" },
        data: { permissionSettings: { manageApps: { managersAllowed: true, membersAllowed: false } } } })],
    ]);
    expect(h.client.create).toHaveBeenCalledOnce();
    expect(h.store.googleChatSpaces.get(h.space.name)?.subscription?.name).toBe("subscriptions/created");
    expect(h.store.getInbound(h.input.messageId)?.state).toBe("completed");
    expect(h.store.getByChannel("google-chat", "created")?.parentRef).toBeNull();
    expect(h.request.mock.calls.some(([, r]) => r.url.endsWith("/messages"))).toBe(false);
  });

  it("applies /new overrides without changing the org config or the origin's ACP session", async () => {
    const h = setup(), now = new Date().toISOString();
    h.store.upsert({ id: "google-chat:origin.command", platform: "google-chat", channelRef: "origin.command", parentRef: "origin",
      agentId: "other", acpSessionId: "keep-acp", repoPath: "/person/repo", configJson: '{"model":"person-model"}', createdUtc: now, updatedUtc: now });
    const before = JSON.stringify(h.config);
    const result = await h.make().create({ ...h.input, args: "Other task agent=codex@local model=override effort=high repo=/override" });
    expect(result.snapshot).toEqual({ agentId: "codex", location: "local", model: "override", effort: "high", repo: "/override" });
    expect(JSON.stringify(h.config)).toBe(before);
    expect(h.store.get("google-chat:origin.command")?.acpSessionId).toBe("keep-acp");
  });

  it("replays a completed creation without repeating Google effects, validation or binding", async () => {
    const h = setup(); await h.make().create(h.input);
    const count = h.request.mock.calls.length;
    h.config.GOOGLE_CHAT_DEFAULT_MODEL = "changed-org-model";
    const result = await h.make().create({ ...h.input, args: "different text model=another" });
    expect(result.snapshot.model).toBe("org-model");
    expect(h.request).toHaveBeenCalledTimes(count); expect(h.prepare).toHaveBeenCalledOnce(); expect(h.bind).toHaveBeenCalledOnce();
  });

  it("joins concurrent redeliveries of the same native command", async () => {
    const h = setup(), launcher = h.make();
    const [a, b] = await Promise.all([launcher.create(h.input), launcher.create(h.input)]);
    expect(a).toEqual(b); expect(h.requestIds.size).toBe(1); expect(h.bind).toHaveBeenCalledOnce();
  });

  it.each(["member", "promote", "lock", "subscription"])("keeps progress and the real cause when %s fails, then resumes", async stage => {
    const h = setup(), cause = Object.assign(new Error(`Google ${stage}: permission denied`), { response: { status: 403 } });
    const original = h.request.getMockImplementation()!; let failed = false;
    h.request.mockImplementation(async (scope, r) => {
      const matches = stage === "member" ? r.method === "POST" && r.url.endsWith("/members")
        : stage === "promote" ? r.params?.updateMask === "role" : stage === "lock" && r.params?.updateMask === "permissionSettings.manageApps";
      if (matches && !failed) { failed = true; throw cause; } return original(scope, r);
    });
    if (stage === "subscription") h.client.create.mockRejectedValueOnce(cause);
    const error = vi.spyOn(h.logger, "error");
    await expect(Promise.resolve().then(() => h.make().create(h.input))).rejects.toBe(cause);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: cause, messageId: h.input.messageId }),
      "Google Chat session Space setup failed");
    expect(h.store.getInbound(h.input.messageId)?.state).not.toBe("completed");
    h.config.GOOGLE_CHAT_DEFAULT_CWD = "/changed/org";
    const result = await h.make().create(h.input);
    expect(result.snapshot.repo).toBe("/org/repo"); expect(h.requestIds.size).toBe(1);
    expect(h.request.mock.calls.filter(([, r]) => r.method === "POST" && r.url.endsWith("/spaces"))).toHaveLength(1);
  });

  it("reuses Google's requestId after create succeeded but its SQLite checkpoint failed", async () => {
    const h = setup(); let interrupted = false;
    const original = (h.store as any).saveInboundCommandProgress?.bind(h.store);
    vi.spyOn(h.store as any, "saveInboundCommandProgress").mockImplementation((...args: any[]) => {
      if (args[1].spaceCreation?.space && !interrupted) { interrupted = true; throw new Error("checkpoint interrupted"); }
      return original(...args);
    });
    await expect(h.make().create(h.input)).rejects.toThrow("checkpoint interrupted");
    await h.make().create(h.input);
    expect(h.requestIds.size).toBe(1);
    const posts = h.request.mock.calls.filter(([, r]) => r.method === "POST" && r.url.endsWith("/spaces"));
    expect(posts).toHaveLength(2); expect(posts[0]![1].data).toEqual(posts[1]![1].data);
  });

  it("reconciles a membership collision after its API effect outran its SQLite checkpoint", async () => {
    const h = setup(); let interrupted = false;
    const original = (h.store as any).saveInboundCommandProgress?.bind(h.store);
    vi.spyOn(h.store as any, "saveInboundCommandProgress").mockImplementation((...args: any[]) => {
      if (args[1].spaceCreation?.membershipName && !interrupted) { interrupted = true; throw new Error("membership checkpoint interrupted"); }
      return original(...args);
    });
    await expect(h.make().create(h.input)).rejects.toThrow("membership checkpoint interrupted");
    await h.make().create(h.input);
    expect(h.request).toHaveBeenCalledWith("memberships", expect.objectContaining({ method: "GET",
      url: "https://chat.googleapis.com/v1/spaces/created/members/person" }));
    expect(h.requestIds.size).toBe(1);
  });

  it("does no Google writes when shared validation rejects a launch", async () => {
    const h = setup(), cause = new Error("pwd: /missing: Permission denied"); h.prepare.mockRejectedValueOnce(cause);
    await expect(Promise.resolve().then(() => h.make().create(h.input))).rejects.toBe(cause);
    expect(h.request).not.toHaveBeenCalled(); expect(h.bind).not.toHaveBeenCalled();
  });

  it("does not terminalize a command merely because a partial result was checkpointed", () => {
    const h = setup(); h.store.admitInbound({ messageId: "command-progress", platform: "google-chat", channelRef: "origin.command",
      sessionRecordId: "google-chat:origin.command", authorId: "person", text: "/new", createdUtc: new Date().toISOString(),
      preemptive: false, commandResult: { replies: [] } });
    h.store.claimInbound("command-progress", 0, new Date().toISOString());
    (h.store as any).saveInboundCommandProgress("command-progress", { replies: [], spaceCreation: { requestId: "stable" } }, new Date().toISOString());
    expect(h.store.getInbound("command-progress")?.state).toBe("running");
    expect((h.store.getInbound("command-progress")?.commandResult as any).spaceCreation.requestId).toBe("stable");
  });
});
