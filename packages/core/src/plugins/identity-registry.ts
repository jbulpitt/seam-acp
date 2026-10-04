import type { Logger } from "../lib/logger.js";
import type { PluginContext } from "./types.js";

export interface ThreadIdentity {
  agent: string;
  model: string;
  role: string | null;
  prefix: string | null;
  disableThreadPrefix: boolean;
}
export interface NamingThread {
  id: string;
  platform: string;
  parentId: string | null;
  createdUtc: string;
  identity: Readonly<ThreadIdentity>;
}
export type IdentityEvent =
  | { type: "thread-created"; thread: Readonly<NamingThread>; reason: string }
  | { type: "identity-changed"; thread: Readonly<NamingThread>; before: Readonly<ThreadIdentity>; reason: string };
export interface IdentityContribution {
  event: IdentityEvent["type"];
  handle(event: Readonly<IdentityEvent>, context: PluginContext): Promise<void>;
}
type Entry = { plugin: string; contribution: IdentityContribution; context: PluginContext };
export class IdentityRegistry {
  private readonly entries: Entry[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly logger: Logger) {}
  register(plugin: string, contributions: readonly IdentityContribution[], context: PluginContext): void {
    for (const contribution of contributions) this.entries.push({ plugin, contribution, context });
  }
  emit(event: IdentityEvent): Promise<void> {
    const fact = structuredClone(event);
    Object.freeze(fact.thread.identity);
    Object.freeze(fact.thread);
    if (fact.type === "identity-changed") Object.freeze(fact.before);
    Object.freeze(fact);
    const running = (this.pending.get(fact.thread.id) ?? Promise.resolve()).then(async () => {
      for (const entry of this.entries.filter(entry => entry.contribution.event === fact.type)) {
        try { await entry.contribution.handle(fact, entry.context); }
        catch (err) { this.logger.error({ err, plugin: entry.plugin, event: fact.type, thread: fact.thread.id }, "plugin identity handler failed"); }
      }
    });
    this.pending.set(fact.thread.id, running);
    void running.then(() => { if (this.pending.get(fact.thread.id) === running) this.pending.delete(fact.thread.id); });
    return running;
  }
  async drain(): Promise<void> { await Promise.all(this.pending.values()); }
  clear(): void { this.entries.length = 0; }
}
