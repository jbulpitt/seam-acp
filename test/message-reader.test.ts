import { describe, expect, it, vi } from "vitest";
import {
  LiveMessageSearch,
  MessageReader,
  isMessageCardOrNoise,
  parseSince,
  timestampToSnowflake,
  type MessagePageItem,
  type MessagePageRequest,
  type MessagePageSource,
} from "../packages/core/src/core/message-reader.js";

const BASE = Date.UTC(2026, 7, 1);

function message(
  id: number,
  content: string,
  over: Partial<MessagePageItem> = {}
): MessagePageItem {
  return {
    messageId: String(id).padStart(18, "0"),
    timestampMs: BASE + id * 1_000,
    authorId: "human-1",
    authorName: "Jesse",
    authorType: "human",
    content,
    attachmentNames: [],
    hasEmbeds: false,
    hasComponents: false,
    ...over,
  };
}

describe("MessageReader", () => {
  it("uses cursor pagination and returns chronological messages", async () => {
    const all = Array.from({ length: 205 }, (_, index) => message(index + 1, `message ${index + 1}`));
    const requests: MessagePageRequest[] = [];
    const source: MessagePageSource = {
      fetchMessagePage: async (_threadId, request) => {
        requests.push(request);
        const before = request.before ? BigInt(request.before) : undefined;
        return all
          .filter((item) => before === undefined || BigInt(item.messageId) < before)
          .slice(-request.limit)
          .reverse();
      },
    };
    const reader = new MessageReader(source, { interPageDelayMs: 0, maxSearchPages: 5 });
    const walked = await reader.walkThread("thread-1", { maxPages: 5 });

    expect(requests.map((request) => request.before ?? null)).toEqual([
      null,
      all[105]!.messageId,
      all[5]!.messageId,
    ]);
    expect(walked.messages).toHaveLength(205);
    expect(walked.messages[0]!.content).toBe("message 1");
    expect(walked.messages.at(-1)!.content).toBe("message 205");
    expect(walked.truncated).toBe(false);
  });

  it("passes around/before/after anchors to the same page source and preserves cards", async () => {
    const fetchMessagePage = vi.fn(async (_threadId: string, request: MessagePageRequest) => [
      message(3, "Status panel", {
        authorId: "bot-1",
        authorName: "seam-acp",
        authorType: "bot",
        hasEmbeds: true,
      }),
      message(2, "answer", { authorId: "bot-1", authorName: "seam-acp", authorType: "bot" }),
      message(1, "question"),
    ].slice(0, request.limit));
    const reader = new MessageReader({ fetchMessagePage }, { interPageDelayMs: 0 });
    const result = await reader.readMessages("thread-1", { around: "hit-1", limit: 3 });

    expect(fetchMessagePage).toHaveBeenCalledWith("thread-1", { around: "hit-1", limit: 3 });
    expect(result.messages.map((item) => item.content)).toEqual(["question", "answer", "Status panel"]);
    expect(result.messages.at(-1)?.isCard).toBe(true);
  });

  it("honors Discord retry-after without advancing the cursor", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMessagePage = vi
      .fn<(_: string, __: MessagePageRequest) => Promise<MessagePageItem[]>>()
      .mockRejectedValueOnce({ status: 429, data: { retry_after: 0.25 } })
      .mockResolvedValueOnce([message(1, "ok")]);
    const reader = new MessageReader(
      { fetchMessagePage },
      { sleep, interPageDelayMs: 0, maxRateLimitRetries: 2 }
    );

    const result = await reader.readMessages("thread-1", { limit: 1 });
    expect(result.messages[0]?.content).toBe("ok");
    expect(fetchMessagePage).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("pages backward without skipping the middle and stops at the synthesized since boundary", async () => {
    const requests: MessagePageRequest[] = [];
    const all = Array.from({ length: 205 }, (_, index) => {
      const timestampMs = BASE + (index + 1) * 1_000;
      return message(index + 1, `message ${index + 1}`, {
        messageId: timestampToSnowflake(timestampMs),
        timestampMs,
      });
    });
    const source: MessagePageSource = {
      fetchMessagePage: async (_threadId, request) => {
        requests.push(request);
        const before = request.before ? BigInt(request.before) : undefined;
        return all
          .filter((item) => before === undefined || BigInt(item.messageId) < before)
          .slice(-request.limit)
          .reverse();
      },
    };
    const sinceMs = BASE + 105_000;
    const reader = new MessageReader(source, { interPageDelayMs: 0 });
    const walked = await reader.walkThread("thread-1", { sinceMs, maxPages: 5 });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({ limit: 100 });
    expect(requests[1]?.before).toBe(all[105]!.messageId);
    expect(walked.messages).toHaveLength(101);
    expect(walked.messages[0]?.content).toBe("message 105");
    expect(walked.messages.at(-1)?.content).toBe("message 205");
    expect(walked.truncated).toBe(false);
  });
});

describe("LiveMessageSearch", () => {
  it("excludes cards/noise and collapses consecutive streamed bot fragments", async () => {
    const rows = [
      message(1, "where is the launch phrase?"),
      message(2, "launch phrase begins", { authorId: "bot", authorName: "Seam", authorType: "bot" }),
      message(3, "Status", {
        authorId: "bot",
        authorName: "Seam",
        authorType: "bot",
        hasEmbeds: true,
      }),
      message(4, "and finishes here", { authorId: "bot", authorName: "Seam", authorType: "bot" }),
      message(5, "_▶ handoff · thread 1 → launch phrase_", {
        authorId: "bot",
        authorName: "Seam",
        authorType: "bot",
      }),
    ];
    const reader = new MessageReader(
      { fetchMessagePage: async () => [...rows].reverse() },
      { interPageDelayMs: 0 }
    );
    const search = new LiveMessageSearch(reader);
    const result = await search.search({
      query: "launch phrase",
      threads: [{ id: "thread-1", name: "Alpha" }],
    });

    expect(result.hits).toHaveLength(2);
    const botHit = result.hits.find((hit) => hit.authorType === "bot")!;
    expect(botHit.messageId).toBe(rows[1]!.messageId);
    expect(botHit.snippet).toContain("and finishes here");
    expect(result.hits.some((hit) => hit.snippet.includes("handoff"))).toBe(false);
  });

  it("applies author and since filters without excluding valid neighboring messages", async () => {
    const rows = [
      message(1, "needle old", { timestampMs: BASE - 60_000 }),
      message(2, "needle human", { authorId: "human-2", authorName: "Alex" }),
      message(3, "needle bot", { authorId: "bot", authorName: "Seam", authorType: "bot" }),
    ];
    const reader = new MessageReader(
      { fetchMessagePage: async () => [...rows].reverse() },
      { interPageDelayMs: 0 }
    );
    const search = new LiveMessageSearch(reader);

    const human = await search.search({
      query: "needle",
      threads: [{ id: "thread-1", name: null }],
      author: "human-2",
      sinceMs: BASE,
    });
    expect(human.hits.map((hit) => hit.snippet)).toEqual(["needle human"]);

    const bot = await search.search({
      query: "needle",
      threads: [{ id: "thread-1", name: null }],
      author: "bot",
      sinceMs: BASE,
    });
    expect(bot.hits.map((hit) => hit.snippet)).toEqual(["needle bot"]);
  });

  it("surfaces page-cap and hit-limit truncation", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => message(index + 1, "needle"));
    const reader = new MessageReader(
      { fetchMessagePage: async () => fullPage },
      { interPageDelayMs: 0, maxSearchPages: 1 }
    );
    const result = await new LiveMessageSearch(reader).search({
      query: "needle",
      threads: [{ id: "thread-1", name: null }],
      limit: 2,
    });
    expect(result.hits).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.pagesFetched).toBe(1);
  });
});

describe("message search helpers", () => {
  it("parses ISO and relative since values", () => {
    const now = Date.UTC(2026, 7, 10);
    expect(parseSince("2h", now)).toBe(now - 2 * 3_600_000);
    expect(parseSince("last 7 days", now)).toBe(now - 7 * 86_400_000);
    expect(parseSince("2026-08-01T00:00:00.000Z", now)).toBe(BASE);
  });

  it("uses one card/noise predicate for embed, component, and pure status rows", () => {
    expect(isMessageCardOrNoise(message(1, "human embed", { hasEmbeds: true }))).toBe(false);
    expect(isMessageCardOrNoise(message(2, "rankings", {
      authorId: "bot", authorName: "Seam", authorType: "bot", hasEmbeds: true,
    }))).toBe(true);
    expect(isMessageCardOrNoise(message(3, "_starting…_", {
      authorId: "bot", authorName: "Seam", authorType: "bot",
    }))).toBe(true);
    expect(isMessageCardOrNoise(message(4, "_⌚ wake fired_", {
      authorId: "bot", authorName: "Seam", authorType: "bot",
    }))).toBe(true);
    expect(isMessageCardOrNoise(message(5, "_⌚ watch fired_", {
      authorId: "bot", authorName: "Seam", authorType: "bot",
    }))).toBe(true);
    expect(isMessageCardOrNoise(message(6, "_🗜 compact started_", {
      authorId: "bot", authorName: "Seam", authorType: "bot",
    }))).toBe(true);
    expect(isMessageCardOrNoise(message(7, "Getting ready to continue", {
      authorId: "bot", authorName: "Seam", authorType: "bot", hasEmbeds: true,
    }))).toBe(true);
    expect(isMessageCardOrNoise(message(8, "Rebuild complete", {
      authorId: "bot", authorName: "Seam", authorType: "bot", hasEmbeds: true,
    }))).toBe(true);
  });
});
