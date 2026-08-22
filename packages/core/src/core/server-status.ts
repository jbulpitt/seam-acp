/**
 * Server-status snapshot + Discord embed render. Pure — no I/O. The
 * {@link ServerStatusCard} controller collects a snapshot and edits one
 * message in place so bridge connect/disconnect does not spam the channel.
 */
import type { LayoutBlock, StructuredLayout, StructuredPanel } from "./types.js";
import { hostEmoji, hostShortName } from "./location.js";

export const SERVER_STATUS_INTERVAL_MS = 30_000;

const COLOR_OK = 0x57f287;
const COLOR_WARN = 0xfaa61a;

export interface BridgeAgent {
  id: string;
  emoji?: string;
  ready?: boolean;
}

export interface BridgeStatusRow {
  id: string;
  emoji?: string;
  shortName?: string;
  connected: boolean;
  os?: string;
  arch?: string;
  connectedAt?: number;
  /** First moment we observed this bridge down (persisted across ticks). */
  disconnectedAt?: number;
  agents: BridgeAgent[];
  devMode?: boolean;
  /** Threads with a parked prompt waiting on this host (#88 D7). */
  waiting?: number;
}

export interface ServerStatusSnapshot {
  nowUtc: number;
  startedUtc: number;
  pid: number;
  nodeVersion: string;
  memoryRssBytes: number;
  memoryHeapUsedBytes: number;
  activeTurns: number;
  liveRuntimes: number;
  sessions: number;
  pendingWakes: number;
  pendingWatches: number;
  scheduledJobs: number;
  restartPending: boolean;
  discordPingMs?: number;
  bridges: BridgeStatusRow[];
}

/** Last-known host facts so an offline bridge still has OS / agents / 💤 timer. */
export interface BridgeMemoryEntry {
  os?: string;
  arch?: string;
  agents: BridgeAgent[];
  offlineSince?: number;
}

export type BridgeMemory = Record<string, BridgeMemoryEntry>;

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Bridge up/down clocks — minutes is the finest grain. */
export function formatCoarseDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function formatCount(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatOsIcons(os?: string, arch?: string): string {
  const o = (os ?? "").toLowerCase();
  const a = (arch ?? "").toLowerCase();
  if (o === "darwin" || o === "macos" || o === "mac") {
    if (a === "arm64" || a === "aarch64") return "🍎🦾";
    if (a === "x64" || a === "x86_64" || a === "amd64" || a === "ia32" || a === "x86") {
      return "🍎🔷";
    }
    return "🍎";
  }
  if (o === "linux") return "🐧";
  if (o === "win32" || o === "windows" || o.startsWith("win")) return "🪟";
  return "";
}

/** Yellow only when half or more of the paired bridges are down. */
export function bridgesUnhealthy(paired: number, up: number): boolean {
  if (paired <= 0) return false;
  return (paired - up) / paired >= 0.5;
}

function unix(ms: number): number {
  return Math.floor(ms / 1000);
}

function agentIcons(agents: BridgeAgent[]): string {
  return agents
    .map((a) => (a.emoji && a.emoji.trim()) || a.id)
    .filter(Boolean)
    .join(" ");
}

function bridgeTimeGroup(b: BridgeStatusRow, nowUtc: number): string {
  if (b.connected && b.connectedAt != null) {
    return `⏱️ ${formatCoarseDuration(nowUtc - b.connectedAt)}`;
  }
  if (!b.connected) {
    const downFor =
      b.disconnectedAt != null ? ` ${formatCoarseDuration(nowUtc - b.disconnectedAt)}` : "";
    return `💤${downFor}`;
  }
  return "";
}

/** Field title is the status light + host emoji + name. */
export function bridgeFieldName(b: BridgeStatusRow): string {
  const light = b.connected ? "🟢" : "⚪";
  const host = hostEmoji({ emoji: b.emoji }, b.id);
  const name = hostShortName({ id: b.id, shortName: b.shortName }, b.id);
  return `${light} ${host} ${name}`.slice(0, 256);
}

/** Value is icon groups separated by dots: os · up/down · dev · agents · waiting. */
export function bridgeFieldValue(b: BridgeStatusRow, nowUtc: number): string {
  const waiting = b.waiting && b.waiting > 0 ? `📥 ${b.waiting} waiting` : "";
  const groups = [
    formatOsIcons(b.os, b.arch),
    bridgeTimeGroup(b, nowUtc),
    b.connected && b.devMode ? "⌨️" : "",
    agentIcons(b.agents),
    waiting,
  ].filter((g) => g.length > 0);
  return groups.join(" · ").slice(0, 1024) || "\u200B";
}

/**
 * Stamp last-known OS/arch/agents onto offline rows and keep a 💤 start time.
 * Mutates `bridges`. Returns the memory map to persist.
 */
export function rememberBridgeState(
  bridges: BridgeStatusRow[],
  memory: BridgeMemory,
  nowUtc: number
): BridgeMemory {
  const next: BridgeMemory = {};
  for (const b of bridges) {
    const prev = memory[b.id];
    if (b.connected) {
      next[b.id] = {
        ...(b.os ? { os: b.os } : {}),
        ...(b.arch ? { arch: b.arch } : {}),
        agents: b.agents,
      };
      continue;
    }
    const os = b.os ?? prev?.os;
    const arch = b.arch ?? prev?.arch;
    const agents = b.agents.length > 0 ? b.agents : (prev?.agents ?? []);
    const offlineSince = prev?.offlineSince ?? nowUtc;
    next[b.id] = {
      ...(os ? { os } : {}),
      ...(arch ? { arch } : {}),
      agents,
      offlineSince,
    };
    if (os) b.os = os;
    if (arch) b.arch = arch;
    b.agents = agents;
    b.disconnectedAt = offlineSince;
  }
  return next;
}

function headline(snap: ServerStatusSnapshot): { warn: boolean; title: string } {
  const paired = snap.bridges.length;
  const up = snap.bridges.filter((b) => b.connected).length;
  const warn = snap.restartPending || bridgesUnhealthy(paired, up);
  const icon = snap.restartPending ? "♻️" : warn ? "🟡" : "🟢";
  const bridgeTitle =
    paired === 0 ? "" : ` · ${up}/${paired} bridge${paired === 1 ? "" : "s"}`;
  const drain = snap.restartPending ? " · draining" : "";
  return { warn, title: `${icon} Seam${bridgeTitle}${drain}` };
}

function metricsLines(snap: ServerStatusSnapshot): string[] {
  const uptime = formatDuration(snap.nowUtc - snap.startedUtc);
  const ping =
    snap.discordPingMs != null ? `${snap.discordPingMs}ms` : "n/a";
  return [
    `**Uptime** ${uptime}`,
    `**Load** ${formatCount(snap.activeTurns, "turn")} · ${formatCount(snap.liveRuntimes, "runtime")} · ${formatCount(snap.sessions, "session")}`,
    `**Memory** ${formatBytes(snap.memoryRssBytes)} RSS · ${formatBytes(snap.memoryHeapUsedBytes)} heap`,
    `**Jobs** ${formatCount(snap.pendingWakes, "wake")} · ${formatCount(snap.pendingWatches, "watch", "watches")} · ${formatCount(snap.scheduledJobs, "schedule")}`,
    `**Gateway** ${ping} · **PID** \`${snap.pid}\``,
  ];
}

/** Components v2 tree: Container accent + TextDisplay + native Separator. */
export function renderServerStatusLayout(snap: ServerStatusSnapshot): StructuredLayout {
  const { warn, title } = headline(snap);
  const blocks: LayoutBlock[] = [
    { kind: "text", content: `**${title}**` },
    { kind: "text", content: `Updated <t:${unix(snap.nowUtc)}:R>` },
    { kind: "separator", divider: true, spacing: "small" },
    { kind: "text", content: metricsLines(snap).join("\n") },
  ];
  if (snap.bridges.length === 0) {
    blocks.push(
      { kind: "separator", divider: true, spacing: "large" },
      { kind: "text", content: "_none paired_" }
    );
  } else {
    snap.bridges.forEach((b, i) => {
      blocks.push({
        kind: "separator",
        divider: true,
        spacing: i === 0 ? "large" : "small",
      });
      const value = bridgeFieldValue(b, snap.nowUtc);
      const body = value === "\u200B" ? `**${bridgeFieldName(b)}**` : `**${bridgeFieldName(b)}**\n${value}`;
      blocks.push({ kind: "text", content: body });
    });
  }
  blocks.push(
    { kind: "separator", divider: false, spacing: "small" },
    {
      kind: "text",
      content: `-# node ${snap.nodeVersion} · every ${SERVER_STATUS_INTERVAL_MS / 1000}s`,
    }
  );
  return { color: warn ? COLOR_WARN : COLOR_OK, blocks };
}

export function renderServerStatusPanel(snap: ServerStatusSnapshot): StructuredPanel {
  const paired = snap.bridges.length;
  const { warn, title } = headline(snap);
  const uptime = formatDuration(snap.nowUtc - snap.startedUtc);
  const ping =
    snap.discordPingMs != null ? `${snap.discordPingMs}ms` : "n/a";

  const metricFields: StructuredPanel["fields"] = [
    {
      name: "Uptime",
      value: uptime,
      inline: true,
    },
    {
      name: "Load",
      value: [
        formatCount(snap.activeTurns, "turn"),
        formatCount(snap.liveRuntimes, "runtime"),
        formatCount(snap.sessions, "session"),
      ].join("\n"),
      inline: true,
    },
    {
      name: "Memory",
      value: `${formatBytes(snap.memoryRssBytes)} RSS\n${formatBytes(snap.memoryHeapUsedBytes)} heap`,
      inline: true,
    },
    {
      name: "Jobs",
      value: [
        formatCount(snap.pendingWakes, "wake"),
        formatCount(snap.pendingWatches, "watch", "watches"),
        formatCount(snap.scheduledJobs, "schedule"),
      ].join("\n"),
      inline: true,
    },
    {
      name: "Gateway",
      value: ping,
      inline: true,
    },
    {
      name: "PID",
      value: `\`${snap.pid}\``,
      inline: true,
    },
  ];

  const bridgeFields: StructuredPanel["fields"] =
    paired === 0
      ? [{ name: "Bridges", value: "_none paired_", inline: false }]
      : snap.bridges.slice(0, 25 - metricFields.length).map((b) => ({
          name: bridgeFieldName(b),
          value: bridgeFieldValue(b, snap.nowUtc),
          inline: false,
        }));

  return {
    color: warn ? COLOR_WARN : COLOR_OK,
    title,
    description: `Updated <t:${unix(snap.nowUtc)}:R>`,
    fields: [...metricFields, ...bridgeFields],
    footer: `node ${snap.nodeVersion} · every ${SERVER_STATUS_INTERVAL_MS / 1000}s`,
  };
}
