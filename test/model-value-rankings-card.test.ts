import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../packages/core/src/config.js";
import {
  MODEL_VALUE_RANKINGS_BUMP_AFTER_MS,
  ModelValueRankingsCard,
  renderModelValueRankingsLayout,
  renderModelValueRankingsPanel,
} from "../packages/core/src/core/model-value/rankings-card.js";
import type {
  ModelValueSnapshotRow,
} from "../packages/core/src/core/model-value/types.js";
import type { StructuredLayout } from "../packages/core/src/core/types.js";
import { rankSnapshotRows } from "../packages/core/src/core/model-value/ranking.js";
import { twoBindingCopilotRankings } from "./fixtures/two-binding-copilot-rankings.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type {
  ChannelRef,
  ChatAdapter,
  MessageRef,
} from "../packages/core/src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

function ranking(
  over: Partial<ModelValueSnapshotRow> & { copilotModel: string }
): ModelValueSnapshotRow {
  const { copilotModel, ...rest } = over;
  return {
    copilotModel,
    aaSlug: "fixture-model",
    tier: "flagship",
    intelligenceIndex: 50,
    benchmarks: {},
    inputRate: 1,
    cachedInputRate: 0.1,
    cacheWriteRate: null,
    outputRate: 4,
    creditsPerTask: 1.6,
    valueScore: 1,
    validEffortTiers: ["low", "high"],
    priceCategory: "medium",
    fetchedAt: "2026-09-01T12:00:00.000Z",
    ...rest,
  };
}

function snapshot(rows: ModelValueSnapshotRow[] = []): ModelValueSnapshotRow[] {
  return rows;
}

function layoutText(layout: StructuredLayout): string {
  return layout.blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.kind === "text" ? block.content : "")
    .join("\n");
}

describe("model value rankings rendering", () => {
  it("collapses model IDs across distinct bindings without changing the MCP ranking rows", () => {
    const binding = (location: string) => ({ agent: "copilot", location, scope: location, generation: 1, state: "ready" as const });
    const rows = [
      ranking({ copilotModel: "same-model", variantId: "b::same", valueScore: 10, bindings: [binding("host-b")] }),
      ranking({ copilotModel: "same-model", variantId: "a::same", valueScore: 20, bindings: [binding("host-a")] }),
      ranking({ copilotModel: "same-model", variantId: "older::same", valueScore: 5, bindings: [binding("host-a")] }),
    ];
    const before = structuredClone(rows);
    const mcpBefore = rankSnapshotRows(rows);
    for (const text of [layoutText(renderModelValueRankingsLayout(rows)), JSON.stringify(renderModelValueRankingsPanel(rows))]) {
      expect(text.match(/\*\*same-model\*\*/g)).toHaveLength(1);
      expect(text).toContain("value 20");
      expect(text).toContain("2 bindings");
    }
    expect(rows).toEqual(before);
    expect(rankSnapshotRows(rows)).toEqual(mcpBefore);
    expect(mcpBefore).toHaveLength(3);
  });

  it("keeps the real two-binding Copilot catalog within the aggregate component text limit", () => {
    const rows = twoBindingCopilotRankings();
    expect(rows).toHaveLength(58);
    const layout = renderModelValueRankingsLayout(rows);
    const text = layoutText(layout);
    const total = layout.blocks.reduce((sum, block) => sum + (block.kind === "text" ? block.content.length : 0), 0);
    expect(total).toBeLessThanOrEqual(4_000);
    const displayed = [...text.matchAll(/\*\*([^*\n]+)\*\* · value/g)].map(match => match[1]);
    expect(new Set(displayed).size).toBe(displayed.length);
    expect(displayed.length).toBeGreaterThan(0);
    expect(text.match(/2 bindings/g)).toHaveLength(displayed.length);
    const omitted = [...text.matchAll(/\+(\d+) more \(see `model_value_rankings` MCP\)/g)]
      .reduce((sum, match) => sum + Number(match[1]), 0);
    expect(omitted + displayed.length).toBe(29);
    expect(text).toContain("see `model_value_rankings` MCP");
    expect(rankSnapshotRows(rows)).toHaveLength(58);
  });

  it("trims only the lowest ranks in each tier and counts all omitted models", () => {
    const tiers = ["flagship", "balanced", "flash", null] as const;
    const rows = tiers.flatMap(tier => Array.from({ length: 30 }, (_, index) => ranking({
      copilotModel: `${tier ?? "unranked"}-${index.toString().padStart(2, "0")}`,
      tier,
      valueScore: tier === null ? null : 30 - index,
    })));
    const layout = renderModelValueRankingsLayout(rows);
    const texts = layout.blocks.filter(block => block.kind === "text").map(block => block.content);
    expect(texts.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(4_000);
    for (const [index, tier] of tiers.entries()) {
      const text = texts[index + 2]!;
      const displayed = [...text.matchAll(/\*\*([^*\n]+)\*\* · value/g)].map(match => match[1]);
      expect(displayed.length).toBeGreaterThan(0);
      expect(displayed).toEqual(rows.filter(row => row.tier === tier).slice(0, displayed.length).map(row => row.copilotModel));
      expect(text).toContain(`+${30 - displayed.length} more (see \`model_value_rankings\` MCP)`);
    }
  });

  it("groups tiers, ranks by value, retains uncovered models, and uses snapshot time", () => {
    const result = snapshot([
      ranking({ copilotModel: "flagship-low", tier: "flagship", valueScore: 10 }),
      ranking({ copilotModel: "flash", tier: "flash", valueScore: 30 }),
      ranking({ copilotModel: "flagship-high", tier: "flagship", valueScore: 20 }),
      ranking({ copilotModel: "balanced", tier: "balanced", valueScore: 15 }),
      ranking({
        copilotModel: "future-model",
        tier: null,
        intelligenceIndex: null,
        valueScore: null,
        inputRate: null,
        outputRate: null,
        creditsPerTask: null,
        validEffortTiers: [],
      }),
    ]);
    const text = layoutText(renderModelValueRankingsLayout(result));
    const fetchedUnix = Math.floor(Date.parse(result[0]!.fetchedAt) / 1_000);

    expect(text).toContain(`Published <t:${fetchedUnix}:R>`);
    expect(text).toContain(`1. **flagship-high**`);
    expect(text).toContain(`2. **flagship-low**`);
    expect(text.indexOf("🚀 Flagship")).toBeLessThan(text.indexOf("⚖️ Balanced"));
    expect(text.indexOf("⚖️ Balanced")).toBeLessThan(text.indexOf("⚡ Flash"));
    expect(text).toContain("◻️ Unranked / incomplete data");
    expect(text).toContain("future-model");
    expect(text).toContain("benchmark unavailable");
    expect(text).toContain("price 1.6 credits/task");
    expect(text).toContain("effort low/high");
  });

  it("neutralizes Discord syntax and bounds layout/panel strings under adversarial cache data", () => {
    const malicious = "<#123456789012345678> **Admin** `code` [Open](https://evil.example) ||x|| @everyone 🚀";
    const rows = Array.from({ length: 80 }, (_, index) => ranking({
      copilotModel: `${malicious}-${index}`,
      tier: index % 4 === 3 ? null : (["flagship", "balanced", "flash"] as const)[index % 3]!,
      valueScore: 100 - index,
      validEffortTiers: [malicious],
    }));
    const layout = renderModelValueRankingsLayout(snapshot(rows));
    const text = layoutText(layout);
    expect(text).not.toContain("<#123456789012345678>");
    expect(text).not.toContain("**Admin**");
    expect(text).not.toContain("[Open](https://evil.example)");
    expect(text).not.toContain("https://evil.example");
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("|");
    expect(layout.blocks.length).toBeLessThanOrEqual(40);
    for (const block of layout.blocks) {
      if (block.kind === "text") expect(block.content.length).toBeLessThanOrEqual(4_000);
    }
    expect(layout.blocks.reduce((total, block) => total + (block.kind === "text" ? block.content.length : 0), 0))
      .toBeLessThanOrEqual(4_000);

    const panel = renderModelValueRankingsPanel(snapshot(rows));
    const title = panel.title ?? "";
    const description = panel.description ?? "";
    expect(title.length).toBeLessThanOrEqual(256);
    expect(description.length).toBeLessThanOrEqual(4_096);
    expect(panel.fields.length).toBeLessThanOrEqual(25);
    expect(panel.fields.every((field) => field.name.length <= 256 && field.value.length <= 1_024)).toBe(true);
    const aggregate = title.length + description.length + panel.fields.reduce(
      (total, field) => total + field.name.length + field.value.length,
      0
    );
    expect(aggregate).toBeLessThanOrEqual(6_000);
  });

  it("states clearly when no durable snapshot exists", () => {
    expect(layoutText(renderModelValueRankingsLayout([]))).toContain("No cached snapshot yet.");
  });
});

describe("model value rankings card lifecycle", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-value-rankings-card-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("posts and pins once, persists state, then edits and self-bumps in place", async () => {
    let now = 2_000_000_000_000;
    const calls = { sends: 0, edits: 0, pins: 0, bumps: 0 };
    const adapter = {
      platform: "discord",
      async start() {},
      async stop() {},
      async sendMessage(channel: ChannelRef): Promise<MessageRef> {
        return { channel, id: "fallback" };
      },
      async editMessage() {},
      async sendLayout(channel: ChannelRef): Promise<MessageRef> {
        calls.sends += 1;
        return { channel, id: "rankings-card" };
      },
      async editLayout() { calls.edits += 1; },
      async pinMessage() { calls.pins += 1; },
      async bumpThread() { calls.bumps += 1; },
    } as unknown as ChatAdapter;
    const card = new ModelValueRankingsCard({
      logger: silent,
      adapter,
      threadId: "1544386824204583052",
      dataDir: dir,
      collect: () => snapshot([ranking({ copilotModel: "model-a" })]),
      now: () => now,
    });

    await card.start();
    expect(calls).toEqual({ sends: 1, edits: 0, pins: 1, bumps: 0 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "model-value-rankings-card.json"), "utf8")))
      .toMatchObject({ threadId: "1544386824204583052", messageId: "rankings-card" });

    await card.tick();
    expect(calls).toEqual({ sends: 1, edits: 1, pins: 1, bumps: 0 });
    now += MODEL_VALUE_RANKINGS_BUMP_AFTER_MS + 1;
    await card.tick();
    expect(calls).toEqual({ sends: 1, edits: 2, pins: 1, bumps: 1 });
    card.stop();

    const restored = new ModelValueRankingsCard({
      logger: silent,
      adapter,
      threadId: "1544386824204583052",
      dataDir: dir,
      collect: () => snapshot([ranking({ copilotModel: "model-a" })]),
      now: () => now,
    });
    await restored.start();
    expect(calls).toEqual({ sends: 1, edits: 3, pins: 2, bumps: 1 });
    restored.stop();
  });

  it("debounces repeated snapshot pokes into one edit", async () => {
    vi.useFakeTimers();
    try {
      let edits = 0;
      const adapter = {
        platform: "discord",
        async start() {},
        async stop() {},
        async sendMessage(channel: ChannelRef): Promise<MessageRef> {
          return { channel, id: "fallback" };
        },
        async editMessage() {},
        async sendLayout(channel: ChannelRef): Promise<MessageRef> {
          return { channel, id: "rankings-card" };
        },
        async editLayout() { edits += 1; },
      } as unknown as ChatAdapter;
      const card = new ModelValueRankingsCard({
        logger: silent,
        adapter,
        threadId: "1544386824204583052",
        dataDir: dir,
        collect: () => snapshot([ranking({ copilotModel: "model-a" })]),
      });
      await card.start();
      card.poke();
      card.poke();
      card.poke();
      expect(edits).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(edits).toBe(1);
      card.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DISCORD_RANKINGS_THREAD_ID", () => {
  let env: Record<string, string | undefined>;

  function setEnv(value: string | undefined): void {
    env = {
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: process.cwd(),
      CHANNEL_PRESETS_FILE: undefined,
      DISCORD_RANKINGS_THREAD_ID: value,
    } as NodeJS.ProcessEnv;
  }

  it("accepts a numeric Discord id and rejects names", () => {
    setEnv("1544386824204583052");
    expect(loadConfig({ env }).DISCORD_RANKINGS_THREAD_ID).toBe("1544386824204583052");
    setEnv("rankings-thread");
    expect(() => loadConfig({ env })).toThrow(/DISCORD_RANKINGS_THREAD_ID/);
  });
});
