import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../lib/logger.js";
import type { ChatAdapter, MessageRef } from "../platforms/chat-adapter.js";
import type { LayoutBlock, PanelButton, StructuredLayout, StructuredPanel } from "./types.js";
import { statusRank } from "./service-status/severity.js";
import type {
  ServiceStatusLevel,
  ServiceStatusSnapshot,
  ServiceStatusSourceDefinition,
} from "./service-status/types.js";

const STATE_FILE = "service-status-card.json";
const DEBOUNCE_MS = 500;
const ROW_LIMIT = 760;
const PANEL_TOTAL_LIMIT = 6_000;
export const SERVICE_STATUS_BUMP_AFTER_MS = 20 * 60 * 60_000;
export const SERVICE_STATUS_REFRESH_CUSTOM_ID = "seam-service-status:refresh";

const REFRESH_ACTIONS: PanelButton[][] = [[{
  customId: SERVICE_STATUS_REFRESH_CUSTOM_ID,
  label: "Refresh",
  style: "secondary",
  emoji: "🔄",
}]];

const LEVEL_VIEW: Record<ServiceStatusLevel, { icon: string; label: string; color: number }> = {
  operational: { icon: "🟢", label: "Operational", color: 0x57f287 },
  maintenance: { icon: "🔵", label: "Maintenance", color: 0x5865f2 },
  degraded: { icon: "🟡", label: "Degraded", color: 0xfee75c },
  unknown: { icon: "⚪", label: "Unknown", color: 0x95a5a6 },
  partial_outage: { icon: "🟠", label: "Partial outage", color: 0xfaa61a },
  major_outage: { icon: "🔴", label: "Major outage", color: 0xed4245 },
};

interface Persisted {
  threadId: string;
  messageId: string;
  lastBumpAt: number;
}

function truncateUtf16(value: string, max: number, suffix = "…"): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max - suffix.length);
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}${suffix}`;
}

/** Make upstream-controlled labels inert without breaking our own markdown. */
export function inertServiceStatusText(value: string, max = 180): string {
  const replacements = new Map<string, string>([
    ["@", "＠"], ["<", "＜"], [">", "＞"], ["*", "＊"], ["_", "＿"],
    ["~", "～"], ["`", "｀"], ["|", "｜"], ["[", "［"], ["]", "］"],
  ]);
  const visible = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16([...visible].map((char) => replacements.get(char) ?? char).join(""), max);
}

function unix(iso: string | null): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
}

function freshWorst(snapshots: readonly ServiceStatusSnapshot[]): ServiceStatusLevel {
  const fresh = snapshots.filter((snapshot) => snapshot.observation.health === "ok");
  return fresh.reduce<ServiceStatusLevel>(
    (worst, snapshot) => statusRank(snapshot.effectiveStatus) > statusRank(worst)
      ? snapshot.effectiveStatus
      : worst,
    fresh.length > 0 ? "operational" : "unknown"
  );
}

function headerDescription(snapshots: readonly ServiceStatusSnapshot[]): string {
  const readings = snapshots
    .map((snapshot) => unix(snapshot.reportedAt))
    .filter((stamp): stamp is number => stamp !== null);
  const waiting = snapshots.filter((snapshot) => snapshot.reportedAt === null).length;
  const oldest = readings.length > 0 ? `Oldest reading <t:${Math.min(...readings)}:R>` : "No cached readings yet";
  return `${oldest} · source timestamps below${waiting > 0 ? ` · ${String(waiting)} awaiting first read` : ""}`;
}

function linkedLabel(snapshot: ServiceStatusSnapshot, source?: ServiceStatusSourceDefinition): string {
  const label = inertServiceStatusText(snapshot.label, 80);
  return source?.homepage ? `[${label}](${source.homepage})` : label;
}

function providerState(snapshot: ServiceStatusSnapshot): string {
  const provider = LEVEL_VIEW[snapshot.effectiveStatus];
  if (snapshot.observation.health === "ok") return `${provider.icon} ${provider.label}`;
  if (snapshot.observation.health === "never_fetched") return "⚪ No data";
  const observation = snapshot.observation.health === "stale" ? "Stale observation" : "Source error";
  return `⚪ ${observation} · last reported ${provider.label.toLowerCase()}`;
}

function observationLine(snapshot: ServiceStatusSnapshot): string {
  const reported = unix(snapshot.reportedAt);
  const attempted = unix(snapshot.observation.lastAttemptAt);
  if (snapshot.observation.health === "never_fetched") return "No successful reading yet.";
  if (snapshot.observation.health === "ok") {
    return reported === null ? "Fresh observation." : `Reading <t:${reported}:R> · fresh`;
  }
  if (snapshot.observation.health === "stale") {
    return reported === null ? "Cached reading is stale." : `Last good <t:${reported}:R> · stale`;
  }
  const timing = [
    attempted === null ? "" : `attempt <t:${attempted}:R> failed`,
    reported === null ? "no cached success" : `last good <t:${reported}:R>`,
  ].filter(Boolean).join(" · ");
  const error = snapshot.observation.lastError
    ? ` · ${inertServiceStatusText(snapshot.observation.lastError, 130)}`
    : "";
  return `${timing}${error}`;
}

function detailLines(snapshot: ServiceStatusSnapshot): string[] {
  const lines: string[] = [];
  const affected = snapshot.components.filter(
    (component) => component.selected && component.status !== "operational"
  );
  if (affected.length > 0) {
    const shown = affected.slice(0, 3).map(
      (component) => `${inertServiceStatusText(component.name, 80)} (${LEVEL_VIEW[component.status].label.toLowerCase()})`
    );
    if (affected.length > shown.length) shown.push(`＋${String(affected.length - shown.length)} more`);
    lines.push(`Affected: ${shown.join(" · ")}`);
  }
  const active = snapshot.incidents
    .filter((incident) => incident.stage === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (active.length > 0) {
    const incident = active[0]!;
    const title = inertServiceStatusText(incident.title, 180);
    lines.push(`Incident: ${incident.url ? `[${title}](${incident.url})` : title}${active.length > 1 ? ` · ＋${String(active.length - 1)} more active` : ""}`);
  }
  if (snapshot.provenance === "external_synthetic") {
    lines.push("_External synthetic probe · not official Ollama Cloud status._");
  }
  return lines;
}

export function renderServiceStatusRow(
  snapshot: ServiceStatusSnapshot,
  source?: ServiceStatusSourceDefinition
): string {
  return truncateUtf16([
    `${providerState(snapshot)} · **${linkedLabel(snapshot, source)}**`,
    observationLine(snapshot),
    ...detailLines(snapshot),
  ].join("\n"), ROW_LIMIT);
}

export function renderServiceStatusLayout(
  snapshots: readonly ServiceStatusSnapshot[],
  sources: readonly ServiceStatusSourceDefinition[]
): StructuredLayout {
  const level = freshWorst(snapshots);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const blocks: LayoutBlock[] = [
    { kind: "text", content: `**${LEVEL_VIEW[level].icon} Upstream service status**` },
    { kind: "text", content: headerDescription(snapshots) },
  ];
  if (snapshots.length === 0) {
    blocks.push({ kind: "separator", divider: true, spacing: "large" });
    blocks.push({ kind: "text", content: "_No configured sources._" });
  } else {
    snapshots.forEach((snapshot, index) => {
      blocks.push({ kind: "separator", divider: true, spacing: index === 0 ? "large" : "small" });
      blocks.push({ kind: "text", content: renderServiceStatusRow(snapshot, sourceById.get(snapshot.sourceId)) });
    });
  }
  return { color: LEVEL_VIEW[level].color, blocks, actions: REFRESH_ACTIONS };
}

export function renderServiceStatusPanel(
  snapshots: readonly ServiceStatusSnapshot[],
  sources: readonly ServiceStatusSourceDefinition[]
): StructuredPanel {
  const level = freshWorst(snapshots);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const title = `${LEVEL_VIEW[level].icon} Upstream service status`;
  const description = headerDescription(snapshots);
  const fields: StructuredPanel["fields"] = [];
  let used = title.length + description.length;
  for (const snapshot of snapshots.slice(0, 25)) {
    const name = inertServiceStatusText(snapshot.label, 256);
    const value = truncateUtf16(renderServiceStatusRow(snapshot, sourceById.get(snapshot.sourceId)), 1_024);
    if (used + name.length + value.length > PANEL_TOTAL_LIMIT) break;
    fields.push({ name, value, inline: false });
    used += name.length + value.length;
  }
  if (fields.length === 0) fields.push({ name: "Sources", value: "_No configured sources._" });
  return { color: LEVEL_VIEW[level].color, title, description, fields, actions: REFRESH_ACTIONS };
}

export class ServiceStatusCard {
  private readonly logger: Logger;
  private readonly adapter: ChatAdapter;
  private readonly dataDir: string;
  private readonly collect: () => ServiceStatusSnapshot[];
  private readonly sources: readonly ServiceStatusSourceDefinition[];
  private readonly now: () => number;
  private readonly channel: { platform: "discord"; id: string };
  private message?: MessageRef;
  private debounce?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private dirty = false;
  private stopped = true;
  private pinned = false;
  private lastBumpAt = 0;

  constructor(opts: {
    logger: Logger;
    adapter: ChatAdapter;
    threadId: string;
    dataDir: string;
    collect: () => ServiceStatusSnapshot[];
    sources: readonly ServiceStatusSourceDefinition[];
    now?: () => number;
  }) {
    this.logger = opts.logger.child({ comp: "service-status-card" });
    this.adapter = opts.adapter;
    this.dataDir = opts.dataDir;
    this.collect = opts.collect;
    this.sources = opts.sources;
    this.now = opts.now ?? Date.now;
    this.channel = { platform: "discord", id: opts.threadId };
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
    this.dirty = false;
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
      this.logger.warn({ err }, "service status card refresh failed");
    } finally {
      this.inFlight = false;
      if (this.dirty && !this.stopped) {
        this.dirty = false;
        void this.tick();
      }
    }
  }

  private async push(): Promise<void> {
    const snapshots = this.collect();
    const now = this.now();
    if (this.adapter.sendLayout && this.adapter.editLayout) {
      await this.pushLayout(renderServiceStatusLayout(snapshots, this.sources));
    } else if (this.adapter.sendPanel && this.adapter.editPanel) {
      await this.pushPanel(renderServiceStatusPanel(snapshots, this.sources));
    } else {
      this.logger.warn("service status card skipped: adapter has no layout/panel methods");
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
        this.logger.info({ err }, "service status card edit failed; posting a replacement");
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
        this.logger.info({ err }, "service status card edit failed; posting a replacement");
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
      this.logger.warn({ err }, "service status card pin failed");
    }
  }

  private async maybeBump(now: number): Promise<void> {
    if (!this.adapter.bumpThread || now - this.lastBumpAt <= SERVICE_STATUS_BUMP_AFTER_MS) return;
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
      if (parsed.threadId !== this.channel.id || !parsed.messageId) return;
      this.message = { channel: this.channel, id: parsed.messageId };
      this.lastBumpAt = typeof parsed.lastBumpAt === "number" ? parsed.lastBumpAt : 0;
    } catch {
      // First run or invalid state: post a fresh canonical card.
    }
  }

  private persist(): void {
    if (!this.message) return;
    try {
      const body: Persisted = {
        threadId: this.channel.id,
        messageId: this.message.id,
        lastBumpAt: this.lastBumpAt,
      };
      fs.writeFileSync(this.statePath(), JSON.stringify(body));
    } catch (err) {
      this.logger.warn({ err }, "failed to persist service status card state");
    }
  }
}
