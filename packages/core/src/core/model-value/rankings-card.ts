import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../lib/logger.js";
import type { ChatAdapter, MessageRef } from "../../platforms/chat-adapter.js";
import type { LayoutBlock, StructuredLayout, StructuredPanel } from "../types.js";
import {
  type ModelValueSnapshotRow,
  type ModelValueTier,
} from "./types.js";

const STATE_FILE = "model-value-rankings-card.json";
const DEBOUNCE_MS = 500;
const COLOR = 0x5865f2;
const LAYOUT_TEXT_LIMIT = 3_800;
const PANEL_FIELD_LIMIT = 1_024;
const PANEL_TOTAL_LIMIT = 6_000;
export const MODEL_VALUE_RANKINGS_BUMP_AFTER_MS = 20 * 60 * 60_000;

const TIER_SECTIONS: ReadonlyArray<{
  tier: ModelValueTier | null;
  label: string;
}> = [
  { tier: "flagship", label: "🚀 Flagship" },
  { tier: "balanced", label: "⚖️ Balanced" },
  { tier: "flash", label: "⚡ Flash" },
  { tier: null, label: "◻️ Unranked / incomplete data" },
];

interface Persisted {
  threadId: string;
  messageId: string;
  lastBumpAt: number;
}

/** Make cached/source-controlled labels inert in Discord without hiding them. */
export function inertRankingsText(input: string, maxUnits = 180): string {
  const replacements = new Map<string, string>([
    ["@", "＠"], ["<", "＜"], [">", "＞"], ["*", "＊"], ["_", "＿"],
    ["~", "～"], ["`", "｀"], ["|", "｜"], ["[", "［"], ["]", "］"],
    ["(", "（"], [")", "）"], ["#", "＃"], ["\\", "＼"], [":", "："], ["/", "／"],
  ]);
  const visible = input
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16(
    [...visible].map((character) => replacements.get(character) ?? character).join(""),
    maxUnits
  );
}

function truncateUtf16(value: string, maxUnits: number, suffix = "…"): string {
  if (value.length <= maxUnits) return value;
  const keep = Math.max(0, maxUnits - suffix.length);
  let end = keep;
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return `${value.slice(0, end)}${suffix}`;
}

function displayNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function rankingLine(row: ModelValueSnapshotRow, rank: number | null): string {
  const ordinal = rank === null ? "•" : `${rank}.`;
  const benchmark = row.intelligenceIndex !== null
    ? `AA intelligence ${displayNumber(row.intelligenceIndex)}`
    : "benchmark unavailable";
  const price = row.creditsPerTask !== null
    ? `${displayNumber(row.creditsPerTask)} credits/task`
    : "price unavailable";
  const effortValues = row.validEffortTiers
    .slice(0, 8)
    .map((effort) => inertRankingsText(effort, 24));
  if (row.validEffortTiers.length > effortValues.length) {
    effortValues.push(`＋${row.validEffortTiers.length - effortValues.length} more`);
  }
  const efforts = effortValues.length
    ? effortValues.join("/")
    : "none advertised";
  return truncateUtf16(
    `${ordinal} **${inertRankingsText(row.copilotModel)}** · value ${displayNumber(row.valueScore)} · ` +
      `${benchmark} · price ${price} · effort ${efforts}`,
    900
  );
}

function sortedSectionRows(
  rows: readonly ModelValueSnapshotRow[],
  tier: ModelValueTier | null
): ModelValueSnapshotRow[] {
  return rows
    .filter((row) => row.tier === tier)
    .sort((a, b) => {
      if (a.valueScore === null && b.valueScore !== null) return 1;
      if (a.valueScore !== null && b.valueScore === null) return -1;
      return (b.valueScore ?? 0) - (a.valueScore ?? 0) || a.copilotModel.localeCompare(b.copilotModel);
    });
}

function snapshotDescription(rows: readonly ModelValueSnapshotRow[]): string {
  const fetchedAt = rows[0]?.fetchedAt;
  if (!fetchedAt) return "No cached snapshot yet.";
  const parsed = Date.parse(fetchedAt);
  if (!Number.isFinite(parsed)) return "Cached snapshot timestamp is unavailable.";
  const unix = Math.floor(parsed / 1_000);
  return `As of <t:${unix}:R> · <t:${unix}:f> · higher value is better`;
}

function chunkLines(lines: readonly string[], maxUnits: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const raw of lines) {
    const line = truncateUtf16(raw, maxUnits);
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxUnits) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line;
  }
  if (current) chunks.push(current);
  return chunks;
}

function sectionLines(
  rows: readonly ModelValueSnapshotRow[],
  tier: ModelValueTier | null
): string[] {
  const sectionRows = sortedSectionRows(rows, tier);
  if (sectionRows.length === 0) return ["_No models in this tier._"];
  return sectionRows.map((row, index) => rankingLine(row, tier === null ? null : index + 1));
}

export function renderModelValueRankingsLayout(
  rows: readonly ModelValueSnapshotRow[]
): StructuredLayout {
  const blocks: LayoutBlock[] = [
    { kind: "text", content: "**📊 Model value rankings**" },
    { kind: "text", content: snapshotDescription(rows) },
  ];
  for (const section of TIER_SECTIONS) {
    const chunks = chunkLines(sectionLines(rows, section.tier), LAYOUT_TEXT_LIMIT - 80);
    chunks.forEach((chunk, index) => {
      blocks.push({ kind: "separator", divider: true, spacing: index === 0 ? "large" : "small" });
      blocks.push({
        kind: "text",
        content: `**${section.label}${index === 0 ? "" : " (continued)"}**\n${chunk}`,
      });
    });
  }
  return { color: COLOR, blocks };
}

export function renderModelValueRankingsPanel(
  rows: readonly ModelValueSnapshotRow[]
): StructuredPanel {
  const title = "📊 Model value rankings";
  const description = snapshotDescription(rows);
  const fields: NonNullable<StructuredPanel["fields"]> = [];
  let used = title.length + description.length;
  let omitted = false;
  for (const section of TIER_SECTIONS) {
    const chunks = chunkLines(sectionLines(rows, section.tier), PANEL_FIELD_LIMIT);
    for (const [index, value] of chunks.entries()) {
      const name = `${section.label}${index === 0 ? "" : " (continued)"}`;
      if (fields.length >= 25 || used + name.length + value.length > PANEL_TOTAL_LIMIT) {
        omitted = true;
        break;
      }
      fields.push({ name, value, inline: false });
      used += name.length + value.length;
    }
    if (omitted) break;
  }
  if (omitted && fields.length < 25) {
    const name = "More models";
    const value = "_Additional cached rows omitted to stay within Discord limits._";
    if (used + name.length + value.length <= PANEL_TOTAL_LIMIT) {
      fields.push({ name, value, inline: false });
    }
  }
  return { color: COLOR, title, description, fields };
}

export class ModelValueRankingsCard {
  private readonly logger: Logger;
  private readonly adapter: ChatAdapter;
  private readonly threadId: string;
  private readonly dataDir: string;
  private readonly collect: () => ModelValueSnapshotRow[];
  private readonly now: () => number;
  private readonly channel = { platform: "discord", id: "" };
  private message?: MessageRef;
  private debounce?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private dirty = false;
  private stopped = false;
  private pinned = false;
  private lastBumpAt = 0;

  constructor(opts: {
    logger: Logger;
    adapter: ChatAdapter;
    threadId: string;
    dataDir: string;
    collect: () => ModelValueSnapshotRow[];
    now?: () => number;
  }) {
    this.logger = opts.logger.child({ comp: "model-value-rankings-card" });
    this.adapter = opts.adapter;
    this.threadId = opts.threadId;
    this.dataDir = opts.dataDir;
    this.collect = opts.collect;
    this.now = opts.now ?? Date.now;
    this.channel.id = opts.threadId;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.loadState();
    await this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
  }

  poke(): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.tick();
    }, DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    this.inFlight = true;
    try {
      await this.push();
    } catch (err) {
      this.logger.warn({ err }, "model value rankings card refresh failed");
    } finally {
      this.inFlight = false;
      if (this.dirty) {
        this.dirty = false;
        void this.tick();
      }
    }
  }

  private async push(): Promise<void> {
    const rows = this.collect();
    const now = this.now();
    if (this.adapter.sendLayout && this.adapter.editLayout) {
      await this.pushLayout(renderModelValueRankingsLayout(rows));
    } else if (this.adapter.sendPanel && this.adapter.editPanel) {
      await this.pushPanel(renderModelValueRankingsPanel(rows));
    } else {
      this.logger.warn("model value rankings card skipped: adapter has no layout/panel methods");
      return;
    }
    await this.maybeBump(now);
  }

  private async pushLayout(layout: StructuredLayout): Promise<void> {
    if (this.message) {
      try {
        await this.adapter.editLayout!(this.message, layout);
        this.persist();
        await this.ensurePinned();
        return;
      } catch (err) {
        this.logger.info({ err }, "model value rankings card edit failed; posting a replacement");
        const stale = this.message;
        this.message = undefined;
        this.pinned = false;
        await this.sendLayout(layout);
        if (this.adapter.deleteMessage) await this.adapter.deleteMessage(stale).catch(() => {});
        return;
      }
    }
    await this.sendLayout(layout);
  }

  private async sendLayout(layout: StructuredLayout): Promise<void> {
    this.message = await this.adapter.sendLayout!(this.channel, layout);
    this.lastBumpAt = this.now();
    this.persist();
    await this.ensurePinned();
  }

  private async pushPanel(panel: StructuredPanel): Promise<void> {
    if (this.message) {
      try {
        await this.adapter.editPanel!(this.message, panel);
        this.persist();
        await this.ensurePinned();
        return;
      } catch (err) {
        this.logger.info({ err }, "model value rankings card edit failed; posting a replacement");
        const stale = this.message;
        this.message = undefined;
        this.pinned = false;
        await this.sendPanel(panel);
        if (this.adapter.deleteMessage) await this.adapter.deleteMessage(stale).catch(() => {});
        return;
      }
    }
    await this.sendPanel(panel);
  }

  private async sendPanel(panel: StructuredPanel): Promise<void> {
    this.message = await this.adapter.sendPanel!(this.channel, panel);
    this.lastBumpAt = this.now();
    this.persist();
    await this.ensurePinned();
  }

  private async ensurePinned(): Promise<void> {
    if (this.pinned || !this.message || !this.adapter.pinMessage) return;
    try {
      await this.adapter.pinMessage(this.message);
      this.pinned = true;
    } catch (err) {
      this.logger.warn({ err }, "model value rankings card pin failed");
    }
  }

  private async maybeBump(now: number): Promise<void> {
    if (!this.adapter.bumpThread || now - this.lastBumpAt <= MODEL_VALUE_RANKINGS_BUMP_AFTER_MS) {
      return;
    }
    await this.adapter.bumpThread(this.channel);
    this.lastBumpAt = now;
    this.persist();
  }

  private statePath(): string {
    return path.join(this.dataDir, STATE_FILE);
  }

  private loadState(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath(), "utf8")) as Partial<Persisted>;
      if (parsed.threadId !== this.threadId || !parsed.messageId) return;
      this.message = { channel: this.channel, id: parsed.messageId };
      this.lastBumpAt = typeof parsed.lastBumpAt === "number" ? parsed.lastBumpAt : 0;
    } catch {
      // First run — nothing to restore.
    }
  }

  private persist(): void {
    if (!this.message) return;
    try {
      const body: Persisted = {
        threadId: this.threadId,
        messageId: this.message.id,
        lastBumpAt: this.lastBumpAt,
      };
      fs.writeFileSync(this.statePath(), JSON.stringify(body));
    } catch (err) {
      this.logger.warn({ err }, "failed to persist model value rankings card state");
    }
  }
}
