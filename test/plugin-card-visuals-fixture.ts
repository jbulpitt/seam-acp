import { pino } from "pino";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { createCardVisualsPlugin } from "../packages/core/src/plugins/card-visuals/index.js";
import { DEFAULT_BRAND_ICON_BASE_URL } from "../packages/core/src/plugins/card-visuals/agent-brand.js";
import { DEFAULT_GIF_MANIFEST_URL } from "../packages/core/src/plugins/card-visuals/card-gifs.js";
import { buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import { namingRegistry } from "./plugin-naming-fixture.js";

export const visualConfig = { BRAND_ICON_BASE_URL: DEFAULT_BRAND_ICON_BASE_URL, SIMPLE_CARD_GIF_MANIFEST_URL: DEFAULT_GIF_MANIFEST_URL };
export function visualCommands() {
  const registry = namingRegistry();
  const plugin = createCardVisualsPlugin({ read: () => undefined, write: () => ({ ok: true }) });
  registry.register(plugin.id, plugin.contributions.slash!, { logger: pino({ level: "silent" }), config: visualConfig });
  return buildSlashRegistrationBody(registry);
}
export async function visualHost(base = DEFAULT_BRAND_ICON_BASE_URL) {
  const host = new PluginHost(pino({ level: "silent" }));
  await host.loadBuiltins([{ id: "card-visuals", load: async () => createCardVisualsPlugin({ read: () => undefined, write: () => ({ ok: true }) }) }],
    { "card-visuals": { ...visualConfig, BRAND_ICON_BASE_URL: base } });
  return host;
}
