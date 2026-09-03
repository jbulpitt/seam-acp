import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../packages/core/src/config.js";
import {
  SERVICE_STATUS_BUMP_AFTER_MS,
  SERVICE_STATUS_REFRESH_CUSTOM_ID,
  ServiceStatusCard,
  renderServiceStatusLayout,
  renderServiceStatusPanel,
} from "../packages/core/src/core/service-status-card.js";
import type {
  RefreshResult,
} from "../packages/core/src/core/service-status/manager.js";
import type {
  ServiceObservationHealth,
  ServiceStatusLevel,
  ServiceStatusSnapshot,
  ServiceStatusSourceDefinition,
} from "../packages/core/src/core/service-status/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type {
  ChannelRef,
  ChatAdapter,
  ComponentEvent,
  MessageRef,
} from "../packages/core/src/platforms/chat-adapter.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { StructuredLayout } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const NOW = "2026-09-03T20:00:00.000Z";

function source(id: string, label = id): ServiceStatusSourceDefinition {
  return {
    id,
    label,
    provenance: id === "linkworks-ollama" ? "external_synthetic" : "official",
    homepage: `https://status.example/${id}`,
    scopeNote: id === "linkworks-ollama" ? "Not official Ollama Cloud status." : "Official.",
    async fetch() { throw new Error("unused"); },
  };
}

function snapshot(
  id: string,
  status: ServiceStatusLevel,
  health: ServiceObservationHealth = "ok"
): ServiceStatusSnapshot {
  const reportedAt = health === "never_fetched" ? null : "2026-09-03T19:55:00.000Z";
  return {
    sourceId: id,
    label: id === "google-ai-studio" ? "Google AI Studio" : id === "google-cloud" ? "Google Cloud" : id,
    provenance: id === "linkworks-ollama" ? "external_synthetic" : "official",
    baseline: { status, description: null, derived: false },
    effectiveStatus: status,
    reportedAt,
    observation: {
      health,
      lastAttemptAt: health === "never_fetched" ? null : NOW,
      lastSuccessAt: reportedAt,
      lastErrorAt: health === "fetch_error" ? NOW : null,
      lastError: health === "fetch_error" ? "upstream timeout" : null,
      consecutiveFailures: health === "fetch_error" ? 1 : 0,
      lastDurationMs: 25,
    },
    components: [],
    incidents: [],
    notes: [],
  };
}

function layoutText(layout: StructuredLayout): string {
  return layout.blocks.map((block) => block.kind === "text" ? block.content : "").join("\n");
}

describe("service status card rendering", () => {
  it("renders operational, maintenance, degradation, and outage independently", () => {
    const snapshots = [
      snapshot("openai", "operational"),
      snapshot("anthropic", "maintenance"),
      snapshot("xai", "degraded"),
      snapshot("github", "major_outage"),
    ];
    const layout = renderServiceStatusLayout(snapshots, snapshots.map((item) => source(item.sourceId)));
    const text = layoutText(layout);
    expect(text).toContain("🟢 Operational");
    expect(text).toContain("🔵 Maintenance");
    expect(text).toContain("🟡 Degraded");
    expect(text).toContain("🔴 Major outage");
    expect(layout.color).toBe(0xed4245);
    expect((layout.actions ?? []).flat().map((button) => button.customId)).toContain(
      SERVICE_STATUS_REFRESH_CUSTOM_ID
    );
  });

  it("shows stale, fetch-error, and no-data observations as unknown—not live outages", () => {
    const snapshots = [
      snapshot("stale", "major_outage", "stale"),
      snapshot("error", "major_outage", "fetch_error"),
      snapshot("empty", "unknown", "never_fetched"),
      snapshot("fresh", "operational", "ok"),
    ];
    const layout = renderServiceStatusLayout(snapshots, snapshots.map((item) => source(item.sourceId)));
    const text = layoutText(layout);
    expect(text).toContain("⚪ Stale observation · last reported major outage");
    expect(text).toContain("⚪ Source error · last reported major outage");
    expect(text).toContain("⚪ No data");
    expect(layout.color).toBe(0x57f287);
  });

  it("keeps Google surfaces separate and labels Linkworks as external synthetic", () => {
    const snapshots = [
      snapshot("google-ai-studio", "operational"),
      snapshot("google-cloud", "operational"),
      snapshot("linkworks-ollama", "degraded"),
    ];
    const layout = renderServiceStatusLayout(snapshots, snapshots.map((item) => source(item.sourceId, item.label)));
    const text = layoutText(layout);
    expect(text).toContain("Google AI Studio");
    expect(text).toContain("Google Cloud");
    expect(text).toContain("External synthetic probe · not official Ollama Cloud status");
  });

  it("bounds incident/component content within Discord layout and panel limits", () => {
    const item = snapshot("openai", "major_outage");
    item.components = Array.from({ length: 20 }, (_, index) => ({
      id: `c${String(index)}`,
      name: `component-${String(index)}-${"x".repeat(200)}`,
      status: "major_outage",
      description: null,
      groupId: null,
      isGroup: false,
      selected: true,
      position: index,
      updatedAt: NOW,
    }));
    item.incidents = [{
      sourceId: "openai",
      externalId: "i1",
      title: `@everyone ${"y".repeat(2_000)}`,
      stage: "active",
      lifecycle: "investigating",
      resolutionSource: "none",
      impact: "major_outage",
      url: "https://status.example/incidents/i1",
      startedAt: NOW,
      updatedAt: NOW,
      resolvedAt: null,
      componentIds: ["c1"],
      updates: [],
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    }];
    const sources = [source("openai")];
    const layout = renderServiceStatusLayout([item], sources);
    const row = layoutText(layout);
    expect(row).not.toContain("@everyone");
    expect(row).toContain("＋17 more");
    expect(layout.blocks.filter((block) => block.kind === "text").every((block) => block.kind !== "text" || block.content.length <= 760)).toBe(true);
    const panel = renderServiceStatusPanel(Array.from({ length: 30 }, (_, i) => ({ ...item, sourceId: `s${String(i)}`, label: `s${String(i)}` })), sources);
    expect(panel.fields.length).toBeLessThanOrEqual(25);
    expect(panel.fields.every((field) => field.name.length <= 256 && field.value.length <= 1_024)).toBe(true);
    const total = (panel.title?.length ?? 0) + (panel.description?.length ?? 0) + panel.fields.reduce((n, field) => n + field.name.length + field.value.length, 0);
    expect(total).toBeLessThanOrEqual(6_000);
  });
});

describe("service status card lifecycle", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "service-status-card-"));
    dirs.push(dir);
    return dir;
  }

  it("edits the persisted message, pins it, and silently bumps after 20 hours", async () => {
    const dir = tempDir();
    const now = 2_000_000_000_000;
    fs.writeFileSync(path.join(dir, "service-status-card.json"), JSON.stringify({
      threadId: "123", messageId: "existing", lastBumpAt: now - SERVICE_STATUS_BUMP_AFTER_MS - 1,
    }));
    const calls = { edits: 0, sends: 0, pins: 0, bumps: 0 };
    const adapter = {
      platform: "discord", async start() {}, async stop() {},
      async sendMessage(channel: ChannelRef): Promise<MessageRef> { return { channel, id: "plain" }; },
      async editMessage() {},
      async sendLayout(channel: ChannelRef): Promise<MessageRef> { calls.sends += 1; return { channel, id: "new" }; },
      async editLayout() { calls.edits += 1; },
      async pinMessage() { calls.pins += 1; },
      async bumpThread() { calls.bumps += 1; },
    } as ChatAdapter;
    const card = new ServiceStatusCard({ logger: silent, adapter, threadId: "123", dataDir: dir, sources: [source("x")], collect: () => [snapshot("x", "operational")], now: () => now });
    await card.start();
    expect(calls).toEqual({ edits: 1, sends: 0, pins: 1, bumps: 1 });
    card.stop();
  });

  it("recreates a deleted card and coalesces rapid update pokes", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "service-status-card.json"), JSON.stringify({ threadId: "123", messageId: "gone", lastBumpAt: Date.now() }));
    let edits = 0;
    let sends = 0;
    let deletes = 0;
    const adapter = {
      platform: "discord", async start() {}, async stop() {},
      async sendMessage(channel: ChannelRef): Promise<MessageRef> { return { channel, id: "plain" }; },
      async editMessage() {},
      async sendLayout(channel: ChannelRef): Promise<MessageRef> { sends += 1; return { channel, id: "replacement" }; },
      async editLayout() { edits += 1; if (edits === 1) throw Object.assign(new Error("gone"), { code: 10008 }); },
      async deleteMessage() { deletes += 1; },
      async pinMessage() {},
    } as ChatAdapter;
    const card = new ServiceStatusCard({ logger: silent, adapter, threadId: "123", dataDir: dir, sources: [source("x")], collect: () => [snapshot("x", "operational")] });
    await card.start();
    expect({ sends, deletes }).toEqual({ sends: 1, deletes: 1 });
    card.poke(); card.poke(); card.poke();
    await vi.advanceTimersByTimeAsync(500);
    expect(edits).toBe(2);
    card.stop();
  });
});

describe("service status refresh interaction", () => {
  it("routes the configured card button to the shared forced-refresh callback", async () => {
    const replies: string[] = [];
    const result: RefreshResult = {
      outcome: "succeeded", startedAt: NOW, durationMs: 20,
      sources: [{ sourceId: "x", disposition: "executed", attempted: true, succeeded: true, durationMs: 20, error: null, reason: null, observation: null, snapshot: null }],
    };
    const refresh = vi.fn(async () => result);
    const host = Object.assign(Object.create(Orchestrator.prototype) as object, {
      config: { DISCORD_SERVICE_STATUS_THREAD_ID: "123" },
      logger: silent,
      serviceStatusRefresh: refresh,
    }) as { handleServiceStatusCardComponent(evt: ComponentEvent): Promise<void> };
    await host.handleServiceStatusCardComponent({
      customId: SERVICE_STATUS_REFRESH_CUSTOM_ID,
      channel: { platform: "discord", id: "123" },
      replyEphemeral: async (text) => { replies.push(text); },
      editReplyEphemeral: async (text) => { replies.push(text); },
    } as ComponentEvent);
    expect(refresh).toHaveBeenCalledOnce();
    expect(replies).toEqual(["Refreshing upstream service status…", "Service status refreshed (1 sources)."]);
  });
});

describe("DISCORD_SERVICE_STATUS_THREAD_ID", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("accepts a numeric Discord id and rejects names", () => {
    process.env = { ...saved, DISCORD_BOT_TOKEN: "test", DISCORD_ALLOWED_USER_IDS: "123", REPOS_ROOT: process.cwd(), CHANNEL_PRESETS_FILE: undefined, DISCORD_SERVICE_STATUS_THREAD_ID: "1545197204208222309" } as NodeJS.ProcessEnv;
    expect(loadConfig().DISCORD_SERVICE_STATUS_THREAD_ID).toBe("1545197204208222309");
    process.env.DISCORD_SERVICE_STATUS_THREAD_ID = "status-thread";
    expect(() => loadConfig()).toThrow(/DISCORD_SERVICE_STATUS_THREAD_ID/);
  });
});
