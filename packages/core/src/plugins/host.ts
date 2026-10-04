import type { Logger } from "../lib/logger.js";
import { FenceRegistry } from "./fence-registry.js";
import { PLUGIN_API_VERSION, type BuiltinPlugin, type Plugin } from "./types.js";
import { SlashRegistry } from "./slash-registry.js";
import { McpRegistry } from "./mcp-registry.js";
import { ComponentRegistry } from "./component-registry.js";
import { IdentityRegistry } from "./identity-registry.js";
import { JobRegistry } from "./job-registry.js";
import { PluginStorage } from "./storage.js";
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";

export class PluginHost {
  readonly fences: FenceRegistry;
  readonly slash: SlashRegistry;
  readonly mcp: McpRegistry;
  readonly components: ComponentRegistry;
  readonly identity: IdentityRegistry;
  readonly jobs: JobRegistry;
  private readonly active: Plugin[] = [];
  private readonly ids = new Set<string>();

  constructor(private readonly logger: Logger, private readonly reserved: {
    slash?: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[];
    mcp?: readonly string[];
    components?: readonly string[];
    storageRoot?: string;
    storageAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  } = {}) {
    this.fences = new FenceRegistry(logger);
    this.slash = new SlashRegistry(logger);
    this.mcp = new McpRegistry(logger);
    this.components = new ComponentRegistry(logger);
    this.identity = new IdentityRegistry(logger);
    this.jobs = new JobRegistry(logger, plugin => this.disable(plugin));
  }

  async loadBuiltins(builtins: readonly BuiltinPlugin[], configs: Readonly<Record<string, unknown>> = {}): Promise<void> {
    for (const builtin of builtins) {
      const logger = this.logger.child({ plugin: builtin.id });
      let plugin: Plugin | undefined;
      let activating = false;
      try {
        if (this.ids.has(builtin.id)) throw new Error(`duplicate plugin id ${builtin.id}`);
        this.ids.add(builtin.id);
        plugin = await builtin.load();
        if (plugin.id !== builtin.id || plugin.builtin !== true || plugin.apiVersion !== PLUGIN_API_VERSION) {
          throw new Error(`ineligible built-in plugin ${builtin.id}: id=${plugin.id}, apiVersion=${plugin.apiVersion}`);
        }
        this.fences.validate(plugin.id, plugin.contributions.fences ?? []);
        this.slash.validate(plugin.contributions.slash ?? []);
        if (this.reserved.slash) this.slash.assemble(this.reserved.slash, plugin.contributions.slash ?? []);
        this.mcp.validate(plugin.contributions.mcp ?? [], this.reserved.mcp);
        this.components.validate(plugin.contributions.components ?? [], this.reserved.components);
        this.jobs.validate(plugin.contributions.jobs ?? []);
        const config = plugin.validateConfig ? plugin.validateConfig(configs[plugin.id]) : configs[plugin.id];
        const context = Object.freeze({ logger, config, ...(this.reserved.storageRoot ? {
          storage: new PluginStorage(this.reserved.storageRoot, plugin.id, this.reserved.storageAliases?.[plugin.id]),
        } : {}) });
        activating = true;
        await plugin.activate?.(context);
        this.fences.register(plugin.id, plugin.contributions.fences ?? [], context);
        this.slash.register(plugin.id, plugin.contributions.slash ?? [], context);
        this.mcp.register(plugin.id, plugin.contributions.mcp ?? [], context);
        this.components.register(plugin.id, plugin.contributions.components ?? [], context);
        this.identity.register(plugin.id, plugin.contributions.identity ?? [], context);
        this.jobs.register(plugin.id, plugin.contributions.jobs ?? []);
        this.active.push(plugin);
        logger.info("plugin activated");
      } catch (err) {
        logger.error({ err }, "plugin disabled");
        if (activating) {
          try { await plugin?.dispose?.(); } catch (disposeError) { logger.warn({ err: disposeError }, "disabled plugin disposal failed"); }
        }
      }
    }
  }

  async dispose(): Promise<void> {
    this.jobs.stop();
    this.fences.clear();
    await this.jobs.drain();
    await this.fences.drain();
    await this.identity.drain();
    this.slash.clear();
    this.mcp.clear();
    this.components.clear();
    this.identity.clear();
    for (const plugin of this.active.splice(0).reverse()) {
      try { await plugin.dispose?.(); }
      catch (err) { this.logger.warn({ err, plugin: plugin.id }, "plugin disposal failed"); }
    }
  }

  private async disable(id: string): Promise<void> {
    this.jobs.stop(id);
    this.fences.remove(id);
    this.slash.remove(id);
    this.mcp.remove(id);
    this.components.remove(id);
    this.identity.remove(id);
    const index = this.active.findIndex(plugin => plugin.id === id);
    if (index < 0) return;
    const [plugin] = this.active.splice(index, 1);
    try { await this.jobs.drain(id); await plugin?.dispose?.(); }
    catch (err) { this.logger.warn({ err, plugin: id }, "disabled plugin disposal failed"); }
  }
}
