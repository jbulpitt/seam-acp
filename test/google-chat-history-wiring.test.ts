import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { createHash } from "node:crypto";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { multiplexChatAdapters } from "../packages/core/src/platforms/google-chat/multiplex.js";
import { GoogleChatHistoryReader, type GoogleChatHistoryMessage } from "../packages/core/src/core/messages/google-chat-history.js";
import { GOOGLE_CHAT_DM_HISTORY_CAUSE } from "../packages/core/src/core/messages/google-chat-space-history.js";
import * as readers from "../packages/core/src/core/message-reader.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";

const logger = pino({ level: "silent" });
const space = "spaces/team", thread = `${space}/threads/A`;
const channel = { platform: "google-chat", id: "team.A", parentId: "team" };
const servers: SeamMcpServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); });

function setup(spaceType = "SPACE") {
  const rows: GoogleChatHistoryMessage[] = [1, 2, 3].map(n => ({ name: `${space}/messages/m${n}`,
    createTime: `2026-10-10T12:00:0${n}Z`, text: `marker ${n}`,
    sender: { name: "users/42", displayName: "Alex", type: "HUMAN" }, thread: { name: thread } }));
  const historyRequest = vi.fn(async (options: any): Promise<any> => {
    const url = new URL(options.url);
    if (!url.pathname.endsWith("/messages")) {
      const row = rows.find(r => `/v1/${r.name}` === url.pathname);
      if (!row) throw Object.assign(new Error("Requested entity was not found"), { response: { status: 404 } });
      return { data: row };
    }
    const filter = url.searchParams.get("filter") ?? "";
    let page = rows.filter(r => !filter.includes("thread.name") || filter.includes(r.thread!.name!));
    const before = filter.match(/createTime < "([^"]+)"/)?.[1];
    const after = filter.match(/createTime > "([^"]+)"/)?.[1];
    if (before) page = page.filter(r => Date.parse(r.createTime) < Date.parse(before));
    if (after) page = page.filter(r => Date.parse(r.createTime) > Date.parse(after));
    page = page.sort((a, b) => Date.parse(b.createTime) - Date.parse(a.createTime));
    if (url.searchParams.get("orderBy")?.endsWith("ASC")) page.reverse();
    const offset = Number(url.searchParams.get("pageToken") ?? 0);
    const end = offset + Number(url.searchParams.get("pageSize"));
    return { data: { messages: page.slice(offset, end),
      ...(end < page.length ? { nextPageToken: String(end) } : {}) } };
  });
  const historyReader = new GoogleChatHistoryReader({ credentialsFile: "/test/key.json" }, { request: historyRequest });
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => {
    if (r.method === "GET") return { name: space, spaceType, spaceThreadingState: "THREADED_MESSAGES" };
    const row = { name: `${space}/messages/${r.params.messageId ?? "posted"}`,
      createTime: "2026-10-10T12:00:04Z", sender: { name: "users/real-seam-app", type: "BOT" },
      text: r.data.text, thread: r.data.thread };
    rows.push(row); return row;
  });
  const adapter = new GoogleChatAdapter({ api: { request }, historyReader,
    subscription: "projects/test/subscriptions/events", allowedUserIds: new Set(["users/42"]),
    defaultCwd: "/projects", logger, writeIntervalMs: 0 } as any);
  return { adapter: adapter as any, request, historyRequest, rows };
}

describe("Google Chat adapter history wiring", () => {
  it.each([
    [{ limit: 2 }, ["m3", "m2"]],
    [{ limit: 3, around: `${space}/messages/m2` }, ["m3", "m2", "m1"]],
    [{ limit: 2, before: `${space}/messages/m3` }, ["m2", "m1"]],
    [{ limit: 2, after: `${space}/messages/m1` }, ["m3", "m2"]],
  ])("routes a native thread window %j through the injected history reader", async (input, ids) => {
    const h = setup();
    const result = await h.adapter.fetchMessagePage(channel.id, input);
    expect(result.messages.map((m: any) => m.messageId)).toEqual((ids as string[]).map(id => `${space}/messages/${id}`));
    expect(result.rawCount).toBe((ids as string[]).length);
    expect(new URL(h.historyRequest.mock.calls.at(-1)![0].url).searchParams.get("filter")).toContain(`thread.name = ${thread}`);
    expect(h.request).toHaveBeenCalledExactlyOnceWith("chat", expect.objectContaining({ method: "GET", url: `https://chat.googleapis.com/v1/${space}` }));
  });

  it("uses known actual Space metadata without another GET, and supports flat Space history", async () => {
    const h = setup();
    await h.adapter.receiveEvent({ type: "ADDED_TO_SPACE", space: { name: space, spaceType: "SPACE" } });
    await h.adapter.fetchMessagePage("team", { limit: 3 });
    expect(h.request).not.toHaveBeenCalled();
    expect(new URL(h.historyRequest.mock.calls[0]![0].url).searchParams.get("filter")).toBeNull();
  });

  it("reports the real unsupported DM cause without calling the history API", async () => {
    const h = setup("DIRECT_MESSAGE");
    await expect(h.adapter.fetchMessagePage(channel.id, { limit: 20 })).rejects.toThrow(GOOGLE_CHAT_DM_HISTORY_CAUSE);
    await expect(h.adapter.findMessageByNonce(channel, "nonce", 0)).resolves.toEqual({ status: "indeterminate", reason: GOOGLE_CHAT_DM_HISTORY_CAUSE });
    expect(h.historyRequest).not.toHaveBeenCalled();
  });

  it("looks up the exact sender client id and returns the native message/thread ref", async () => {
    const h = setup();
    const sent = await h.adapter.sendMessage(channel, "answer", { nonce: "Mixed/UPPER_123", enforceNonce: true });
    const result = await h.adapter.findMessageByNonce(channel, "Mixed/UPPER_123", 0);
    const custom = h.request.mock.calls[0]![1].params.messageId;
    expect(result).toMatchObject({ status: "found", message: { id: sent.id, channel } });
    expect(new URL(h.historyRequest.mock.calls[0]![0].url).pathname).toBe(`/v1/${space}/messages/${custom}`);
    expect(h.adapter.getBotUserId(channel)).toBe("users/real-seam-app");
  });

  it("treats only history GET 404 as absent, not an auth denial or network failure", async () => {
    const h = setup();
    await expect(h.adapter.findMessageByNonce(channel, "missing", 0)).resolves.toEqual({ status: "absent" });
    const cause = Object.assign(new Error("The administrator must grant the required OAuth authorization scope"), { response: { status: 403 } });
    h.historyRequest.mockRejectedValue(cause);
    await expect(h.adapter.findMessageByNonce(channel, "nonce", 0)).rejects.toBe(cause);
    await expect(h.adapter.fetchMessagePage(channel.id, { limit: 20 })).rejects.toBe(cause);
  });

  it("does not swallow the Space metadata lookup's real cause", async () => {
    const h = setup(); const cause = new Error("Permission denied or Google Chat resource does not exist");
    h.request.mockRejectedValue(cause);
    await expect(h.adapter.findMessageByNonce(channel, "nonce", 0)).rejects.toBe(cause);
    expect(h.historyRequest).not.toHaveBeenCalled();
  });

  it("uses the wired Space history to prove absence after Google's ambiguous missing-client-id 403", async () => {
    const h = setup();
    const message = "Permission denied to perform the requested action on the specified resource, or the resource doesn't exist.";
    h.historyRequest.mockRejectedValueOnce(Object.assign(new Error(message), { response: { status: 403, data: { error: {
      code: 403, status: "PERMISSION_DENIED", message, errors: [{ message, domain: "global", reason: "forbidden" }],
    } } } }));
    const sinceMs = Date.parse("2026-10-10T11:55:00Z");
    await expect(h.adapter.findMessageByNonce(channel, "missing", sinceMs)).resolves.toEqual({ status: "absent" });
    expect(h.historyRequest).toHaveBeenCalledTimes(2);
    expect(new URL(h.historyRequest.mock.calls[1]![0].url).searchParams.get("filter"))
      .toBe(`thread.name = ${thread} AND createTime > "2026-10-10T11:55:00.000Z"`);
  });

  it("fills omitted sender names from the same message's durable admission, without another Google call", async () => {
    const h = setup();
    const store = new SessionStore(":memory:");
    try {
      h.rows[0]!.sender = { name: "users/42", type: "HUMAN" };
      h.rows[1]!.sender = { name: "users/unadmitted", type: "HUMAN" };
      const admittedId = `gchat_${createHash("sha256").update(h.rows[0]!.name).digest("base64url")}`;
      store.admitInbound({ messageId: admittedId, platform: "google-chat", channelRef: channel.id,
        parentRef: channel.parentId, sessionRecordId: `google-chat:${channel.id}`,
        authorId: "42", authorName: "Alex from admission", text: h.rows[0]!.text!,
        createdUtc: h.rows[0]!.createTime, preemptive: false });
      const lookup = vi.spyOn(store, "getInbound");
      h.adapter.setCommandDeps({ store });
      const page = await h.adapter.fetchMessagePage(channel.id, { limit: 3 });
      expect(page.messages.map((m: any) => m.authorName)).toEqual(["Alex", "users/unadmitted", "Alex from admission"]);
      expect(page.messages.at(-1).authorId).toBe("users/42");
      expect(lookup).toHaveBeenCalledWith(admittedId);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.historyRequest).toHaveBeenCalledTimes(1);
    } finally { store.close(); }
  });
});

function record(ref: string, platform = "google-chat"): SessionRecord {
  return { id: `${platform}:${ref}`, platform, channelRef: ref, parentRef: platform === "google-chat" ? "team" : "discord-parent",
    agentId: "codex", acpSessionId: "saved", repoPath: "/repo", configJson: "{}",
    createdUtc: "2026-10-10T00:00:00Z", updatedUtc: "2026-10-10T00:00:00Z" };
}

describe("MCP readers through the multiplexed Chat history", () => {
  it("reads latest/around/before, searches, and peeks with native anchors; Discord remains its own source", async () => {
    const h = setup();
    const discordPage = vi.fn(async () => ({ messages: [], rawCount: 0, oldestRawId: null, oldestRawTimestampMs: null }));
    const discord = { platform: "discord", start: async () => {}, stop: async () => {},
      onMessage: () => {}, sendMessage: vi.fn(), editMessage: vi.fn(), fetchMessagePage: discordPage };
    const mux = multiplexChatAdapters([discord, h.adapter], id => id.startsWith("team") ? "google-chat" : "discord");
    const factory = (readers as any).createAdapterMessageReaders;
    expect(factory).toBeTypeOf("function");
    const { reader, search } = factory(mux, { interPageDelayMs: 0 });
    const caller = record("team.A"), sibling = record("team.B"), dc = record("123", "discord");
    const server = new SeamMcpServer({ logger: logger as any, resolveSession: token => token === "chat" ? caller : dc,
      enqueueDispatch: async () => {}, resolveThread: id => [caller, sibling, dc].find(r => r.channelRef === id),
      readMessages: (id, input) => reader.readMessages(id, input), searchMessages: input => search.search(input) });
    servers.push(server); await server.start();
    const call = async (name: string, args: unknown, token = "chat") => {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST",
        headers: { "content-type": "application/json", "X-Seam-Session": token },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const body = await response.json() as any; expect(response.status).toBe(200); return body.result;
    };
    for (const input of [{}, { around: `${space}/messages/m2` }, { before: `${space}/messages/m3` }]) {
      const result = await call("read_messages", { thread: channel.id, ...input });
      expect(result.isError).toBeFalsy(); expect(result.structuredContent.messages.length).toBeGreaterThan(0);
      expect(result.structuredContent.messages[0].messageId).toMatch(/^spaces\/team\/messages\//);
    }
    const found = await call("search_messages", { query: "marker 2", threads: [channel.id], since: "2026-10-10T12:00:00Z" });
    expect(found.isError).toBeFalsy(); expect(found.structuredContent.hits).toMatchObject([{ messageId: `${space}/messages/m2` }]);
    for (const row of [h.rows[0]!, h.rows[2]!]) {
      row.text = "SEAM951_C"; row.formattedText = String.raw`SEAM951\_C`;
    }
    const underscore = await call("search_messages", { query: "SEAM951_C", threads: [channel.id] });
    expect(underscore.isError).toBeFalsy();
    expect(underscore.structuredContent.hits.map((hit: any) => hit.messageId)).toEqual([`${space}/messages/m3`, `${space}/messages/m1`]);
    const plain = await call("read_messages", { thread: channel.id, around: `${space}/messages/m1`, limit: 3 });
    expect(plain.structuredContent.messages[0].content).toBe("SEAM951_C");
    const peek = await call("peek", { thread: channel.id }, "discord");
    expect(peek.isError).toBeFalsy(); expect(peek.structuredContent.messages).toHaveLength(3);
    expect(discordPage).not.toHaveBeenCalled();
    await call("peek", { thread: "123" }, "discord"); expect(discordPage).toHaveBeenCalledOnce();
    const refused = await call("read_messages", { thread: channel.id }, "discord");
    expect(refused.isError).toBe(true); expect(refused.content[0].text).toContain("not a session in your channel");
  });
});
