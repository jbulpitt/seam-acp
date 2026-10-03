import type { Logger } from "../lib/logger.js";
import { FenceRegistry } from "./fence-registry.js";
import { PLUGIN_API_VERSION, type BuiltinPlugin, type Plugin } from "./types.js";

export class PluginHost {
  readonly fences: FenceRegistry;
  private readonly active: Plugin[] = [];
  private readonly ids = new Set<string>();

  constructor(private readonly logger: Logger) {
    this.fences = new FenceRegistry(logger);
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
        this.fences.validate(plugin.id, plugin.contributions.fences);
        const config = plugin.validateConfig ? plugin.validateConfig(configs[plugin.id]) : configs[plugin.id];
        const context = Object.freeze({ logger, config });
        activating = true;
        await plugin.activate?.(context);
        this.fences.register(plugin.id, plugin.contributions.fences, context);
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
    this.fences.clear();
    await this.fences.drain();
    for (const plugin of this.active.splice(0).reverse()) {
      try { await plugin.dispose?.(); }
      catch (err) { this.logger.warn({ err, plugin: plugin.id }, "plugin disposal failed"); }
    }
  }
}
