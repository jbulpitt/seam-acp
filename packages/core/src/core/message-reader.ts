/**
 * Platform-neutral live message reading and text search (#143).
 *
 * The reader owns cursor pagination, retry-after handling, ordering, and the
 * shared read shape used by `read_messages` and `peek`. Discord is only a page
 * source. `LiveMessageSearch` is deliberately behind `MessageSearchBackend` so
 * a future FTS implementation can replace the live walk without changing MCP.
 */

export type MessageAuthorType = "human" | "bot";

export interface MessagePageItem {
  messageId: string;
  timestampMs: number;
  authorId: string;
  authorName: string;
  authorType: MessageAuthorType;
  content: string;
  attachmentNames: string[];
  hasEmbeds: boolean;
  hasComponents: boolean;
}

export interface MessagePageRequest {
  limit: number;
  around?: string;
  before?: string;
  after?: string;
}

/**
 * One transport page: the content-eligible messages PLUS the raw facts about
 * the page they came from (#278).
 *
 * Transport pagination and content filtering are different concerns and must
 * not be inferred from one another. A source drops ineligible rows (Discord
 * join/pin/thread-started system messages), so the eligible array says nothing
 * about whether the platform has more history or where the next cursor is: a
 * full raw page of 100 containing one system post yields 99 eligible rows, and
 * a raw page consisting entirely of system posts yields none at all. Both are
 * mid-history pages. The raw fields below are the only exhaustion and cursor
 * authority; `messages` is only what the caller is allowed to read.
 */
export interface MessagePage {
  /** Eligible, normalized messages. May be empty on a full raw page. */
  messages: MessagePageItem[];
  /** Rows the platform returned before any content filtering. */
  rawCount: number;
  /** Oldest RAW row's id — the next `before` cursor. Null iff `rawCount` is 0. */
  oldestRawId: string | null;
  /** Oldest RAW row's timestamp, for since-boundary decisions. Null iff empty. */
  oldestRawTimestampMs: number | null;
}

export interface MessagePageSource {
  fetchMessagePage(threadId: string, request: MessagePageRequest): Promise<MessagePage>;
}

export interface ReadMessagesInput {
  around?: string;
  before?: string;
  after?: string;
  limit?: number;
}

export interface ReadMessage {
  messageId: string;
  timestamp: string;
  author: string;
  authorId: string;
  authorType: MessageAuthorType;
  content: string;
  isCard: boolean;
  attachments: string[];
}

export interface ReadMessagesResult {
  threadId: string;
  messages: ReadMessage[];
  truncated: boolean;
}

export interface SearchThread {
  id: string;
  name: string | null;
}

export interface SearchMessagesInput {
  query: string;
  threads: SearchThread[];
  author?: string;
  sinceMs?: number;
  limit?: number;
}

export interface SearchMessageHit {
  threadId: string;
  threadName: string | null;
  messageId: string;
  timestamp: string;
  author: string;
  authorId: string;
  authorType: MessageAuthorType;
  snippet: string;
}

export interface SearchMessagesResult {
  query: string;
  hits: SearchMessageHit[];
  truncated: boolean;
  pagesFetched: number;
}

export interface MessageSearchBackend {
  search(input: SearchMessagesInput): Promise<SearchMessagesResult>;
}

export interface MessageReaderOptions {
  /** Polite delay between page requests. Production default follows #143's measurement. */
  interPageDelayMs?: number;
  /** Total pages a single search may walk across all target threads. */
  maxSearchPages?: number;
  /** Maximum retries for a single Discord 429 response. */
  maxRateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    warn: (obj: unknown, msg?: string) => void;
  };
}

const DISCORD_EPOCH_MS = 1_420_070_400_000;
const PAGE_SIZE = 100;
const DEFAULT_INTER_PAGE_DELAY_MS = 180;
const DEFAULT_MAX_SEARCH_PAGES = 50;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_READ_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_HITS = 100;
const SNIPPET_LENGTH = 280;

/** Convert a wall-clock boundary to the smallest Discord snowflake at that ms. */
export function timestampToSnowflake(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) throw new Error("since must be a valid timestamp");
  const elapsed = BigInt(Math.max(0, Math.floor(timestampMs - DISCORD_EPOCH_MS)));
  return (elapsed << 22n).toString();
}

/** ISO timestamp or a compact relative window such as `30m`, `2 hours`, `7d`. */
export function parseSince(value: string, nowMs = Date.now()): number {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("since must not be empty");
  const relative = trimmed.match(
    /^(?:last\s+)?(\d+(?:\.\d+)?)\s*(s|sec(?:ond)?s?|m|min(?:ute)?s?|h|hours?|d|days?|w|weeks?)(?:\s+ago)?$/i
  );
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const multiplier = unit.startsWith("s")
      ? 1_000
      : unit.startsWith("m")
        ? 60_000
        : unit.startsWith("h")
          ? 3_600_000
          : unit.startsWith("d")
            ? 86_400_000
            : 604_800_000;
    return nowMs - amount * multiplier;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error("since must be an ISO timestamp or relative window such as 30m, 2h, or 7d");
  }
  return parsed;
}

/**
 * One centralized UI/noise classifier. Read results expose it as `isCard`;
 * search uses the same result as an exclusion fence.
 */
export function isMessageCardOrNoise(message: MessagePageItem): boolean {
  if (message.authorType !== "bot") return false;
  if (message.hasEmbeds || message.hasComponents) return true;
  const text = message.content.trim();
  if (!text) return false;
  return (
    /^_?starting…?_?$/iu.test(text) ||
    /^_?(?:▶|✅|❌|⌚|🗜)\s+(?:handoff|forward|chain|report-back|wake fired|watch fired|peek|compact|scheduled|parked prompt|choice|ingest|self migration)\b[^\n]*_?$/iu.test(text) ||
    /(?:wake fired|watch fired)/iu.test(text) ||
    /^_?(?:✅\s+Done|❌\s+Failed)(?:\s+[—-].*)?_?$/iu.test(text)
  );
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`limit must be an integer from ${min} to ${max}`);
  }
  return value;
}

function ordered(items: readonly MessagePageItem[]): MessagePageItem[] {
  return [...items].sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    if (/^\d+$/.test(a.messageId) && /^\d+$/.test(b.messageId)) {
      const ai = BigInt(a.messageId);
      const bi = BigInt(b.messageId);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    }
    return a.messageId.localeCompare(b.messageId);
  });
}

function retryAfterMs(error: unknown): number | undefined {
  const e = error as {
    status?: number;
    code?: number;
    retryAfter?: number;
    retry_after?: number;
    data?: { retry_after?: number };
    rawError?: { retry_after?: number };
    response?: { status?: number; headers?: { get?: (name: string) => string | null } };
  };
  const status = e?.status ?? e?.response?.status ?? e?.code;
  if (status !== 429) return undefined;
  const raw = e.retryAfter ?? e.retry_after ?? e.data?.retry_after ?? e.rawError?.retry_after;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    // Discord JSON uses seconds; discord.js' retryAfter property uses ms.
    return e.retryAfter === raw ? raw : raw * 1_000;
  }
  const header = e.response?.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  }
  return 1_000;
}

function readContent(message: MessagePageItem): string {
  const content = message.content.trim();
  if (message.attachmentNames.length === 0) return content;
  const suffix = `[Attachments: ${message.attachmentNames.join(", ")}]`;
  return content ? `${content} ${suffix}` : suffix;
}

export class MessageReader {
  private readonly interPageDelayMs: number;
  readonly maxSearchPages: number;
  private readonly maxRateLimitRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger?: MessageReaderOptions["logger"];

  constructor(private readonly source: MessagePageSource, options: MessageReaderOptions = {}) {
    this.interPageDelayMs = options.interPageDelayMs ?? DEFAULT_INTER_PAGE_DELAY_MS;
    this.maxSearchPages = options.maxSearchPages ?? DEFAULT_MAX_SEARCH_PAGES;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger;
  }

  async readMessages(threadId: string, input: ReadMessagesInput = {}): Promise<ReadMessagesResult> {
    const anchors = [input.around, input.before, input.after].filter(Boolean);
    if (anchors.length > 1) throw new Error("read_messages accepts only one of around, before, or after");
    const limit = boundedInteger(input.limit, DEFAULT_READ_LIMIT, 1, PAGE_SIZE);
    const page = await this.fetchWithBackoff(threadId, {
      limit,
      ...(input.around ? { around: input.around } : {}),
      ...(input.before ? { before: input.before } : {}),
      ...(input.after ? { after: input.after } : {}),
    });
    // A bounded anchored read returns exactly this page's eligible rows; it has
    // never promised the whole thread, so raw-page metadata is not consulted
    // here and around/before/after semantics are unchanged.
    const messages = ordered(page.messages).map((message): ReadMessage => ({
      messageId: message.messageId,
      timestamp: new Date(message.timestampMs).toISOString(),
      author: message.authorName,
      authorId: message.authorId,
      authorType: message.authorType,
      content: readContent(message),
      isCard: isMessageCardOrNoise(message),
      attachments: [...message.attachmentNames],
    }));
    return { threadId, messages, truncated: false };
  }

  /**
   * Walk one thread to exhaustion (or to the caller's page budget).
   *
   * `truncated` means the walk did NOT establish that it reached the start of
   * the thread — a caller that needs complete history must fail closed rather
   * than treat the result as the whole conversation. `truncatedReason` says
   * which bound stopped it, so operator-facing messages stay accurate.
   */
  async walkThread(
    threadId: string,
    input: { sinceMs?: number; maxPages: number }
  ): Promise<{
    messages: MessagePageItem[];
    pagesFetched: number;
    truncated: boolean;
    truncatedReason?: "page-cap" | "cursor-stalled";
  }> {
    const seen = new Set<string>();
    /** Every cursor already requested, so a repeating source cannot loop. */
    const cursors = new Set<string>();
    const messages: MessagePageItem[] = [];
    let pagesFetched = 0;
    let truncated = false;
    let truncatedReason: "page-cap" | "cursor-stalled" | undefined;
    let exhausted = false;
    let before: string | undefined;
    const sinceSnowflake = input.sinceMs === undefined
      ? undefined
      : timestampToSnowflake(input.sinceMs);

    while (pagesFetched < input.maxPages) {
      const page = await this.fetchWithBackoff(threadId, {
        limit: PAGE_SIZE,
        ...(before ? { before } : {}),
      });
      pagesFetched += 1;
      for (const message of page.messages) {
        if (seen.has(message.messageId)) continue;
        seen.add(message.messageId);
        if (input.sinceMs === undefined || message.timestampMs >= input.sinceMs) messages.push(message);
      }

      // Exhaustion is a RAW fact. Judging it by the eligible rows made one
      // filtered system post in a full page look like the end of the thread
      // and silently stopped Rebuild at 99 posts (#278). A page that is
      // ENTIRELY filtered is likewise mid-history, not the end — so this must
      // not be relaxed to `rawCount === 0` either; only the platform returning
      // fewer raw rows than requested ends the walk.
      if (page.rawCount < PAGE_SIZE) {
        exhausted = true;
        break;
      }

      // Discord returns every page newest→oldest, including `after` pages, and
      // cursor parameters are mutually exclusive. Walking forward with `after`
      // can therefore return the newest 100 and skip the middle. Page backward
      // and stop once the oldest RAW row crosses the synthesized since
      // snowflake — the oldest ELIGIBLE row can sit arbitrarily far newer than
      // the page it came from.
      if (
        sinceSnowflake &&
        ((page.oldestRawId !== null &&
          /^\d+$/.test(page.oldestRawId) &&
          BigInt(page.oldestRawId) <= BigInt(sinceSnowflake)) ||
          (input.sinceMs !== undefined &&
            page.oldestRawTimestampMs !== null &&
            page.oldestRawTimestampMs <= input.sinceMs))
      ) {
        exhausted = true;
        break;
      }

      // The next cursor comes from the raw page too, so an all-filtered page
      // still advances. No cursor, or one already walked, means the source is
      // not making progress: stop and say so rather than spinning to the cap.
      const nextBefore = page.oldestRawId;
      if (nextBefore === null || nextBefore === before || cursors.has(nextBefore)) {
        truncated = true;
        truncatedReason = "cursor-stalled";
        this.logger?.warn(
          { threadId, pagesFetched, cursor: nextBefore },
          "message walk cursor did not advance; results truncated"
        );
        break;
      }
      cursors.add(nextBefore);
      before = nextBefore;
      if (pagesFetched < input.maxPages && this.interPageDelayMs > 0) {
        await this.sleep(this.interPageDelayMs);
      }
    }

    if (!exhausted && !truncated && pagesFetched >= input.maxPages) {
      truncated = true;
      truncatedReason = "page-cap";
      this.logger?.warn(
        { threadId, pagesFetched, maxPages: input.maxPages },
        "message search page cap reached; results truncated"
      );
    }
    return {
      messages: ordered(messages),
      pagesFetched,
      truncated,
      ...(truncatedReason ? { truncatedReason } : {}),
    };
  }

  private async fetchWithBackoff(
    threadId: string,
    request: MessagePageRequest
  ): Promise<MessagePage> {
    let retries = 0;
    while (true) {
      try {
        return await this.source.fetchMessagePage(threadId, request);
      } catch (error) {
        const delay = retryAfterMs(error);
        if (delay === undefined || retries >= this.maxRateLimitRetries) throw error;
        retries += 1;
        this.logger?.warn(
          { threadId, retryAfterMs: delay, retry: retries },
          "message fetch rate limited; retrying after Discord retry-after"
        );
        await this.sleep(delay);
      }
    }
  }
}

interface LogicalMessage extends MessagePageItem {
  content: string;
}

function collapseBotFragments(messages: readonly MessagePageItem[]): LogicalMessage[] {
  const logical: LogicalMessage[] = [];
  for (const message of ordered(messages)) {
    if (isMessageCardOrNoise(message)) continue;
    const content = readContent(message);
    const previous = logical[logical.length - 1];
    if (
      previous &&
      previous.authorType === "bot" &&
      message.authorType === "bot" &&
      previous.authorId === message.authorId
    ) {
      previous.content = [previous.content, content].filter(Boolean).join("\n\n");
      continue;
    }
    logical.push({ ...message, content });
  }
  return logical;
}

function snippetFor(content: string, query: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (oneLine.length <= SNIPPET_LENGTH) return oneLine;
  const index = oneLine.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, Math.min(index < 0 ? 0 : index - 80, oneLine.length - SNIPPET_LENGTH));
  const body = oneLine.slice(start, start + SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${body}${start + SNIPPET_LENGTH < oneLine.length ? "…" : ""}`;
}

export class LiveMessageSearch implements MessageSearchBackend {
  constructor(private readonly reader: MessageReader) {}

  async search(input: SearchMessagesInput): Promise<SearchMessagesResult> {
    const query = input.query.trim();
    if (!query) throw new Error("query must not be empty");
    const limit = boundedInteger(input.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_HITS);
    let remainingPages = this.reader.maxSearchPages;
    let pagesFetched = 0;
    let truncated = false;
    const hits: SearchMessageHit[] = [];

    for (const thread of input.threads) {
      if (remainingPages <= 0) {
        truncated = true;
        break;
      }
      const walked = await this.reader.walkThread(thread.id, {
        ...(input.sinceMs === undefined ? {} : { sinceMs: input.sinceMs }),
        maxPages: remainingPages,
      });
      pagesFetched += walked.pagesFetched;
      remainingPages -= walked.pagesFetched;
      truncated ||= walked.truncated;
      for (const message of collapseBotFragments(walked.messages)) {
        if (input.author === "human" && message.authorType !== "human") continue;
        if (input.author === "bot" && message.authorType !== "bot") continue;
        if (input.author && input.author !== "human" && input.author !== "bot" && message.authorId !== input.author) continue;
        if (!message.content.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
        hits.push({
          threadId: thread.id,
          threadName: thread.name,
          messageId: message.messageId,
          timestamp: new Date(message.timestampMs).toISOString(),
          author: message.authorName,
          authorId: message.authorId,
          authorType: message.authorType,
          snippet: snippetFor(message.content, query),
        });
      }
    }

    hits.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.messageId.localeCompare(a.messageId));
    if (hits.length > limit) truncated = true;
    return { query, hits: hits.slice(0, limit), truncated, pagesFetched };
  }
}
