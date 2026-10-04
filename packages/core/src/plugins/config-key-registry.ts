import type { ZodTypeAny } from "zod";

export interface ConfigKeyContribution {
  key: string;
  schema: ZodTypeAny;
  defaultValue: unknown;
  description: string;
}

/** The kernel still owns overlays and audited writes. */
export class ConfigKeyRegistry {
  private readonly entries = new Map<string, { plugin: string; contribution: ConfigKeyContribution }>();
  validate(contributions: readonly ConfigKeyContribution[]): void {
    const keys = new Set(this.entries.keys());
    for (const contribution of contributions) {
      if (!contribution.key || keys.has(contribution.key) || !contribution.description) throw new Error(`invalid or duplicate config key ${contribution.key}`);
      contribution.schema.parse(contribution.defaultValue);
      keys.add(contribution.key);
    }
  }
  register(plugin: string, contributions: readonly ConfigKeyContribution[]): void {
    this.validate(contributions);
    for (const contribution of contributions) this.entries.set(contribution.key, { plugin, contribution });
  }
  list(): readonly ConfigKeyContribution[] { return [...this.entries.values()].map(entry => entry.contribution); }
  parseChanges<T extends object>(changes: T): T {
    const result = { ...changes };
    for (const [key, entry] of this.entries) {
      const value = (changes as Record<string, unknown>)[key];
      if (value === undefined || value === null || value === "") continue;
      try { (result as Record<string, unknown>)[key] = entry.contribution.schema.parse(value); }
      catch (err) { throw new Error(`Invalid ${key}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return result;
  }
  remove(plugin: string): void { for (const [key, entry] of this.entries) if (entry.plugin === plugin) this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
}
