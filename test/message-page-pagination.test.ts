/**
 * #278 — filtered Discord pages must not be mistaken for end-of-history.
 *
 * These are deliberately ADAPTER-TO-READER tests: the defect lived in the seam
 * between `DiscordAdapter.fetchMessagePage` (which filters system rows) and
 * `MessageReader.walkThread` (which decided exhaustion and the next cursor from
 * those filtered rows). Existing suites mock one side or the other and so
 * cannot see it — `test/message-reader.test.ts` feeds the reader pre-normalized
 * pages, and `test/discord-message-page.test.ts` only checks normalization.
 *
 * The real compiled adapter runs here via `Object.create`; only the channel
 * lookup is stubbed, so the same filtering production performs is exercised.
 */
import { MessageType } from "discord.js";
import { describe, expect, it } from "vitest";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import {
  LiveMessageSearch,
  MessageReader,
  timestampToSnowflake,
  type MessagePageSource,
} from "../packages/core/src/core/message-reader.js";

const BASE = Date.UTC(2026, 8, 1);
const OLDEST_SENTINEL = "OLDEST_SENTINEL";

interface RawOverrides {
  type?: number;
  bot?: boolean;
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  snowflakeIds?: boolean;
}

type RawMessage = ReturnType<typeof raw>;

/** One synthetic Discord REST row, in the shape the adapter reads. */
function raw(id: number, over: RawOverrides = {}) {
  const createdTimestamp = BASE + id * 1_000;
  return {
    id: over.snowflakeIds ? timestampToSnowflake(createdTimestamp) : String(id).padStart(18, "0"),
    ordinal: id,
    type: over.type ?? MessageType.Default,
    createdTimestamp,
    author: {
      id: over.bot ? "bot-1" : "human-1",
      bot: over.bot ?? false,
      username: over.bot ? "seam" : "jesse",
      globalName: over.bot ? "Seam" : "Jesse",
    },
    member: over.bot ? null : { displayName: "Jesse" },
    content: over.content ?? `post ${id}`,
    attachments: { map: <T,>(fn: (a: { name: string }) => T): T[] => [] },
    embeds: over.embeds ?? [],
    components: over.components ?? [],
  };
}

/**
 * 250 posts, ids 1..250 oldest→newest. The oldest carries the sentinel that
 * must survive all the way to search and reconstruction input.
 */
function thread(
  excluded: readonly number[] = [],
  options: { count?: number; snowflakeIds?: boolean } = {}
): RawMessage[] {
  const count = options.count ?? 250;
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return raw(id, {
      ...(excluded.includes(id) ? { type: MessageType.ChannelPinnedMessage } : {}),
      ...(options.snowflakeIds ? { snowflakeIds: true } : {}),
      content: id === 1 ? `${OLDEST_SENTINEL} first question` : `post ${id}`,
    });
  });
}

/**
 * The real adapter over a synthetic REST source. `stall` reproduces a platform
 * that keeps answering with the same newest page no matter what cursor it is
 * given — the walk must notice rather than spin to its cap.
 */
function makeAdapter(all: readonly RawMessage[], options: { stall?: boolean } = {}) {
  const requests: Array<{ limit: number; before?: string; after?: string; around?: string }> = [];
  const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  (adapter as unknown as { config: unknown }).config = { DISCORD_USER_NAMES: new Map() };
  (adapter as unknown as { fetchSendableChannel: unknown }).fetchSendableChannel = async () => ({
    isThread: () => true,
    messages: {
      fetch: async (opts: { limit: number; before?: string }) => {
        requests.push(opts);
        const before = opts.before && !options.stall ? opts.before : undefined;
        const rows = [...all]
          // Discord serves every page newest→oldest.
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
          .filter((message) => before === undefined || BigInt(message.id) < BigInt(before))
          .slice(0, opts.limit);
        return new Map(rows.map((message) => [message.id, message]));
      },
    },
  });
  const source: MessagePageSource = {
    fetchMessagePage: (threadId, request) => adapter.fetchMessagePage(threadId, request),
  };
  return { adapter, source, requests };
}

function walker(source: MessagePageSource, options: { maxSearchPages?: number } = {}) {
  return new MessageReader(source, { interPageDelayMs: 0, ...options });
}

describe("#278 raw-page pagination survives content filtering", () => {
  it("reaches the oldest post when every row is ordinary (control)", async () => {
    const { source, requests } = makeAdapter(thread());
    const walked = await walker(source).walkThread("thread-1", { maxPages: 500 });

    expect(walked.messages).toHaveLength(250);
    expect(walked.pagesFetched).toBe(3);
    expect(walked.truncated).toBe(false);
    expect(walked.messages[0]!.content).toContain(OLDEST_SENTINEL);
    expect(walked.messages.at(-1)!.content).toBe("post 250");
    expect(requests[0]).toEqual({ limit: 100 });
  });

  it("does not mistake ONE filtered row in a full raw page for the end of the thread", async () => {
    // The reported production symptom: 100 raw rows minus one system post read
    // as 99, which the old walker accepted as exhaustion and stopped.
    const { source } = makeAdapter(thread([225]));
    const walked = await walker(source).walkThread("thread-1", { maxPages: 500 });

    expect(walked.messages).toHaveLength(249);
    expect(walked.pagesFetched).toBe(3);
    expect(walked.truncated).toBe(false);
    expect(walked.messages[0]!.content).toContain(OLDEST_SENTINEL);
    expect(walked.messages.some((message) => message.messageId === String(225).padStart(18, "0"))).toBe(false);
  });

  it("advances past a page whose OLDEST raw row is the filtered one", async () => {
    // The cursor must be the raw oldest id (151). Deriving it from the eligible
    // rows would re-request row 151 forever, or skip it silently.
    const { source, requests } = makeAdapter(thread([151]));
    const walked = await walker(source).walkThread("thread-1", { maxPages: 500 });

    expect(walked.messages).toHaveLength(249);
    expect(walked.truncated).toBe(false);
    expect(requests[1]!.before).toBe(String(151).padStart(18, "0"));
    expect(walked.messages[0]!.content).toContain(OLDEST_SENTINEL);
  });

  it("continues past a filtered row on a LATER page", async () => {
    const { source } = makeAdapter(thread([125]));
    const walked = await walker(source).walkThread("thread-1", { maxPages: 500 });

    expect(walked.messages).toHaveLength(249);
    expect(walked.pagesFetched).toBe(3);
    expect(walked.truncated).toBe(false);
    expect(walked.messages[0]!.content).toContain(OLDEST_SENTINEL);
  });

  it("continues past an ENTIRELY filtered raw page", async () => {
    // Relaxing the old check from `< 100` to `=== 0` would still stop here, and
    // would have no cursor to continue with.
    const excluded = Array.from({ length: 100 }, (_, index) => 151 + index);
    const { source } = makeAdapter(thread(excluded));
    const walked = await walker(source).walkThread("thread-1", { maxPages: 500 });

    expect(walked.messages).toHaveLength(150);
    expect(walked.pagesFetched).toBe(3);
    expect(walked.truncated).toBe(false);
    expect(walked.messages[0]!.content).toContain(OLDEST_SENTINEL);
    expect(walked.messages.at(-1)!.content).toBe("post 150");
  });

  it("treats a genuinely short raw page as the end, without truncation", async () => {
    const { source } = makeAdapter(thread([], { count: 150 }));
    const walked = await walker(source).walkThread("thread-1", { maxPages: 500 });

    expect(walked.messages).toHaveLength(150);
    expect(walked.pagesFetched).toBe(2);
    expect(walked.truncated).toBe(false);
  });

  it("treats an EMPTY terminal raw page as the end, without truncation", async () => {
    // Exactly two full pages: the third request returns nothing at all.
    const { source, requests } = makeAdapter(thread([], { count: 200 }));
    const walked = await walker(source).walkThread("thread-1", { maxPages: 500 });

    expect(walked.messages).toHaveLength(200);
    expect(walked.pagesFetched).toBe(3);
    expect(requests).toHaveLength(3);
    expect(walked.truncated).toBe(false);
    expect(walked.messages[0]!.content).toContain(OLDEST_SENTINEL);
  });

  it("stops and reports truncation when the cursor stops advancing", async () => {
    const { source, requests } = makeAdapter(thread(), { stall: true });
    const walked = await walker(source).walkThread("thread-1", { maxPages: 500 });

    expect(walked.truncated).toBe(true);
    expect(walked.truncatedReason).toBe("cursor-stalled");
    // Two pages is enough to prove non-progress; it must not spin to the cap.
    expect(requests).toHaveLength(2);
    expect(walked.messages).toHaveLength(100);
  });

  it("reports page-cap truncation distinctly from a stalled cursor", async () => {
    const { source } = makeAdapter(thread());
    const walked = await walker(source).walkThread("thread-1", { maxPages: 2 });

    expect(walked.truncated).toBe(true);
    expect(walked.truncatedReason).toBe("page-cap");
    expect(walked.pagesFetched).toBe(2);
    expect(walked.messages).toHaveLength(200);
  });

  it("honors the since boundary using raw rows, even when the boundary page is filtered", async () => {
    const excluded = Array.from({ length: 20 }, (_, index) => 101 + index);
    const { source, requests } = makeAdapter(thread(excluded, { snowflakeIds: true }));
    const sinceMs = BASE + 150_000;
    const walked = await walker(source).walkThread("thread-1", { sinceMs, maxPages: 500 });

    // The first raw page spans 151..250, so the boundary is reached on page 2
    // and nothing older than it is requested.
    expect(requests).toHaveLength(2);
    expect(walked.truncated).toBe(false);
    expect(walked.messages.every((message) => message.timestampMs >= sinceMs)).toBe(true);
    expect(walked.messages[0]!.content).toBe("post 150");
    expect(walked.messages.at(-1)!.content).toBe("post 250");
  });

  it("de-duplicates rows a source repeats across pages", async () => {
    const all = thread();
    const { source } = makeAdapter(all);
    const seenSource: MessagePageSource = {
      fetchMessagePage: async (threadId, request) => {
        const page = await source.fetchMessagePage(threadId, request);
        // Echo the newest row into every page, as an overlapping cursor would.
        return { ...page, messages: [...page.messages, page.messages[0]!].filter(Boolean) };
      },
    };
    const walked = await walker(seenSource).walkThread("thread-1", { maxPages: 500 });

    expect(walked.messages).toHaveLength(250);
    expect(new Set(walked.messages.map((message) => message.messageId)).size).toBe(250);
  });

  it("keeps results chronological across every page", async () => {
    const { source } = makeAdapter(thread([225, 125]));
    const walked = await walker(source).walkThread("thread-1", { maxPages: 500 });

    const timestamps = walked.messages.map((message) => message.timestampMs);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it("leaves anchored read semantics untouched", async () => {
    const { adapter, requests } = makeAdapter(thread());
    const reader = walker({
      fetchMessagePage: (threadId, request) => adapter.fetchMessagePage(threadId, request),
    });

    const around = await reader.readMessages("thread-1", { around: "hit-1", limit: 5 });
    expect(requests.at(-1)).toEqual({ around: "hit-1", limit: 5 });
    expect(around.messages).toHaveLength(5);
    expect(around.truncated).toBe(false);

    const before = await reader.readMessages("thread-1", {
      before: String(10).padStart(18, "0"),
      limit: 3,
    });
    expect(requests.at(-1)).toEqual({ before: String(10).padStart(18, "0"), limit: 3 });
    expect(before.messages.map((message) => message.content)).toEqual(["post 7", "post 8", "post 9"]);
  });
});

describe("#278 live search reaches the oldest post", () => {
  it("finds the oldest sentinel behind a filtered page", async () => {
    const excluded = Array.from({ length: 100 }, (_, index) => 151 + index);
    const { source } = makeAdapter(thread(excluded));
    const search = new LiveMessageSearch(walker(source));

    const result = await search.search({
      query: OLDEST_SENTINEL,
      threads: [{ id: "thread-1", name: "Alpha" }],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.snippet).toContain(OLDEST_SENTINEL);
    expect(result.truncated).toBe(false);
  });

  it("finds the oldest sentinel when a single system row shortens a page", async () => {
    const { source } = makeAdapter(thread([225]));
    const search = new LiveMessageSearch(walker(source));

    const result = await search.search({
      query: OLDEST_SENTINEL,
      threads: [{ id: "thread-1", name: null }],
    });

    expect(result.hits.map((hit) => hit.snippet.includes(OLDEST_SENTINEL))).toEqual([true]);
    expect(result.truncated).toBe(false);
  });

  it("still excludes status cards and system rows from what it returns", async () => {
    const all: RawMessage[] = [
      raw(1, { content: `${OLDEST_SENTINEL} needle opening` }),
      raw(2, {
        bot: true,
        content: "",
        embeds: [{ title: "needle", description: "status card", fields: [], footer: null, author: null }],
        components: [{}],
      }),
      raw(3, { type: MessageType.UserJoin, content: "needle joined" }),
      raw(4, { content: "needle closing" }),
    ];
    const { source } = makeAdapter(all);
    const reader = walker(source);

    const result = await new LiveMessageSearch(reader).search({
      query: "needle",
      threads: [{ id: "thread-1", name: null }],
    });
    // Hit ordering is search's own (newest first) and is not what this asserts:
    // the point is that only the two conversational rows are eligible.
    expect([...result.hits.map((hit) => hit.snippet)].sort()).toEqual([
      "OLDEST_SENTINEL needle opening",
      "needle closing",
    ]);

    // The card is filtered from search but still readable, flagged as a card;
    // the system row never reaches the reader at all.
    const read = await reader.readMessages("thread-1", { limit: 10 });
    expect(read.messages.map((message) => message.isCard)).toEqual([false, true, false]);
  });
});
