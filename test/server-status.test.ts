import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import {
  bridgesUnhealthy,
  formatBytes,
  formatCoarseDuration,
  formatCount,
  formatDuration,
  formatOsIcons,
  rememberBridgeState,
  renderServerStatusLayout,
  renderServerStatusPanel,
  SERVER_STATUS_INTERVAL_MS,
  type ServerStatusSnapshot,
} from "../packages/core/src/core/server-status.js";
import { ServerStatusCard } from "../packages/core/src/core/server-status-card.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";
import type {
  ChatAdapter,
  ChannelRef,
  MessageRef,
} from "../packages/core/src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const NOW = Date.parse("2026-08-20T18:00:00.000Z");
const STARTED = Date.parse("2026-08-20T16:00:00.000Z");

function snap(over: Partial<ServerStatusSnapshot> = {}): ServerStatusSnapshot {
  return {
    nowUtc: NOW,
    startedUtc: STARTED,
    pid: 4242,
    nodeVersion: "v22.14.0",
    memoryRssBytes: 187 * 1024 * 1024,
    memoryHeapUsedBytes: 62 * 1024 * 1024,
    activeTurns: 1,
    liveRuntimes: 3,
    sessions: 12,
    pendingWakes: 2,
    pendingWatches: 1,
    scheduledJobs: 4,
    restartPending: false,
    discordPingMs: 38,
    bridges: [],
    ...over,
  };
}

describe("server-status formatters", () => {
  it("formatDuration covers seconds through days", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_600_000 + 120_000)).toBe("1h 2m");
    expect(formatDuration(2 * 86_400_000 + 3_600_000)).toBe("2d 1h 0m");
  });

  it("formatBytes and formatCount", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(187 * 1024 * 1024)).toBe("187 MB");
    expect(formatCount(1, "turn")).toBe("1 turn");
    expect(formatCount(2, "turn")).toBe("2 turns");
    expect(formatCount(1, "watch", "watches")).toBe("1 watch");
    expect(formatCount(2, "watch", "watches")).toBe("2 watches");
  });

  it("formatCoarseDuration never shows seconds", () => {
    expect(formatCoarseDuration(5_000)).toBe("<1m");
    expect(formatCoarseDuration(90_000)).toBe("1m");
    expect(formatCoarseDuration(3_600_000 + 120_000)).toBe("1h 2m");
    expect(formatCoarseDuration(2 * 86_400_000 + 3_600_000)).toBe("2d 1h");
  });

  it("formatOsIcons maps platform + arch", () => {
    expect(formatOsIcons("darwin", "arm64")).toBe("🍎🦾");
    expect(formatOsIcons("darwin", "x64")).toBe("🍎🔷");
    expect(formatOsIcons("linux", "x64")).toBe("🐧");
    expect(formatOsIcons("win32", "x64")).toBe("🪟");
  });

  it("bridgesUnhealthy is false below 50% down", () => {
    expect(bridgesUnhealthy(0, 0)).toBe(false);
    expect(bridgesUnhealthy(3, 2)).toBe(false);
    expect(bridgesUnhealthy(2, 1)).toBe(true);
    expect(bridgesUnhealthy(1, 0)).toBe(true);
  });
});

describe("renderServerStatusPanel", () => {
  it("is green with no paired bridges", () => {
    const panel = renderServerStatusPanel(snap());
    expect(panel.color).toBe(0x57f287);
    expect(panel.title).toBe("🟢 Seam");
    expect(panel.description).toBe(`Updated <t:${Math.floor(NOW / 1000)}:R>`);
    expect(panel.fields.find((f) => f.name === "Uptime")!.value).toBe("2h 0m");
    expect(panel.fields.find((f) => f.name === "Uptime")!.value).not.toContain("started");
    expect(panel.fields.find((f) => f.name === "Load")!.value).toContain("1 turn");
    expect(panel.fields.find((f) => f.name === "Load")!.value).toContain("3 runtimes");
    expect(panel.fields.find((f) => f.name === "Bridges")!.value).toBe("_none paired_");
    expect(panel.footer).toContain(`every ${SERVER_STATUS_INTERVAL_MS / 1000}s`);
  });

  it("iconizes a live bridge as its own field (light+name title, dotted groups)", () => {
    const ok = renderServerStatusPanel(
      snap({
        bridges: [
          {
            id: "mac",
            emoji: "💻",
            connected: true,
            os: "darwin",
            arch: "arm64",
            connectedAt: NOW - 12 * 60_000,
            agents: [
              { id: "grok", emoji: "🐺" },
              { id: "claude", emoji: "👾" },
            ],
            devMode: true,
          },
        ],
      })
    );
    expect(ok.color).toBe(0x57f287);
    expect(ok.title).toBe("🟢 Seam · 1/1 bridge");
    const field = ok.fields.find((f) => f.name.includes("mac"));
    expect(field?.name).toBe("🟢 💻 mac");
    expect(field?.inline).toBe(false);
    expect(field?.value).toBe("🍎🦾 · ⏱️ 12m · ⌨️ · 🐺 👾");
    expect(ok.fields.some((f) => f.name === "Bridges")).toBe(false);
  });

  it("appends 📥 N waiting when a host has parked threads (#88 D7)", () => {
    const panel = renderServerStatusPanel(
      snap({
        bridges: [
          {
            id: "mac",
            emoji: "💻",
            connected: false,
            os: "darwin",
            arch: "arm64",
            disconnectedAt: NOW - 60_000,
            agents: [{ id: "claude", emoji: "👾" }],
            waiting: 2,
          },
        ],
      })
    );
    const field = panel.fields.find((f) => f.name.includes("mac"));
    expect(field?.value).toContain("📥 2 waiting");
    const none = renderServerStatusPanel(
      snap({
        bridges: [
          {
            id: "mac",
            connected: true,
            agents: [],
            connectedAt: NOW,
            waiting: 0,
          },
        ],
      })
    );
    expect(none.fields.find((f) => f.name.includes("mac"))?.value).not.toContain("waiting");
  });

  it("uses a grey light + 💤 duration for an offline bridge; yellow only at ≥50% down", () => {
    const oneOfThree = renderServerStatusPanel(
      snap({
        bridges: [
          { id: "mac", connected: true, agents: [], connectedAt: NOW },
          { id: "media-server", connected: false, agents: [], disconnectedAt: NOW - 3 * 3600_000 },
          { id: "office", connected: true, agents: [], connectedAt: NOW },
        ],
      })
    );
    expect(oneOfThree.color).toBe(0x57f287);
    expect(oneOfThree.title).toBe("🟢 Seam · 2/3 bridges");
    const down = oneOfThree.fields.find((f) => f.name.includes("media-server"));
    expect(down?.name.startsWith("⚪")).toBe(true);
    expect(down?.value).toContain("💤 3h");
    expect(down?.value).not.toContain("offline");
    expect(oneOfThree.fields.filter((f) => f.name.startsWith("🟢") || f.name.startsWith("⚪"))).toHaveLength(3);

    const half = renderServerStatusPanel(
      snap({
        bridges: [
          { id: "mac", connected: true, agents: [], connectedAt: NOW },
          { id: "media-server", connected: false, agents: [] },
        ],
      })
    );
    expect(half.color).toBe(0xfaa61a);
    expect(half.title).toBe("🟡 Seam · 1/2 bridges");
  });

  it("v2 layout uses Discord Separator blocks between bridges", () => {
    const layout = renderServerStatusLayout(
      snap({
        bridges: [
          {
            id: "mac",
            emoji: "💻",
            connected: true,
            os: "darwin",
            arch: "arm64",
            connectedAt: NOW - 12 * 60_000,
            agents: [{ id: "claude", emoji: "👾" }],
            devMode: true,
          },
          {
            id: "media-server",
            connected: false,
            agents: [],
            disconnectedAt: NOW - 3 * 3600_000,
          },
        ],
      })
    );
    expect(layout.color).toBe(0xfaa61a);
    const texts = layout.blocks.filter((b) => b.kind === "text");
    const seps = layout.blocks.filter((b) => b.kind === "separator");
    expect(texts.some((b) => b.kind === "text" && b.content.includes("**🟡 Seam · 1/2 bridges**"))).toBe(
      true
    );
    expect(
      texts.some(
        (b) =>
          b.kind === "text" &&
          b.content.includes("**🟢 💻 mac**") &&
          b.content.includes("🍎🦾 · ⏱️ 12m · ⌨️ · 👾")
      )
    ).toBe(true);
    expect(
      texts.some((b) => b.kind === "text" && b.content.includes("media-server") && b.content.includes("💤 3h"))
    ).toBe(true);
    expect(seps.some((b) => b.kind === "separator" && b.divider === true && b.spacing === "large")).toBe(
      true
    );
    expect(seps.filter((b) => b.kind === "separator" && b.divider === true).length).toBeGreaterThanOrEqual(3);
  });

  it("rememberBridgeState stamps 💤 start and last-known OS onto an offline row", () => {
    const bridges = [
      { id: "mac", connected: false, agents: [] as { id: string }[] },
    ];
    const memory = rememberBridgeState(
      bridges,
      { mac: { os: "linux", arch: "x64", agents: [{ id: "grok", emoji: "🐺" }] } },
      NOW
    );
    expect(bridges[0]!.os).toBe("linux");
    expect(bridges[0]!.arch).toBe("x64");
    expect(bridges[0]!.disconnectedAt).toBe(NOW);
    expect(bridges[0]!.agents[0]!.emoji).toBe("🐺");
    expect(memory.mac?.offlineSince).toBe(NOW);
    const again = rememberBridgeState(bridges, memory, NOW + 60_000);
    expect(again.mac?.offlineSince).toBe(NOW);
  });

  it("marks a draining restart", () => {
    const panel = renderServerStatusPanel(snap({ restartPending: true }));
    expect(panel.color).toBe(0xfaa61a);
    expect(panel.title).toContain("draining");
  });
});

describe("ServerStatusCard", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-status-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function mockAdapter() {
    const calls = {
      sendPanel: [] as StructuredPanel[],
      editPanel: [] as StructuredPanel[],
      pinMessage: [] as string[],
    };
    const adapter: Pick<ChatAdapter, "platform" | "sendPanel" | "editPanel"> & {
      start: ChatAdapter["start"];
      stop: ChatAdapter["stop"];
      sendMessage: ChatAdapter["sendMessage"];
      editMessage: ChatAdapter["editMessage"];
    } = {
      platform: "discord",
      async start() {},
      async stop() {},
      async sendMessage() {
        return { channel: { platform: "discord", id: "t" }, id: "x" };
      },
      async editMessage() {},
      async sendPanel(_channel: ChannelRef, panel: StructuredPanel): Promise<MessageRef> {
        calls.sendPanel.push(panel);
        return { channel: { platform: "discord", id: "t" }, id: `msg-${calls.sendPanel.length}` };
      },
      async editPanel(_ref: MessageRef, panel: StructuredPanel): Promise<void> {
        calls.editPanel.push(panel);
      },
      async pinMessage(ref: MessageRef): Promise<void> {
        calls.pinMessage.push(ref.id);
      },
    };
    return { adapter: adapter as ChatAdapter, calls };
  }

  it("posts once then edits the same message", async () => {
    const { adapter, calls } = mockAdapter();
    const card = new ServerStatusCard({
      logger: silent,
      adapter,
      threadId: "1540213090480558120",
      dataDir: dir,
      collect: () => snap({ activeTurns: 0 }),
      intervalMs: 60_000,
    });
    await card.start();
    expect(calls.sendPanel).toHaveLength(1);
    expect(calls.editPanel).toHaveLength(0);
    expect(calls.pinMessage).toEqual(["msg-1"]);
    await card.tick();
    expect(calls.sendPanel).toHaveLength(1);
    expect(calls.editPanel).toHaveLength(1);
    expect(calls.pinMessage).toEqual(["msg-1"]);
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "server-status-card.json"), "utf8")
    ) as { threadId: string; messageId: string };
    expect(saved.threadId).toBe("1540213090480558120");
    expect(saved.messageId).toBe("msg-1");
    card.stop();
  });

  it("reposts when the stored message is gone (10008)", async () => {
    fs.writeFileSync(
      path.join(dir, "server-status-card.json"),
      JSON.stringify({ threadId: "1540213090480558120", messageId: "old" })
    );
    const { adapter, calls } = mockAdapter();
    const origEdit = adapter.editPanel!;
    adapter.editPanel = async (ref, panel) => {
      if (ref.id === "old") {
        const err = Object.assign(new Error("Unknown Message"), { code: 10008 });
        throw err;
      }
      return origEdit(ref, panel);
    };
    const card = new ServerStatusCard({
      logger: silent,
      adapter,
      threadId: "1540213090480558120",
      dataDir: dir,
      collect: () => snap(),
      intervalMs: 60_000,
    });
    await card.start();
    expect(calls.sendPanel).toHaveLength(1);
    card.stop();
  });
});
