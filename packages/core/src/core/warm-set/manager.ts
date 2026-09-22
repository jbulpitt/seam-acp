/**
 * Controller-side warm-set (#452).
 *
 * Enumerates on the controller (`listSessionsForHost` over presets + sessions)
 * and loads through the existing resume path. The daemon is not told thread
 * config — four of eight hosts cannot be updated through rollout, and the
 * manifesto says it is not authoritative for that fact.
 *
 * Opt-in: a host that is not in `WARM_SET_HOSTS` is never ticked. Failures
 * are free reconnaissance — log, mark cold, do not retry, never a user notice.
 */
import type { Logger } from "../../lib/logger.js";
import type { SessionStore } from "../session-store.js";
import type { SessionRouter } from "../session-router.js";
import type { SessionRecord } from "../types.js";
import { listSessionsForHost } from "../host-sessions.js";
import { isLocalLocation, normalizeLocation } from "../location.js";
import type { WarmSetHostOpt } from "./hosts.js";
import { BoundPool } from "./pool.js";
import { selectWarmSet, type WarmCandidate } from "./select.js";
import { loadCost } from "./footprint.js";
import type { RemoteRecoverySnapshot } from "@seam/adapters";

export interface SlotHealthFact {
  slot: number;
  alive: boolean;
  pid: number | null;
  lastStdoutMsAgo: number | null;
  lastStdinMsAgo: number | null;
  recovery?: RemoteRecoverySnapshot;
}

export interface WarmSetHub {
  isBridgeReady(location: string): boolean;
  slotHealthFor?(location: string): readonly SlotHealthFact[];
}

export interface WarmSetRouter {
  hasRuntime(sessionId: string): boolean;
  turnHealth(sessionId: string, nowMs?: number): { busy: boolean; silentMs: number; stalled: boolean };
  getRuntime(sessionId: string): { markActivity(): void; getSlot?(): number | undefined } | undefined;
  isBusy(sessionId: string): boolean;
  resumeExistingSession(record: SessionRecord): Promise<unknown>;
  invalidate(sessionId: string, opts?: { clearAcpSession?: boolean }): Promise<void>;
}

export class WarmSetManager {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private ticking = false;
  private readonly cold = new Map<string, string>();
  private readonly pool: BoundPool;

  constructor(
    private readonly opts: {
      logger: Logger;
      store: SessionStore;
      router: WarmSetRouter;
      hub: WarmSetHub;
      threadPresets: ReadonlyMap<string, { location?: string }>;
      hosts: readonly WarmSetHostOpt[];
      intervalMs: number;
      maxConcurrent: number;
    },
  ) {
    this.pool = new BoundPool(opts.maxConcurrent);
  }

  start(): void {
    if (this.opts.hosts.length === 0) return;
    this.stopped = false;
    this.opts.logger.info(
      { hosts: this.opts.hosts.map((h) => h.id), intervalMs: this.opts.intervalMs, maxConcurrent: this.opts.maxConcurrent },
      "warm-set started",
    );
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async drain(): Promise<void> {
    this.stop();
    const deadline = Date.now() + 10_000;
    while (this.ticking && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Test/diagnostic: run one pass. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking || this.opts.hosts.length === 0) return;
    this.ticking = true;
    try {
      const sessions = this.opts.store.listSessionsUncapped();
      for (const host of this.opts.hosts) {
        if (this.stopped) return;
        await this.tickHost(host, sessions);
      }
    } catch (err) {
      this.opts.logger.warn({ err }, "warm-set tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private async tickHost(host: WarmSetHostOpt, sessions: SessionRecord[]): Promise<void> {
    const location = normalizeLocation(host.id);
    if (!isLocalLocation(location) && !this.opts.hub.isBridgeReady(location)) {
      this.opts.logger.debug({ location }, "warm-set: host not ready");
      return;
    }
    const owned = listSessionsForHost(location, {
      threadPresets: this.opts.threadPresets,
      sessions,
    });
    const candidates: WarmCandidate[] = owned.map((row) => {
      const record = sessions.find((s) => s.id === row.sessionId);
      const health = this.opts.router.turnHealth(row.sessionId);
      return {
        sessionId: row.sessionId,
        agentId: row.agentId,
        updatedUtc: row.updatedUtc,
        acpSessionId: record?.acpSessionId ?? "",
        hot: this.opts.router.hasRuntime(row.sessionId),
        busy: health.busy && !health.stalled,
      };
    });
    const decisions = selectWarmSet({
      candidates,
      budgetMb: host.budgetMb,
      loadSlots: this.opts.maxConcurrent,
      highCostLoadSlots: 1,
    });

    const loads: SessionRecord[] = [];
    for (const d of decisions) {
      if (this.stopped) return;
      if (d.action === "keep") {
        this.reverify(d.sessionId, location);
        continue;
      }
      if (d.action === "evict") {
        const health = this.opts.router.turnHealth(d.sessionId);
        if (health.busy && !health.stalled) continue;
        await this.opts.router.invalidate(d.sessionId).catch((err) => {
          this.opts.logger.warn({ err, session: d.sessionId }, "warm-set evict failed");
        });
        continue;
      }
      if (d.action === "load") {
        const record = sessions.find((s) => s.id === d.sessionId);
        if (!record) continue;
        if (this.cold.get(record.id) === record.acpSessionId) continue;
        loads.push(record);
      }
    }
    await Promise.all(loads.map((record) => this.pool.run(() => this.loadOne(record, loadCost(record.agentId) === "high"))));
  }

  private reverify(sessionId: string, location: string): void {
    const health = this.opts.router.turnHealth(sessionId);
    if (health.stalled) {
      this.opts.logger.info({ session: sessionId, silentMs: health.silentMs }, "warm-set: stalled hot runtime; marking cold");
      this.cold.set(sessionId, this.opts.store.get(sessionId)?.acpSessionId ?? "");
      void this.opts.router.invalidate(sessionId).catch(() => {});
      return;
    }
    if (!isLocalLocation(location)) {
      const runtime = this.opts.router.getRuntime(sessionId);
      const slot = runtime?.getSlot?.();
      const snap = slot != null
        ? this.opts.hub.slotHealthFor?.(location)?.find((h) => h.slot === slot)
        : undefined;
      if (snap && !snap.alive) {
        this.opts.logger.info({ session: sessionId, slot }, "warm-set: bridge slot dead; marking cold");
        this.cold.set(sessionId, this.opts.store.get(sessionId)?.acpSessionId ?? "");
        void this.opts.router.invalidate(sessionId).catch(() => {});
        return;
      }
    }
    this.opts.router.getRuntime(sessionId)?.markActivity();
  }

  private async loadOne(record: SessionRecord, highCost: boolean): Promise<void> {
    try {
      await this.opts.router.resumeExistingSession(record);
      this.cold.delete(record.id);
      this.opts.logger.info(
        { session: record.id, agent: record.agentId, highCost },
        "warm-set loaded",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cold.set(record.id, record.acpSessionId);
      const gone = /session not found|no rollout found|unknown session|unknown AGY session/i.test(message);
      this.opts.logger.info(
        { session: record.id, agent: record.agentId, gone, err: message },
        "warm-set: load failed; marking cold",
      );
      if (gone) {
        await this.opts.router.invalidate(record.id, { clearAcpSession: true }).catch(() => {});
      }
    }
  }
}
