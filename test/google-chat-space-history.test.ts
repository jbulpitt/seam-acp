import { describe, expect, it, vi } from "vitest";
import { LiveMessageSearch, MessageReader } from "../packages/core/src/core/message-reader.js";
import { projectDiscordConversation } from "../packages/core/src/core/reconstruction/project.js";
import {
  GoogleChatHistoryReader,
  type ChatHistoryHttpRequest,
  type ChatHistoryRequestor,
  type GoogleChatHistoryMessage,
} from "../packages/core/src/core/messages/google-chat-history.js";
import {
  fetchMessagePage,
  findMessageByNonce,
  googleChatClientMessageId,
  type GoogleChatHistoryTarget,
} from "../packages/core/src/core/messages/google-chat-space-history.js";

const space = "spaces/example";
const thread = `${space}/threads/topic`;
const target: GoogleChatHistoryTarget = { space, thread, spaceType: "SPACE" };
const config = { credentialsFile: "/test/chat-service-account.json" };
const dmCause = "DMs are not supported for methods requiring app authentication with administrator approval";

function message(index: number, overrides: Partial<GoogleChatHistoryMessage> = {}): GoogleChatHistoryMessage {
  return {
    name: `${space}/messages/m${String(index).padStart(3, "0")}`,
    createTime: new Date(Date.UTC(2026, 9, 10) + index * 1000).toISOString(),
    sender: { name: "users/person", displayName: "Person", type: "HUMAN" },
    text: `message ${index}`, thread: { name: thread }, ...overrides,
  };
}

function fakeChat(respond: (options: ChatHistoryHttpRequest) => unknown) {
  const request = vi.fn(async (options: ChatHistoryHttpRequest) => ({ data: respond(options) }));
  const client: ChatHistoryRequestor = {
    async request<T>(options: ChatHistoryHttpRequest) {
      const result = await request(options);
      return { data: result.data as T };
    },
  };
  return { request, reader: new GoogleChatHistoryReader(config, client) };
}

function history(messages: GoogleChatHistoryMessage[], nativePageSize = 23) {
  return fakeChat((options) => {
    const url = new URL(String(options.url));
    if (!url.pathname.endsWith("/messages")) {
      const found = messages.find((item) => `/v1/${item.name}` === url.pathname);
      if (!found) throw Object.assign(new Error("Google: message not found"), { response: { status: 404 } });
      return found;
    }
    const filter = url.searchParams.get("filter") ?? "";
    const threadName = /thread.name = (\S+)/.exec(filter)?.[1];
    const before = /createTime < "([^"]+)"/.exec(filter)?.[1];
    const after = /createTime > "([^"]+)"/.exec(filter)?.[1];
    let rows = messages.filter((item) =>
      (!threadName || item.thread?.name === threadName) &&
      (!before || Date.parse(item.createTime) < Date.parse(before)) &&
      (!after || Date.parse(item.createTime) > Date.parse(after)));
    if (url.searchParams.get("orderBy") === "createTime DESC") rows = rows.toReversed();
    const offset = Number(url.searchParams.get("pageToken") ?? 0);
    const size = Math.min(nativePageSize, Number(url.searchParams.get("pageSize")));
    const end = offset + size;
    return { messages: rows.slice(offset, end), ...(end < rows.length ? { nextPageToken: String(end) } : {}) };
  });
}

async function page(chat: ReturnType<typeof fakeChat>, request: Parameters<typeof fetchMessagePage>[2]) {
  const result = await fetchMessagePage(chat.reader, target, request);
  expect(result.status).toBe("supported");
  if (result.status !== "supported") throw new Error(result.cause);
  return result.page;
}

function source(chat: ReturnType<typeof fakeChat>) {
  return new MessageReader({ fetchMessagePage: async (_threadId, request) => page(chat, request) }, { interPageDelayMs: 0 });
}

describe("Google Chat named-space history source", () => {
  it("returns the observed DM limitation for history and nonce lookup without calling Google", async () => {
    const chat = history([]);
    const dm: GoogleChatHistoryTarget = { space, spaceType: "DIRECT_MESSAGE" };
    await expect(fetchMessagePage(chat.reader, dm, { limit: 100 })).resolves.toEqual({ status: "unsupported", cause: dmCause });
    await expect(findMessageByNonce(chat.reader, dm, "delivery-1")).resolves.toEqual({ status: "unsupported", cause: dmCause });
    expect(chat.request).not.toHaveBeenCalled();
  });

  it("fills a neutral page across short and empty native pages with stable query parameters", async () => {
    const responses = [
      { messages: [message(3)], nextPageToken: "short/+=" },
      { nextPageToken: "empty/+=" },
      { messages: [message(2), message(1)] },
    ];
    const chat = fakeChat(() => responses.shift());
    const result = await page(chat, { limit: 3 });
    expect(result.messages.map((item) => item.messageId)).toEqual([message(3).name, message(2).name, message(1).name]);
    expect(result).toMatchObject({ rawCount: 3, oldestRawId: message(1).name });
    const queries = chat.request.mock.calls.map(([options]) => Object.fromEntries(new URL(String(options.url)).searchParams));
    expect(queries).toEqual([
      { pageSize: "3", orderBy: "createTime DESC", filter: `thread.name = ${thread}` },
      { ...queries[0], pageToken: "short/+=" },
      { ...queries[0], pageToken: "empty/+=" },
    ]);
  });

  it("returns empty cursor facts only after native tokens are exhausted", async () => {
    const chat = history([]);
    await expect(page(chat, { limit: 3 })).resolves.toEqual({ messages: [], rawCount: 0, oldestRawId: null, oldestRawTimestampMs: null });
  });

  it("uses exclusive message IDs for before even when every timestamp is equal", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => message(i, { createTime: "2026-10-10T12:00:00.123456789Z" }));
    const chat = history(rows, 2);
    const result = await page(chat, { limit: 3, before: rows[4]!.name });
    expect(result.messages.map((item) => item.messageId)).toEqual([rows[3]!.name, rows[2]!.name, rows[1]!.name]);
    expect(new URL(String(chat.request.mock.calls[0]![0].url)).pathname).toBe(`/v1/${rows[4]!.name}`);
    expect(new URL(String(chat.request.mock.calls[1]![0].url)).searchParams.get("filter"))
      .toBe(`thread.name = ${thread} AND createTime < "2026-10-10T12:00:00.124Z"`);
  });

  it("returns the nearest messages after the anchor, including timestamp ties", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => message(i, { createTime: "2026-10-10T12:00:00Z" }));
    const chat = history(rows, 2);
    const result = await page(chat, { limit: 2, after: rows[2]!.name });
    expect(result.messages.map((item) => item.messageId)).toEqual([rows[4]!.name, rows[3]!.name]);
    const list = chat.request.mock.calls[1]![0];
    expect(new URL(String(list.url)).searchParams.get("orderBy")).toBe("createTime ASC");
    expect(new URL(String(list.url)).searchParams.get("filter"))
      .toBe(`thread.name = ${thread} AND createTime > "2026-10-10T11:59:59.999Z"`);
  });

  it.each([
    { anchor: 4, limit: 5, expected: [6, 5, 4, 3, 2] },
    { anchor: 0, limit: 5, expected: [4, 3, 2, 1, 0] },
    { anchor: 8, limit: 5, expected: [8, 7, 6, 5, 4] },
    { anchor: 4, limit: 1, expected: [4] },
    { anchor: 4, limit: 2, expected: [4, 3] },
  ])("reads around $anchor with limit $limit and fills at history edges", async ({ anchor, limit, expected }) => {
    const rows = Array.from({ length: 9 }, (_, i) => message(i));
    const result = await page(history(rows, 2), { limit, around: rows[anchor]!.name });
    expect(result.messages.map((item) => item.messageId)).toEqual(expected.map((i) => rows[i]!.name));
    expect(result.rawCount).toBe(limit);
  });

  it("retains deleted raw rows as cursors instead of treating filtering as exhaustion", async () => {
    const rows = [message(1, { deleteTime: "2026-10-10T13:00:00Z" }), message(2)];
    const result = await page(history(rows, 1), { limit: 2 });
    expect(result.messages.map((item) => item.messageId)).toEqual([rows[1]!.name]);
    expect(result).toMatchObject({ rawCount: 2, oldestRawId: rows[0]!.name, oldestRawTimestampMs: Date.parse(rows[0]!.createTime) });
  });

  it("feeds read_messages card, attachment and anchor rendering through the existing reader", async () => {
    const rows = [message(1), message(2, { text: "", cardsV2: [{}], sender: { name: "users/app", type: "BOT" } }),
      message(3, { text: "", attachment: [{ contentName: "notes.txt" }] })];
    const read = await source(history(rows)).readMessages(thread, { around: rows[1]!.name, limit: 3 });
    expect(read.messages.map((item) => item.messageId)).toEqual(rows.map((item) => item.name));
    expect(read.messages[1]).toMatchObject({ isCard: true, authorType: "bot" });
    expect(read.messages[2]).toMatchObject({ attachments: ["notes.txt"] });
    expect(read.messages.every((item) => item.jumpLinkUnavailableReason && !item.jumpUrl)).toBe(true);
  });

  it("feeds complete search and rebuild history across more than 100 equal-timestamp rows", async () => {
    const rows = Array.from({ length: 105 }, (_, i) => message(i, { createTime: "2026-10-10T12:00:00Z", text: `message ${i}` }));
    const chat = history([...rows, message(106, { thread: { name: `${space}/threads/other` } })], 17);
    const reader = source(chat);
    const walked = await reader.walkThread(thread, { maxPages: 5 });
    expect(walked).toMatchObject({ truncated: false, pagesFetched: 2 });
    expect(new Set(walked.messages.map((item) => item.messageId))).toEqual(new Set(rows.map((item) => item.name)));
    const logical = projectDiscordConversation(walked.messages, { seamBotId: "users/app" });
    expect(logical.flatMap((item) => item.sourcePostIds)).toEqual(rows.map((item) => item.name));
    const search = await new LiveMessageSearch(reader).search({ query: "message 0", threads: [{ id: thread, name: "Topic" }] });
    expect(search).toMatchObject({ truncated: false, pagesFetched: 2 });
    expect(search.hits.map((item) => item.messageId)).toEqual([rows[0]!.name]);
  });

  it("finds two plain underscore hits and preserves that text for reads and rebuild projection", async () => {
    const rows = [
      message(1, { text: "SEAM951_C", formattedText: String.raw`SEAM951\_C` }),
      message(2, { text: "Remember SEAM951_C", formattedText: String.raw`Remember SEAM951\_C`,
        sender: { name: "users/app", type: "BOT" } }),
      message(3, { text: "another marker" }),
    ];
    const reader = source(history(rows, 2));
    const search = await new LiveMessageSearch(reader).search({ query: "SEAM951_C", threads: [{ id: thread, name: "Topic" }] });
    expect(search.hits.map(item => item.messageId)).toEqual([rows[1]!.name, rows[0]!.name]);
    const read = await reader.readMessages(thread, { limit: 3 });
    expect(read.messages.map(item => item.content)).toEqual(rows.map(item => item.text));
    const walked = await reader.walkThread(thread, { maxPages: 5 });
    const logical = projectDiscordConversation(walked.messages, { seamBotId: "users/app" });
    expect(logical.map(item => item.text)).toEqual(rows.map(item => item.text));
  });

  it("supports space-only history without a thread filter", async () => {
    const chat = history([message(1), message(2, { thread: { name: `${space}/threads/other` } })]);
    const result = await fetchMessagePage(chat.reader, { space, spaceType: "SPACE" }, { limit: 3 });
    expect(result.status === "supported" && result.page.rawCount).toBe(2);
    expect(new URL(String(chat.request.mock.calls[0]![0].url)).searchParams.has("filter")).toBe(false);
  });

  it("preserves an anchor GET error and a later list error instead of returning partial history", async () => {
    const error = Object.assign(new Error("Google: admin scope not approved"), { response: { status: 403, data: { error: { message: "approval required" } } } });
    const denied = fakeChat(() => { throw error; });
    await expect(page(denied, { limit: 3, before: message(2).name })).rejects.toBe(error);
    let calls = 0;
    const partial = fakeChat(() => {
      if (calls++ === 0) return { messages: [message(2)], nextPageToken: "more" };
      throw error;
    });
    await expect(page(partial, { limit: 3 })).rejects.toBe(error);
  });

  it("does not present a wrong-thread anchor as exhausted history", async () => {
    const other = message(1, { thread: { name: `${space}/threads/other` } });
    await expect(page(history([other]), { limit: 3, before: other.name })).rejects.toThrow(`Google Chat history did not list anchor ${other.name} in ${thread}`);
  });
});

describe("Google Chat named-space delivery nonce lookup", () => {
  it("gets the existing sender's client ID and returns Google's canonical message name", async () => {
    const chat = fakeChat(() => message(1, { sender: { name: "users/app", type: "BOT" } }));
    const clientId = "client-0b220df1969115139ffebb337981298d243a44f84dad5d20d7e7da5f";
    expect(googleChatClientMessageId("delivery-1")).toBe(clientId);
    await expect(findMessageByNonce(chat.reader, target, "delivery-1")).resolves.toMatchObject({ status: "found", message: { messageId: message(1).name, threadName: thread } });
    expect(chat.request).toHaveBeenCalledTimes(1);
    expect(chat.request.mock.calls[0]![0]).toMatchObject({ method: "GET", retry: false });
    const url = new URL(String(chat.request.mock.calls[0]![0].url));
    expect(url.pathname).toBe(`/v1/${space}/messages/${clientId}`);
    expect(url.searchParams.has("markupSyntax")).toBe(false);
  });

  it("returns absent only when Google confirms the client ID is missing", async () => {
    const error = Object.assign(new Error("Google: message not found"), { response: { status: 404 } });
    const chat = fakeChat(() => { throw error; });
    await expect(findMessageByNonce(chat.reader, target, "delivery-1")).resolves.toEqual({ status: "absent" });
  });

  it.each([401, 403, 429, 500])("retains a Google %s denial or outage instead of treating it as absent", async (status) => {
    const error = Object.assign(new Error(`Google failure ${status}`), { response: { status }, cause: new Error("underlying cause") });
    const chat = fakeChat(() => { throw error; });
    await expect(findMessageByNonce(chat.reader, target, "delivery-1")).rejects.toBe(error);
  });

  it("retains a transport failure with its nested cause", async () => {
    const error = new Error("Google request failed", { cause: new Error("socket closed") });
    const chat = fakeChat(() => { throw error; });
    await expect(findMessageByNonce(chat.reader, target, "delivery-1")).rejects.toBe(error);
  });
});
