/**
 * One editable Discord status card for the control plane + paired bridges.
 * Posts once, then edits in place on a 30s tick and on bridge connect/drop.
 */
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../lib/logger.js";
import type { StructuredPanel } from "./types.js";
import type { ChatAdapter, MessageRef } from "../platforms/chat-adapter.js";
import {
  SERVER_STATUS_INTERVAL_MS,
  rememberBridgeState,
  renderServerStatusLayout,
  renderServerStatusPanel,
  type BridgeMemory,
  type ServerStatusSnapshot,
} from "./server-status.js";

const STATE_FILE = "server-status-card.json";
const DEBOUNCE_MS = 500;

type Persisted = {
  threadId: string;
  messageId: string;
  lastSeen?: BridgeMemory;
};

function isUnknownMessage(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code: unknown }).code;
  return code === 10008 || code === 10003;
}

export class ServerStatusCard {
  private readonly logger: Logger;
  private readonly adapter: ChatAdapter;
  private readonly threadId: string;
  private readonly dataDir: string;
  private readonly collect: () => ServerStatusSnapshot;
  private readonly intervalMs: number;
  private readonly channel = { platform: "discord", id: "" };

  private message: MessageRef | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private dirty = false;
  private stopped = false;
  private pinned = false;
  private lastSeen: BridgeMemory = {};

  constructor(opts: {
    logger: Logger;
    adapter: ChatAdapter;
    threadId: string;
    dataDir: string;
    collect: () => ServerStatusSnapshot;
    intervalMs?: number;
  }) {
    this.logger = opts.logger.child({ comp: "server-status" });
    this.adapter = opts.adapter;
    this.threadId = opts.threadId;
    this.dataDir = opts.dataDir;
    this.collect = opts.collect;
    this.intervalMs = opts.intervalMs ?? SERVER_STATUS_INTERVAL_MS;
    this.channel.id = opts.threadId;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.loadState();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
  }

  /** Event-driven bump (bridge connect/disconnect). Debounced. */
  poke(): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.tick(), DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  /** Immediate collect+push. Interval and tests call this; `poke` debounces it. */
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
      this.logger.warn({ err }, "status card refresh failed");
    } finally {
      this.inFlight = false;
      if (this.dirty) {
        this.dirty = false;
        void this.tick();
      }
    }
  }

  private async push(): Promise<void> {
    const snap = this.collect();
    this.lastSeen = rememberBridgeState(snap.bridges, this.lastSeen, snap.nowUtc);
    if (this.adapter.sendLayout && this.adapter.editLayout) {
      await this.pushLayout(renderServerStatusLayout(snap));
      return;
    }
    if (!this.adapter.sendPanel || !this.adapter.editPanel) {
      this.logger.warn("status card skipped: adapter has no sendLayout/sendPanel");
      return;
    }
    await this.pushPanel(renderServerStatusPanel(snap));
  }

  private async pushLayout(
    layout: import("./types.js").StructuredLayout
  ): Promise<void> {
    if (this.message) {
      try {
        await this.adapter.editLayout!(this.message, layout);
        this.persist();
        await this.ensurePinned();
        return;
      } catch (err) {
        // Unknown message, or an old embed that cannot take the v2 flag.
        this.logger.info({ err }, "status card v2 edit failed; posting a new one");
        const stale = this.message;
        this.message = undefined;
        this.pinned = false;
        const sent = await this.adapter.sendLayout!(this.channel, layout);
        this.message = sent;
        this.persist();
        await this.ensurePinned();
        if (stale && this.adapter.deleteMessage) {
          await this.adapter.deleteMessage(stale).catch(() => {});
        }
        return;
      }
    }
    const sent = await this.adapter.sendLayout!(this.channel, layout);
    this.message = sent;
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
        if (!isUnknownMessage(err)) throw err;
        this.logger.info("status card message gone; posting a new one");
        this.message = undefined;
        this.pinned = false;
      }
    }
    const sent = await this.adapter.sendPanel!(this.channel, panel);
    this.message = sent;
    this.persist();
    await this.ensurePinned();
  }

  private async ensurePinned(): Promise<void> {
    if (this.pinned || !this.message || !this.adapter.pinMessage) return;
    try {
      await this.adapter.pinMessage(this.message);
      this.pinned = true;
    } catch (err) {
      this.logger.warn({ err }, "status card pin failed");
    }
  }

  private statePath(): string {
    return path.join(this.dataDir, STATE_FILE);
  }

  private loadState(): void {
    try {
      const raw = fs.readFileSync(this.statePath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      if (parsed.lastSeen && typeof parsed.lastSeen === "object") {
        this.lastSeen = parsed.lastSeen;
      }
      if (parsed.threadId !== this.threadId || !parsed.messageId) return;
      this.message = {
        channel: { platform: "discord", id: this.threadId },
        id: parsed.messageId,
      };
    } catch {
      /* first run — nothing to restore */
    }
  }

  private persist(): void {
    if (!this.message) return;
    try {
      const body: Persisted = {
        threadId: this.threadId,
        messageId: this.message.id,
        lastSeen: this.lastSeen,
      };
      fs.writeFileSync(this.statePath(), JSON.stringify(body));
    } catch (err) {
      this.logger.warn({ err }, "failed to persist status card state");
    }
  }
}
