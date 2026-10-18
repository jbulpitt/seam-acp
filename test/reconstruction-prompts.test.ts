import { MessageType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import {
  assembleReconstruction, projectDiscordConversation, reconstructionBudgetTokens,
  renderLogicalMessage, selectOpeningExchanges, selectReconstructionRanges,
} from "../packages/core/src/core/reconstruction/index.js";

const SEAM = "1495915831878483978";
const epoch = 1_700_000_000_000;
type Card = { title: string; fields: { name: string; value: string }[]; description?: string };
type Row = ReturnType<typeof row>;

function row(id: number, content: string, card?: Card, human = false) {
  return {
    id: String(id), type: MessageType.Default, createdTimestamp: epoch + id * 20_000,
    author: { id: human ? "human" : SEAM, bot: !human, username: human ? "Alex" : "Seam" },
    member: null, content, attachments: { map: () => [] },
    embeds: card ? [card] : [], components: [],
  };
}

function prompt(id: number, kind = "📨 Handoff", text = `directive ${id}`) {
  return row(id, "", {
    title: `${kind} · Done`, fields: [
      { name: "Repo", value: "pronoa" }, { name: "Action", value: "end_turn" },
      { name: "From", value: "orchestrator · #development" }, { name: "Prompt", value: text },
    ], description: "tool activity is not the prompt",
  });
}

async function project(rows: Row[]) {
  const logger = { child: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.child.mockReturnValue(logger);
  const adapter = new DiscordAdapter({ config: {
    DISCORD_ALLOWED_USER_IDS: new Set(["human"]), DISCORD_USER_NAMES: new Map(),
  } as any, logger: logger as any });
  (adapter as any).fetchSendableChannel = vi.fn(async () => ({
    isThread: () => true, guildId: "guild", messages: { fetch: async () => new Map(rows.map(r => [r.id, r])) },
  }));
  const page = await adapter.fetchMessagePage("worker", { limit: 100 });
  return { posts: page.messages, messages: projectDiscordConversation(page.messages, { seamBotId: SEAM }) };
}

function exchanges(count: number, mixed = false): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const id = i * 3 + 1;
    return [mixed && i % 2 === 0 ? row(id, `human directive ${id}`, undefined, true) : prompt(id),
      row(id + 1, `answer ${id}`)];
  }).flat();
}

describe("Rebuild delivered prompt boundaries", () => {
  it.each(["📨 Handoff", "📤 Forward", "⏰ Wake", "📅 Scheduled", "🔗 Chain", "🔁 Report-back", "🌐 Ingest"])(
    "projects %s Prompt/From card fields as an honestly attributed prompt, not Human", async kind => {
      const { messages } = await project([prompt(1, kind), row(2, "answer")]);
      expect(messages.map(m => m.role)).toEqual(["prompt", "assistant"]);
      expect(messages[0]?.text).toBe("directive 1");
      const rendered = renderLogicalMessage(messages[0]!);
      expect(rendered).toContain("Prompt —");
      expect(rendered).toContain("orchestrator · #development");
      expect(rendered).toContain("excerpt");
      expect(rendered).not.toContain("Human");
      expect(rendered).not.toContain("end_turn");
      expect(rendered).not.toContain("tool activity");
    },
  );

  it("reads the existing simple dispatch-card provenance, without treating arbitrary prose as a prompt", async () => {
    const { messages } = await project([
      row(1, "", { title: "📤 Forward · Done", fields: [], description: "💬 preserve this excerpt\n↩ source thread" }),
      row(2, "ordinary assistant output says Prompt and Handoff"),
      row(3, "", { title: "Working", fields: [{ name: "Prompt", value: "not a dispatch card" }] }),
    ]);
    expect(messages.map(m => m.role)).toEqual(["prompt", "assistant"]);
    expect(messages[0]?.text).toBe("preserve this excerpt");
    expect(renderLogicalMessage(messages[0]!)).toContain("forward from source thread");
  });

  it("does not accept a foreign bot's dispatch-shaped card", async () => {
    const foreign = prompt(1);
    foreign.author.id = "other-bot";
    expect((await project([foreign])).messages).toEqual([]);
  });

  it("does not merge a response across an intervening delivered prompt", async () => {
    const rows = [prompt(1), row(2, "reply one"), prompt(3), row(4, "reply two")];
    rows.forEach((r, i) => { r.createdTimestamp = epoch + i * 100; });
    expect((await project(rows)).messages.map(m => [m.role, m.text])).toEqual([
      ["prompt", "directive 1"], ["assistant", "reply one"],
      ["prompt", "directive 3"], ["assistant", "reply two"],
    ]);
  });

  it("bounds a zero-human worker's opening at the tenth handoff response", async () => {
    const { posts, messages } = await project(exchanges(15));
    expect(posts.every(p => p.authorType === "bot")).toBe(true);
    const opening = selectOpeningExchanges(messages);
    expect(opening).toHaveLength(20);
    expect(opening.at(-1)?.text).toBe("answer 28");
    expect(opening.filter(m => m.role !== "assistant")).toHaveLength(10);
    expect(opening).not.toContain(messages[20]);
  });

  it.each([1, 3, 9])("keeps %s prompt exchanges, not their long unprompted tail", async count => {
    const tail = Array.from({ length: 40 }, (_, i) => row(100 + i, `tail ${i}: ${"unpaired output ".repeat(500)}`));
    const { messages } = await project([...exchanges(count), ...tail]);
    const opening = selectOpeningExchanges(messages);
    expect(opening).toHaveLength(count * 2);
    expect(opening.at(-1)?.text).toBe(`answer ${(count - 1) * 3 + 1}`);
    const selection = selectReconstructionRanges({ messages, contextWindow: 20_000,
      budgetTokens: reconstructionBudgetTokens(20_000), sourcePostCount: messages.length });
    expect(selection.opening).toEqual(opening);
    expect(selection.recent.at(-1)?.id).toBe("139");
    expect(selection.omitted.length).toBeGreaterThan(0);
  });

  it("counts human and handoff prompts together without relabeling either", async () => {
    const { messages } = await project(exchanges(12, true));
    const opening = selectOpeningExchanges(messages);
    expect(opening).toHaveLength(20);
    expect(opening.filter(m => m.role === "user")).toHaveLength(5);
    expect(opening.filter(m => m.role === "prompt")).toHaveLength(5);
    expect(renderLogicalMessage(opening[0]!)).toContain("Human — Alex");
    expect(opening.at(-1)?.text).toBe("answer 28");
  });

  it("has no mandatory opening when there are no identifiable prompts", async () => {
    const { messages } = await project(Array.from({ length: 40 }, (_, i) => row(i + 1, `output ${i}: ${"x".repeat(1900)}`)));
    expect(selectOpeningExchanges(messages)).toEqual([]);
    const seed = assembleReconstruction({ messages, contextWindow: 10_000,
      budgetTokens: 6_000, sourcePostCount: messages.length, normalize: text => ({ text, savedChars: 0 }) });
    expect(seed.estimatedTokens).toBeLessThanOrEqual(6_000);
    expect(seed.omittedLogicalCount).toBeGreaterThan(0);
    expect(seed.text).toContain("output 39:");
  });

  it("does not protect leading or inter-exchange unprompted output, or reorder complete history", async () => {
    const { messages } = await project([
      row(1, "leading orphan"), prompt(2), row(3, "first response"),
      row(4, "unpaired output"), prompt(5), row(6, "second response"),
    ]);
    const opening = selectOpeningExchanges(messages);
    expect(opening.map(m => m.id)).toEqual(["2", "3", "5", "6"]);
    const seed = assembleReconstruction({ messages, contextWindow: 20_000,
      budgetTokens: 12_000, sourcePostCount: 6 });
    expect(seed.complete).toBe(true);
    let cursor = -1;
    for (const message of messages) {
      const next = seed.text.indexOf(message.text);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  it("discloses omitted leading output at its actual position, outside the protected exchanges", async () => {
    const { messages } = await project([
      row(1, "old prelude ".repeat(10_000)), prompt(2), row(3, "response"),
      row(4, "middle gap ".repeat(10_000)), row(5, "newest output"),
    ]);
    const seed = assembleReconstruction({ messages, contextWindow: 2_000,
      budgetTokens: 1_200, sourcePostCount: 5, normalize: text => ({ text, savedChars: 0 }) });
    expect(seed.estimatedTokens).toBeLessThanOrEqual(1_200);
    expect(seed.omittedLogicalCount).toBe(2);
    expect(seed.text.match(/Session reconstruction boundary:/g)).toHaveLength(2);
    expect(seed.text.indexOf("Session reconstruction boundary:")).toBeLessThan(seed.text.indexOf("directive 2"));
    expect(seed.text.lastIndexOf("Session reconstruction boundary:")).toBeGreaterThan(seed.text.indexOf("response"));
    expect(seed.text).toContain("newest output");
  });

  it("never protects more than ten prompts or any unpaired tail, across deterministic generated shapes", async () => {
    for (let prompts = 0; prompts <= 15; prompts++) {
      const rows = [row(0, "leading output"), ...exchanges(prompts, true),
        ...Array.from({ length: 8 }, (_, i) => row(100 + i, `tail ${i}`))];
      const { messages } = await project(rows);
      const opening = selectOpeningExchanges(messages);
      const expectedIds = rows.slice(1, 1 + Math.min(10, prompts) * 2).map(r => r.id);
      expect(opening.map(m => m.id), `prompt count ${prompts}`).toEqual(expectedIds);
      expect(opening.every(m => !m.text.startsWith("tail"))).toBe(true);
    }
  });
});
