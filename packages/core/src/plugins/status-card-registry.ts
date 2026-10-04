import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { StatusCardStyle, TurnState } from "../core/types.js";
import type { PluginContext } from "./types.js";

export interface StatusCardFacts {
  readonly state: TurnState;
  readonly agentId: string;
  readonly profileBrand?: string;
  readonly model: string;
  readonly resolvedModel?: string;
  readonly style: StatusCardStyle;
  readonly gifOn: boolean;
}

export interface StatusCardDecoration {
  icon?: string;
  thumbnail?: string;
  style?: StatusCardStyle;
}

export interface StatusCardContribution {
  name: string;
  decorate(facts: Readonly<StatusCardFacts>, context: PluginContext): StatusCardDecoration;
}

const decoration = z.object({ icon: z.string().url().optional(), thumbnail: z.string().url().optional(), style: z.enum(["full", "simple"]).optional() });
type Entry = { plugin: string; contribution: StatusCardContribution; context: PluginContext };

/** Decorations cannot write status facts or retain their mutable source. */
export class StatusCardRegistry {
  private readonly entries: Entry[] = [];
  constructor(private readonly logger: Logger) {}

  validate(contributions: readonly StatusCardContribution[]): void {
    const names = new Set<string>();
    for (const contribution of contributions) {
      if (!contribution.name || names.has(contribution.name) || typeof contribution.decorate !== "function") throw new Error(`invalid status-card decorator ${contribution.name}`);
      names.add(contribution.name);
    }
  }
  register(plugin: string, contributions: readonly StatusCardContribution[], context: PluginContext): void {
    this.validate(contributions);
    for (const contribution of contributions) this.entries.push({ plugin, contribution, context });
  }
  decorate(facts: StatusCardFacts): StatusCardDecoration {
    const snapshot = Object.freeze({ ...facts });
    let result: StatusCardDecoration = {};
    for (const entry of this.entries) {
      try { result = { ...result, ...decoration.parse(entry.contribution.decorate(snapshot, entry.context)) }; }
      catch (err) { this.logger.error({ err, plugin: entry.plugin, decorator: entry.contribution.name }, "plugin status-card decorator failed"); }
    }
    return result;
  }
  remove(plugin: string): void { for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i]!.plugin === plugin) this.entries.splice(i, 1); }
  clear(): void { this.entries.length = 0; }
}
