import type { Logger } from "../lib/logger.js";
import type { FenceContribution, FenceInvocation, PluginContext } from "./types.js";

type Entry = { plugin: string; contribution: FenceContribution; context: PluginContext };

export class FenceRegistry {
  private readonly tags = new Map<string, Entry>();
  private readonly entries: Entry[] = [];
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly logger: Pick<Logger, "warn">) {}

  validate(plugin: string, contributions: readonly FenceContribution[]): void {
    const seen = new Set<string>();
    for (const contribution of contributions) {
      for (const raw of [contribution.tag, ...(contribution.aliases ?? [])]) {
        const tag = raw.trim().toLowerCase();
        if (!tag || /\s/.test(tag)) throw new Error(`plugin ${plugin}: invalid fence tag ${JSON.stringify(raw)}`);
        if (seen.has(tag) || this.tags.has(tag)) {
          throw new Error(`plugin ${plugin}: duplicate fence tag ${tag} (owner: ${this.tags.get(tag)?.plugin ?? plugin})`);
        }
        seen.add(tag);
      }
    }
  }

  register(plugin: string, contributions: readonly FenceContribution[], context: PluginContext): void {
    this.validate(plugin, contributions);
    for (const contribution of contributions) {
      const entry = { plugin, contribution, context };
      this.entries.push(entry);
      for (const tag of [contribution.tag, ...(contribution.aliases ?? [])]) this.tags.set(tag.trim().toLowerCase(), entry);
    }
  }

  get instructions(): string[] {
    return this.entries.map(entry => entry.contribution.instruction);
  }

  async render(invocation: FenceInvocation): Promise<boolean> {
    const entry = this.tags.get(invocation.fence.lang.trim().toLowerCase());
    if (!entry) return false;
    const work = (async () => {
      try {
        await entry.contribution.handle(invocation, entry.context);
      } catch (err) {
        this.logger.warn({ err, plugin: entry.plugin, tag: invocation.fence.lang }, "plugin fence handler failed; emitting source");
        await invocation.output.fallback(invocation.notice);
      }
    })();
    this.pending.add(work);
    try { await work; } finally { this.pending.delete(work); }
    return true;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  remove(plugin: string): void {
    for (const [tag, entry] of this.tags) if (entry.plugin === plugin) this.tags.delete(tag);
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i]!.plugin === plugin) this.entries.splice(i, 1);
  }

  clear(): void {
    this.tags.clear();
    this.entries.length = 0;
  }
}
