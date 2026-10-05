import type { Logger } from "../lib/logger.js";
import type { ComponentEvent } from "../platforms/chat-adapter.js";
import type { PluginContext } from "./types.js";

export interface ComponentContribution {
  namespace: string;
  types: readonly ComponentEvent["kind"][];
  lifetime: "persistent" | "collector";
  access: "read-only" | "mutating" | ((customId: string) => "read-only" | "mutating");
  authorization: "user" | "config-admin";
  handle(invocation: ComponentEvent, context: PluginContext): Promise<void>;
}
type Entry = { plugin: string; contribution: ComponentContribution; context: PluginContext };
export class ComponentRegistry {
  private readonly entries: Entry[] = [];
  constructor(private readonly logger: Logger) {}
  validate(contributions: readonly ComponentContribution[], reserved: readonly string[] = []): void {
    const namespaces = [...this.entries.map(entry => entry.contribution.namespace), ...reserved];
    for (const contribution of contributions) {
      const namespace = contribution.namespace;
      if (!/^[a-z][a-z0-9-]*:$/.test(namespace) || !contribution.types.length) throw new Error(`invalid component namespace ${namespace}`);
      if (namespaces.some(other => other.startsWith(namespace) || namespace.startsWith(other))) throw new Error(`duplicate component namespace ${namespace}`);
      namespaces.push(namespace);
    }
  }
  register(plugin: string, contributions: readonly ComponentContribution[], context: PluginContext): void {
    this.validate(contributions);
    for (const contribution of contributions) this.entries.push({ plugin, contribution, context });
  }
  classify(customId: string, kind: ComponentEvent["kind"]): ComponentContribution["lifetime"] | undefined {
    return this.get(customId, kind)?.lifetime;
  }
  get(customId: string, kind: ComponentEvent["kind"]): ComponentContribution | undefined {
    return this.entries.find(entry => customId.startsWith(entry.contribution.namespace) && entry.contribution.types.includes(kind))?.contribution;
  }
  async dispatch(invocation: ComponentEvent): Promise<boolean> {
    const entry = this.entries.find(entry => invocation.customId.startsWith(entry.contribution.namespace) && entry.contribution.types.includes(invocation.kind));
    if (!entry || entry.contribution.lifetime !== "persistent") return false;
    try { await entry.contribution.handle(invocation, entry.context); }
    catch (err) {
      this.logger.error({ err, plugin: entry.plugin, customId: invocation.customId }, "plugin component handler failed");
      await invocation.replyEphemeral(`Could not complete this action: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
    return true;
  }
  remove(plugin: string): void { for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i]!.plugin === plugin) this.entries.splice(i, 1); }
  clear(): void { this.entries.length = 0; }
}
