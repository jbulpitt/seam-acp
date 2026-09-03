import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../lib/logger.js";
import type { ChatAdapter, MessageRef } from "../../platforms/chat-adapter.js";
import type { LayoutBlock, PanelButton, StructuredLayout, StructuredPanel } from "../types.js";
import type { AgentQuota, QuotaWindow } from "./agent-quota.js";

const STATE_FILE = "agent-quota-card.json";
const DEBOUNCE_MS = 500;
const COLOR_OK = 0x57f287;
const COLOR_WARN = 0xfaa61a;
const HIDDEN_AGENT_IDS = new Set(["claude-vertex"]);
export const AGENT_QUOTA_BUMP_AFTER_MS = 20 * 60 * 60_000;

/** Custom id for the manual "Refresh" button; routed to the orchestrator's
 *  quota-card component handler, which force-refreshes every agent now. */
export const QUOTA_REFRESH_CUSTOM_ID = "seam-quota:refresh";
const REFRESH_ACTIONS: PanelButton[][] = [
  [{ customId: QUOTA_REFRESH_CUSTOM_ID, label: "Refresh", style: "secondary", emoji: "🔄" }],
];

interface Persisted {
  threadId: string;
  messageId: string;
  lastBumpAt: number;
}

function usageBar(percent: number): string {
  const filled = Math.min(20, Math.max(0, Math.round(percent / 5)));
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

function resetLabel(window: QuotaWindow): string {
  if (window.label === "unlimited") return "unlimited";
  return window.resetsAt === null ? "reset unknown" : `resets <t:${window.resetsAt}:R>`;
}

function quotaLine(label: "rolling" | "weekly", window: QuotaWindow): string {
  if (window.label === "unlimited") return `**${label}** unlimited`;
  return `**${label}** \`${usageBar(window.usedPercent)}\` ${Math.round(window.usedPercent)}% · ${resetLabel(window)}`;
}

export function renderAgentQuotaRow(quota: AgentQuota): string {
  const details = [
    quota.plan ? `plan ${quota.plan}` : "",
    quota.credits
      ? quota.credits.unlimited
        ? "credits unlimited"
        : `credits ${quota.credits.balance}`
      : "",
  ].filter(Boolean);
  const warning = quota.ok ? "" : ` ⚠️ ${quota.error ?? "quota unavailable"}`;
  // Per-agent freshness: quota reads are polled on an activity-scaled cadence
  // (idle agents as slow as hourly), so each row stamps its own snapshot time —
  // the card-level header only reflects the last *render*, not each agent's fetch.
  const meta = [
    details.join(" · ") || "plan/credits unavailable",
    `updated <t:${quota.fetchedAt}:R>`,
  ].join(" · ");
  return [
    `${quotaLine("rolling", quota.rolling)}`,
    `${quotaLine("weekly", quota.weekly)}`,
    `${meta}${warning}`,
  ].join("\n");
}

/**
 * Timestamp (unix seconds) for the card-level header: the OLDEST per-agent
 * snapshot among visible agents, so the header states the card's worst-case
 * staleness honestly instead of re-claiming "just now" on every re-render.
 */
function oldestFetchedAt(quotas: AgentQuota[], nowMs: number): number {
  const stamps = quotas
    .map((quota) => quota.fetchedAt)
    .filter((stamp): stamp is number => Number.isFinite(stamp));
  return stamps.length ? Math.min(...stamps) : Math.floor(nowMs / 1000);
}

function isWarning(quotas: AgentQuota[]): boolean {
  return quotas.some(
    (quota) =>
      !quota.ok || quota.rolling.usedPercent >= 90 || quota.weekly.usedPercent >= 90
  );
}

function visibleCardQuotas(quotas: AgentQuota[]): AgentQuota[] {
  return quotas.filter((quota) => !HIDDEN_AGENT_IDS.has(quota.agentId));
}

export function renderAgentQuotaLayout(
  quotas: AgentQuota[],
  nowMs = Date.now()
): StructuredLayout {
  const visibleQuotas = visibleCardQuotas(quotas);
  const warn = isWarning(visibleQuotas);
  const blocks: LayoutBlock[] = [
    { kind: "text", content: `**${warn ? "🟡" : "🟢"} Agent quota**` },
    {
      kind: "text",
      content: `Oldest reading <t:${oldestFetchedAt(visibleQuotas, nowMs)}:R> · per-agent times below`,
    },
  ];
  if (visibleQuotas.length === 0) {
    blocks.push(
      { kind: "separator", divider: true, spacing: "small" },
      { kind: "text", content: "_No configured agents._" }
    );
  } else {
    visibleQuotas.forEach((quota, index) => {
      blocks.push({
        kind: "separator",
        divider: true,
        spacing: index === 0 ? "large" : "small",
      });
      blocks.push({
        kind: "text",
        content: `**${quota.displayName}** · \`${quota.agentId}\`\n${renderAgentQuotaRow(quota)}`,
      });
    });
  }
  return { color: warn ? COLOR_WARN : COLOR_OK, blocks, actions: REFRESH_ACTIONS };
}

export function renderAgentQuotaPanel(
  quotas: AgentQuota[],
  nowMs = Date.now()
): StructuredPanel {
  const visibleQuotas = visibleCardQuotas(quotas);
  const warn = isWarning(visibleQuotas);
  return {
    color: warn ? COLOR_WARN : COLOR_OK,
    title: `${warn ? "🟡" : "🟢"} Agent quota`,
    description: `Oldest reading <t:${oldestFetchedAt(visibleQuotas, nowMs)}:R> · per-agent times below`,
    fields:
      visibleQuotas.length === 0
        ? [{ name: "Agents", value: "_No configured agents._" }]
        : visibleQuotas.slice(0, 25).map((quota) => ({
            name: `${quota.displayName} · ${quota.agentId}`.slice(0, 256),
            value: renderAgentQuotaRow(quota).slice(0, 1024),
            inline: false,
          })),
    actions: REFRESH_ACTIONS,
  };
}

export class AgentQuotaCard {
  private readonly logger: Logger;
  private readonly adapter: ChatAdapter;
  private readonly threadId: string;
  private readonly dataDir: string;
  private readonly collect: () => AgentQuota[];
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
    collect: () => AgentQuota[];
    now?: () => number;
  }) {
    this.logger = opts.logger.child({ comp: "agent-quota-card" });
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
      this.logger.warn({ err }, "agent quota card refresh failed");
    } finally {
      this.inFlight = false;
      if (this.dirty) {
        this.dirty = false;
        void this.tick();
      }
    }
  }

  private async push(): Promise<void> {
    const quotas = this.collect();
    const now = this.now();
    if (this.adapter.sendLayout && this.adapter.editLayout) {
      await this.pushLayout(renderAgentQuotaLayout(quotas, now));
    } else if (this.adapter.sendPanel && this.adapter.editPanel) {
      await this.pushPanel(renderAgentQuotaPanel(quotas, now));
    } else {
      this.logger.warn("agent quota card skipped: adapter has no layout/panel methods");
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
        this.logger.info({ err }, "agent quota card edit failed; posting a new one");
        const stale = this.message;
        this.message = undefined;
        this.pinned = false;
        await this.sendLayout(layout);
        if (this.adapter.deleteMessage) {
          await this.adapter.deleteMessage(stale).catch(() => {});
        }
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
        this.logger.info({ err }, "agent quota card edit failed; posting a new one");
        this.message = undefined;
        this.pinned = false;
      }
    }
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
      this.logger.warn({ err }, "agent quota card pin failed");
    }
  }

  private async maybeBump(now: number): Promise<void> {
    if (!this.adapter.bumpThread || now - this.lastBumpAt <= AGENT_QUOTA_BUMP_AFTER_MS) {
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
      this.lastBumpAt =
        typeof parsed.lastBumpAt === "number" ? parsed.lastBumpAt : 0;
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
      this.logger.warn({ err }, "failed to persist agent quota card state");
    }
  }
}
