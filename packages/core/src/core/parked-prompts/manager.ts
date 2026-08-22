/**
 * ParkedPromptManager — event-driven delivery for #88.
 *
 * No timer: D3 has no due time. Subscribe to `BridgeHub.onBridgeReady` and
 * fire every parked row for that host. On start, fire any row whose host is
 * already ready (boot rehydrate after `npm run redeploy`).
 *
 * Delete-before-fire (same as wakes): a crash mid-inject loses the park
 * rather than running it twice.
 */
import type { SessionStore } from "../session-store.js";
import type { ParkedPrompt } from "./types.js";
import type { Logger } from "../../lib/logger.js";

export interface ParkedBridgeHub {
  isBridgeReady(bridgeId: string): boolean;
  onBridgeReady(listener: (bridgeId: string) => void): () => void;
}

export interface ParkedPromptManagerOpts {
  store: SessionStore;
  hub: ParkedBridgeHub;
  onFire: (parked: ParkedPrompt) => Promise<void>;
  logger: Logger;
  /**
   * #89: skip (do not delete) a row whose thread still has a live turn.
   * `onBridgeReady` must not convert a D9-cancellable parked queue into an
   * in-flight dispatch; turn-end `tryFireParked` fires it when the channel
   * is free. Absent ⇒ fire every ready-host row (boot rehydrate: queues are
   * empty after a restart).
   */
  isChannelBusy?: (channelRef: string) => boolean;
}

export class ParkedPromptManager {
  private readonly store: SessionStore;
  private readonly hub: ParkedBridgeHub;
  private readonly onFire: (parked: ParkedPrompt) => Promise<void>;
  private readonly logger: Logger;
  private readonly isChannelBusy?: (channelRef: string) => boolean;
  private offReady?: () => void;
  private readonly firing = new Set<string>();

  constructor(opts: ParkedPromptManagerOpts) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.onFire = opts.onFire;
    this.logger = opts.logger;
    this.isChannelBusy = opts.isChannelBusy;
  }

  start(): void {
    this.offReady = this.hub.onBridgeReady((id) => {
      void this.fireLocation(id);
    });
    void this.rehydrate();
    this.logger.info("parked-prompt manager started");
  }

  stop(): void {
    this.offReady?.();
    this.offReady = undefined;
  }

  /**
   * Boot: any parked row whose host is already ready fires now; the rest wait
   * on `onBridgeReady`. Event-driven — no sweep interval.
   */
  async rehydrate(): Promise<void> {
    try {
      const pending = this.store.listParked();
      const locations = new Set(pending.map((p) => p.location));
      for (const loc of locations) {
        if (this.hub.isBridgeReady(loc)) await this.fireLocation(loc);
      }
    } catch (err) {
      this.logger.warn({ err }, "parked-prompt rehydrate failed");
    }
  }

  /**
   * Fire every parked prompt for `location`. No-op if the host is not ready
   * (ready-flap: hello then immediate disconnect). Serialized per location so
   * a double ready event cannot double-deliver.
   */
  async fireLocation(location: string): Promise<void> {
    if (this.firing.has(location)) return;
    this.firing.add(location);
    try {
      if (!this.hub.isBridgeReady(location)) return;
      const rows = this.store.listParkedByLocation(location);
      for (const parked of rows) {
        if (this.isChannelBusy?.(parked.channelRef)) {
          this.logger.info(
            { id: parked.id, channel: parked.channelRef, location },
            "parked-prompt: host ready but thread still busy; leaving row for turn-end"
          );
          continue;
        }
        this.store.deleteParked(parked.id);
        try {
          await this.onFire(parked);
        } catch (err) {
          this.logger.error({ id: parked.id, err }, "parked-prompt fire failed");
        }
      }
    } catch (err) {
      this.logger.warn({ err, location }, "parked-prompt fireLocation failed");
    } finally {
      this.firing.delete(location);
    }
  }
}
