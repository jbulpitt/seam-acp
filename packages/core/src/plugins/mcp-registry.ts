import type { Logger } from "../lib/logger.js";
import type { PluginContext } from "./types.js";
import { isInvalidArgumentError } from "../lib/invalid-argument.js";

export interface McpInvocation {
  threadId: string;
  parentId?: string;
  args: Readonly<Record<string, unknown>>;
}
export interface PluginToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}
export interface McpContribution {
  descriptor: { name: string; description: string; inputSchema: Record<string, unknown> };
  access: "read-only" | "mutating";
  authorization: "user" | "config-admin";
  instruction: string;
  available(invocation: Readonly<Pick<McpInvocation, "threadId" | "parentId">>): boolean;
  handle(invocation: McpInvocation, context: PluginContext): Promise<PluginToolResult>;
}
type Entry = { plugin: string; contribution: McpContribution; context: PluginContext };
export class McpRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly logger: Logger) {}
  validate(contributions: readonly McpContribution[], reserved: readonly string[] = []): void {
    const names = new Set([...this.entries.keys(), ...reserved]);
    for (const contribution of contributions) {
      const name = contribution.descriptor.name;
      if (!name || names.has(name)) throw new Error(`duplicate MCP tool ${name}`);
      names.add(name);
    }
  }
  register(plugin: string, contributions: readonly McpContribution[], context: PluginContext): void {
    this.validate(contributions);
    for (const contribution of contributions) this.entries.set(contribution.descriptor.name, { plugin, contribution, context });
  }
  get(name: string, invocation: Pick<McpInvocation, "threadId" | "parentId">): McpContribution | undefined {
    const entry = this.entries.get(name);
    return entry?.contribution.available(invocation) ? entry.contribution : undefined;
  }
  list(invocation: Pick<McpInvocation, "threadId" | "parentId">): McpContribution[] {
    return [...this.entries.values()].map(entry => entry.contribution).filter(contribution => contribution.available(invocation));
  }
  async dispatch(name: string, invocation: McpInvocation): Promise<PluginToolResult> {
    const entry = this.entries.get(name);
    if (!entry || !entry.contribution.available(invocation)) throw new Error(`unknown tool: ${name}`);
    try { return await entry.contribution.handle(invocation, entry.context); }
    catch (err) {
      if (isInvalidArgumentError(err)) {
        this.logger.warn({ err, plugin: entry.plugin, tool: name }, "plugin MCP arguments rejected");
      } else {
        this.logger.error({ err, plugin: entry.plugin, tool: name }, "plugin MCP handler failed");
      }
      throw err;
    }
  }
  remove(plugin: string): void { for (const [name, entry] of this.entries) if (entry.plugin === plugin) this.entries.delete(name); }
  clear(): void { this.entries.clear(); }
}
