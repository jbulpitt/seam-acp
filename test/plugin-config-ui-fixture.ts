import { pino } from "pino";
import type { PluginHost } from "../packages/core/src/plugins/host.js";
import { createConfigUiPlugin } from "../packages/core/src/plugins/config-ui/index.js";
import { ConfigUi } from "../packages/core/src/plugins/config-ui/ui.js";
import type { ConfigUiPorts } from "../packages/core/src/plugins/config-ui/ports.js";

export function registerConfigUiCommands(host: PluginHost) {
  const plugin = createConfigUiPlugin(new ConfigUi({ autocomplete: [] } as unknown as ConfigUiPorts));
  host.slash.register(plugin.id, plugin.contributions.slash!, { logger: pino({ level: "silent" }), config: undefined });
}
