import type { Logger } from "pino";
import { setTimeout as delay } from "node:timers/promises";
import { googleErrorStatus } from "./api.js";

type Write = { run: () => Promise<unknown>; key?: string;
  waiters: Array<{ resolve: (value: any) => void; reject: (error: unknown) => void }> };
type Lane = { pending: Write[]; lastStart: number; spacing: number; draining?: Promise<void> };

/** Every thread in a space shares Google's create/patch/delete write budget. */
export class SpaceWriteQueue {
  private readonly lanes = new Map<string, Lane>();
  private readonly intervalMs: number;

  constructor(private readonly opts: { logger: Logger; intervalMs?: number }) {
    this.intervalMs = opts.intervalMs ?? 1100;
  }

  enqueue<T>(space: string, run: () => Promise<T>, editKey?: string): Promise<T> {
    let lane = this.lanes.get(space);
    if (!lane) {
      lane = { pending: [], lastStart: -Infinity, spacing: this.intervalMs };
      this.lanes.set(space, lane);
    }
    const result = new Promise<T>((resolve, reject) => {
      const previous = editKey ? lane.pending.find(write => write.key === editKey) : undefined;
      if (previous) {
        previous.run = run;
        previous.waiters.push({ resolve, reject });
      } else lane.pending.push({ run, key: editKey, waiters: [{ resolve, reject }] });
    });
    this.startDrain(space, lane);
    return result;
  }

  private startDrain(space: string, lane: Lane): void {
    lane.draining ??= this.drain(space, lane).finally(() => {
      lane.draining = undefined;
      if (lane.pending.length) this.startDrain(space, lane);
    });
  }

  async flush(): Promise<void> {
    await Promise.all([...this.lanes.values()].map(lane => lane.draining));
  }

  private async drain(space: string, lane: Lane): Promise<void> {
    while (lane.pending.length) {
      const wait = lane.lastStart + lane.spacing - Date.now();
      if (wait > 0) await delay(wait);
      const write = lane.pending.shift()!;
      for (;;) {
        lane.lastStart = Date.now();
        try {
          const value = await write.run();
          for (const waiter of write.waiters) waiter.resolve(value);
          lane.spacing = Math.max(this.intervalMs, lane.spacing / 2);
          break;
        } catch (err) {
          const status = googleErrorStatus(err);
          if (status !== undefined && status !== 408 && status !== 429 && status < 500) {
            for (const waiter of write.waiters) waiter.reject(err);
            break;
          }
          lane.spacing = Math.min(8000, Math.max(1000, lane.spacing * 2));
          this.opts.logger.warn({ err, space, retryMs: lane.spacing }, "Google Chat write retry");
          await delay(lane.spacing);
        }
      }
    }
  }
}
