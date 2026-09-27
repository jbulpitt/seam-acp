/**
 * A separate bot that agents drive as a person in a test deployment. It never
 * joins the gateway: it posts and reads over REST, and only in allowlisted
 * parent channels and the threads under them, so it cannot reach anything else.
 */

const API = "https://discord.com/api/v10";
const MAX_CONTENT = 2000;

export interface TesterMessage {
  id: string;
  author: string;
  authorIsBot: boolean;
  content: string;
  embeds: string[];
  attachments: string[];
  timestamp: string;
}

interface RawMessage {
  id: string;
  author: { username: string; bot?: boolean };
  content: string;
  embeds?: Array<{ title?: string; description?: string; fields?: Array<{ name: string; value: string }> }>;
  attachments?: Array<{ filename: string }>;
  timestamp: string;
}

export class TesterBot {
  constructor(
    private readonly token: string,
    private readonly channels: ReadonlySet<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Discord ${method} ${path} returned ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** An allowlisted parent channel, or a thread whose parent is one. */
  private async allowed(channelId: string): Promise<{ isThread: boolean }> {
    if (this.channels.has(channelId)) return { isThread: false };
    const channel = await this.call<{ parent_id?: string | null }>("GET", `/channels/${channelId}`);
    if (channel.parent_id && this.channels.has(channel.parent_id)) return { isThread: true };
    throw new Error(`channel ${channelId} is not in SEAM_TEST_BOT_CHANNEL_IDS or a thread under one`);
  }

  /** Post a message, optionally starting a new thread in a parent channel first. */
  async post(input: { channel: string; text: string; threadName?: string }): Promise<{ threadId: string; messageId: string }> {
    if (!input.text.trim()) throw new Error("text is empty");
    if (input.text.length > MAX_CONTENT) throw new Error(`text is ${input.text.length} characters; Discord allows ${MAX_CONTENT}`);
    const { isThread } = await this.allowed(input.channel);
    let target = input.channel;
    if (input.threadName) {
      if (isThread) throw new Error("threadName starts a thread in a parent channel; this channel is already a thread");
      const thread = await this.call<{ id: string }>("POST", `/channels/${target}/threads`, {
        name: input.threadName.slice(0, 100),
        type: 11,
        auto_archive_duration: 10080,
      });
      target = thread.id;
    }
    const message = await this.call<{ id: string }>("POST", `/channels/${target}/messages`, { content: input.text });
    return { threadId: target, messageId: message.id };
  }

  /** Messages oldest first, after `after` when given, otherwise the most recent. */
  async read(input: { channel: string; after?: string; limit?: number }): Promise<TesterMessage[]> {
    await this.allowed(input.channel);
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const query = new URLSearchParams({ limit: String(limit), ...(input.after ? { after: input.after } : {}) });
    const raw = await this.call<RawMessage[]>("GET", `/channels/${input.channel}/messages?${query}`);
    return raw
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .map((m) => ({
        id: m.id,
        author: m.author.username,
        authorIsBot: m.author.bot === true,
        content: m.content,
        embeds: (m.embeds ?? []).map((e) =>
          [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join("\n")),
        attachments: (m.attachments ?? []).map((a) => a.filename),
        timestamp: m.timestamp,
      }));
  }
}
