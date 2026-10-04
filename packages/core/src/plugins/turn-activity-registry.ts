import type { Logger } from "../lib/logger.js";
import type { PluginContext } from "./types.js";

export interface TurnBinding {
  agentId: string;
  location: string;
  account: string | null;
  sessionId?: string;
}
export interface TurnActivityEvent {
  type: "turn-started" | "turn-completed";
  turnId: string;
  timestampMs: number;
  binding: Readonly<TurnBinding>;
}
export interface TurnActivityContribution {
  event: TurnActivityEvent["type"];
  handle(event: Readonly<TurnActivityEvent>, context: PluginContext): void | Promise<void>;
}
type Entry = { plugin: string; contribution: TurnActivityContribution; context: PluginContext };

/** Ordered observations. Emitting a fact never waits for its observers. */
export class TurnActivityRegistry {
  private readonly entries: Entry[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly logger: Logger) {}
  register(plugin: string, contributions: readonly TurnActivityContribution[], context: PluginContext): void {
    for (const contribution of contributions) this.entries.push({ plugin, contribution, context });
  }
  emit(event: TurnActivityEvent): void {
    const fact = Object.freeze({ ...event, binding: Object.freeze({ ...event.binding }) });
    const key = fact.binding.agentId;
    const running = (this.pending.get(key) ?? Promise.resolve()).then(async () => {
      for (const entry of this.entries.filter(entry => entry.contribution.event === fact.type)) {
        try { await entry.contribution.handle(fact, entry.context); }
        catch (err) { this.logger.error({ err, plugin: entry.plugin, event: fact.type, turn: fact.turnId }, "plugin turn-activity handler failed"); }
      }
    });
    this.pending.set(key, running);
    void running.then(() => { if (this.pending.get(key) === running) this.pending.delete(key); });
  }
  async drain(): Promise<void> { await Promise.all(this.pending.values()); }
  remove(plugin: string): void { for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i]!.plugin === plugin) this.entries.splice(i, 1); }
  clear(): void { this.entries.length = 0; }
}
