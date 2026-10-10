import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CHAT_HISTORY_SCOPE,
  GoogleChatHistoryReader,
  loadGoogleChatHistoryConfig,
  type ChatHistoryHttpRequest,
  type ChatHistoryRequestor,
} from "../packages/core/src/core/messages/google-chat-history.js";

const auth = vi.hoisted(() => ({ options: vi.fn(), request: vi.fn() }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    constructor(options: unknown) { auth.options(options); }
    request = auth.request;
  },
}));

const config = { credentialsFile: "/test/chat-service-account.json" };
const space = "spaces/example";
const thread = `${space}/threads/first`;
const firstTime = "2026-10-10T12:00:00Z";
const secondTime = "2026-10-10T12:01:00Z";
const human = {
  name: `${space}/messages/first`, createTime: firstTime,
  sender: { name: "users/123", displayName: "A Person", type: "HUMAN" },
  text: "hello", formattedText: "**hello**", thread: { name: thread },
  attachment: [{ contentName: "notes.txt" }, {}],
};
const bot = {
  name: `${space}/messages/second`, createTime: secondTime,
  sender: { name: "users/app", type: "BOT" },
  cardsV2: [{ cardId: "status", card: {} }], accessoryWidgets: [{ buttonList: {} }],
};

function fakeChat(...responses: unknown[]) {
  const request = vi.fn(async (_options: ChatHistoryHttpRequest) => ({ data: responses.shift() }));
  const client: ChatHistoryRequestor = {
    async request<T>(options: ChatHistoryHttpRequest) {
      const response = await request(options);
      return { data: response.data as T };
    },
  };
  return { client, request };
}

function params(options: ChatHistoryHttpRequest) {
  return Object.fromEntries(new URL(String(options.url)).searchParams);
}

beforeEach(() => vi.clearAllMocks());

describe("Google Chat app-auth history", () => {
  it("uses the explicit service-account key and admin-approved message read scope", async () => {
    auth.request.mockResolvedValue({ data: {} });
    await new GoogleChatHistoryReader(config).readPage({ space, limit: 25 });
    expect(auth.options).toHaveBeenCalledExactlyOnceWith({
      keyFilename: config.credentialsFile,
      scopes: ["https://www.googleapis.com/auth/chat.app.messages.readonly"],
    });
    expect(GOOGLE_CHAT_HISTORY_SCOPE).toBe("https://www.googleapis.com/auth/chat.app.messages.readonly");
  });

  it("lists a space newest-first and returns the neutral page and raw cursor facts", async () => {
    const chat = fakeChat({ messages: [bot, human], nextPageToken: "next/+token=" });
    const result = await new GoogleChatHistoryReader(config, chat.client).readPage({ space, limit: 2 });

    expect(chat.request).toHaveBeenCalledTimes(1);
    const options = chat.request.mock.calls[0]![0];
    expect(new URL(String(options.url)).pathname).toBe(`/v1/${space}/messages`);
    expect(options).toMatchObject({ method: "GET", retry: false });
    expect(options.data).toBeUndefined();
    expect(params(options)).toEqual({ pageSize: "2", orderBy: "createTime DESC" });
    expect(result).toMatchObject({
      rawCount: 2, oldestRawId: human.name, oldestRawTimestampMs: Date.parse(firstTime), nextPageToken: "next/+token=",
    });
    expect(result.messages.map((message) => message.messageId)).toEqual([bot.name, human.name]);
    expect(result.messages[1]).toEqual({
      messageId: human.name, timestampMs: Date.parse(firstTime), authorId: "users/123", authorName: "A Person",
      authorType: "human", content: "hello", attachmentNames: ["notes.txt"], hasEmbeds: false,
      hasComponents: false, threadName: thread,
      jumpLinkUnavailableReason: "Google Chat messages.list does not return a message permalink",
    });
    expect(result.messages[0]).toMatchObject({ authorType: "bot", authorName: "users/app", content: "", hasEmbeds: true, hasComponents: true });
  });

  it("filters a thread and exclusive RFC3339 bounds without fetching another thread", async () => {
    const chat = fakeChat({});
    await new GoogleChatHistoryReader(config, chat.client).readPage({
      space, thread, limit: 100, order: "oldest", before: secondTime, after: firstTime,
    });
    expect(params(chat.request.mock.calls[0]![0])).toEqual({
      pageSize: "100", orderBy: "createTime ASC",
      filter: `thread.name = ${thread} AND createTime < "${secondTime}" AND createTime > "${firstTime}"`,
    });
  });

  it("follows tokens across short and empty pages while preserving every other parameter", async () => {
    const chat = fakeChat(
      { messages: [human], nextPageToken: "short/+=" },
      { nextPageToken: "empty/+=" },
      { messages: [bot] },
    );
    const pages = [];
    for await (const page of new GoogleChatHistoryReader(config, chat.client).pages({
      space, thread, limit: 100, order: "oldest", after: firstTime,
    })) pages.push(page);

    expect(pages.map((page) => page.rawCount)).toEqual([1, 0, 1]);
    expect(pages[1]).toEqual({ messages: [], rawCount: 0, oldestRawId: null, oldestRawTimestampMs: null, nextPageToken: "empty/+=" });
    expect(pages[2]!.nextPageToken).toBeNull();
    const base = params(chat.request.mock.calls[0]![0]);
    expect(params(chat.request.mock.calls[1]![0])).toEqual({ ...base, pageToken: "short/+=" });
    expect(params(chat.request.mock.calls[2]![0])).toEqual({ ...base, pageToken: "empty/+=" });
  });

  it("can start from a supplied continuation token", async () => {
    const chat = fakeChat({ messages: [human] });
    const pages = [];
    for await (const page of new GoogleChatHistoryReader(config, chat.client).pages({ space, limit: 10, pageToken: "resume/+=" })) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(params(chat.request.mock.calls[0]![0]).pageToken).toBe("resume/+=");
  });

  it("uses the oldest raw row even in ascending order or when a deleted row is excluded", async () => {
    const deleted = { ...human, deleteTime: secondTime };
    const chat = fakeChat({ messages: [deleted, bot], nextPageToken: "more" });
    const page = await new GoogleChatHistoryReader(config, chat.client).readPage({ space, limit: 2, order: "oldest" });
    expect(page.messages.map((message) => message.messageId)).toEqual([bot.name]);
    expect(page).toMatchObject({ rawCount: 2, oldestRawId: human.name, oldestRawTimestampMs: Date.parse(firstTime), nextPageToken: "more" });
  });

  it("handles Google's empty-object response without inventing a cursor", async () => {
    const chat = fakeChat({});
    await expect(new GoogleChatHistoryReader(config, chat.client).readPage({ space, limit: 25 })).resolves.toEqual({
      messages: [], rawCount: 0, oldestRawId: null, oldestRawTimestampMs: null, nextPageToken: null,
    });
  });

  it("compares raw times as instants, including fractional RFC3339 timestamps", async () => {
    const chat = fakeChat({ messages: [
      { ...bot, createTime: "2026-10-10T12:00:00.100Z" },
      { ...human, createTime: "2026-10-10T12:00:00Z" },
    ] });
    const page = await new GoogleChatHistoryReader(config, chat.client).readPage({ space, limit: 2 });
    expect(page.oldestRawId).toBe(human.name);
    expect(page.oldestRawTimestampMs).toBe(Date.parse(firstTime));
  });

  it("keeps plain text, legacy cards and attachment-only messages", async () => {
    const chat = fakeChat({ messages: [
      { ...human, formattedText: undefined, cards: [{}] },
      { ...bot, cardsV2: [], accessoryWidgets: [], attachment: [{ contentName: "result.pdf" }] },
    ] });
    const page = await new GoogleChatHistoryReader(config, chat.client).readPage({ space, limit: 2 });
    expect(page.messages[0]).toMatchObject({ content: "hello", hasEmbeds: true });
    expect(page.messages[1]).toMatchObject({ content: "", attachmentNames: ["result.pdf"], hasEmbeds: false, hasComponents: false });
  });

  it("preserves the user's literal underscores and backslashes instead of formatted Markdown", async () => {
    const text = String.raw`SEAM951_C path\segment`;
    const chat = fakeChat({ messages: [{ ...human, text,
      formattedText: String.raw`SEAM951\_C path\\segment` }] });
    const page = await new GoogleChatHistoryReader(config, chat.client).readPage({ space, limit: 2 });
    expect(page.messages[0]!.content).toBe(text);
  });

  it("passes Google's unapproved-scope error through unchanged, without falling back", async () => {
    const error = Object.assign(new Error("The administrator must grant the app the required OAuth authorization scope for this action."), {
      code: 403, response: { data: { error: { code: 403, status: "PERMISSION_DENIED", message: "The administrator must grant the app the required OAuth authorization scope for this action." } } },
    });
    const chat = fakeChat();
    chat.request.mockRejectedValue(error);
    await expect(new GoogleChatHistoryReader(config, chat.client).readPage({ space, limit: 25 })).rejects.toBe(error);
    expect(chat.request).toHaveBeenCalledTimes(1);
  });

  it("passes a transport error and its socket cause through unchanged", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
    const error = new TypeError("fetch failed", { cause });
    const chat = fakeChat();
    chat.request.mockRejectedValue(error);
    await expect(new GoogleChatHistoryReader(config, chat.client).readPage({ space, limit: 25 })).rejects.toBe(error);
  });

  it("doesn't turn a later-page provider failure into a successful partial history", async () => {
    const error = Object.assign(new Error("backend unavailable"), { code: 503 });
    const chat = fakeChat({ messages: [human], nextPageToken: "more" });
    chat.request.mockImplementationOnce(async () => ({ data: { messages: [human], nextPageToken: "more" } })).mockRejectedValueOnce(error);
    const pages = new GoogleChatHistoryReader(config, chat.client).pages({ space, limit: 100 });
    expect((await pages.next()).value).toMatchObject({ rawCount: 1 });
    await expect(pages.next()).rejects.toBe(error);
  });
});

describe("Chat history standalone config", () => {
  it("reads the same credential filename as the Chat and Drive modules", () => {
    expect(loadGoogleChatHistoryConfig({ GOOGLE_CHAT_CREDENTIALS_FILE: " /test/key.json " })).toEqual({ credentialsFile: "/test/key.json" });
  });

  it.each([undefined, "", "  "])("does not silently substitute ADC for missing credentials (%s)", (value) => {
    expect(() => loadGoogleChatHistoryConfig({ GOOGLE_CHAT_CREDENTIALS_FILE: value })).toThrow("GOOGLE_CHAT_CREDENTIALS_FILE is required for Chat history reads");
  });
});
