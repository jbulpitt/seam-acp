/**
 * Bounded worker pool (#452). SerialQueue is the wrong shape: one
 * pathological Codex session/load would stall every other warm-up. This
 * cap is mandatory, not a tuning knob — ten simultaneous loads spike
 * memory and disk together.
 */
export class BoundPool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (limit < 1) throw new Error("BoundPool limit must be >= 1");
  }

  get inFlight(): number {
    return this.active;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
