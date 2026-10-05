import { pino } from "pino";
import type { PluginHost } from "../packages/core/src/plugins/host.js";
import { PresetUi, createPresetPlugin } from "../packages/core/src/plugins/presets/index.js";
import type { PresetUiPorts } from "../packages/core/src/plugins/presets/ports.js";
import { presetUiInteraction } from "../packages/core/src/platforms/discord/preset-ui-transport.js";

const logger = pino({ level: "silent" });
export function registerPresetCommands(host: Pick<PluginHost, "slash">) {
  const plugin = createPresetPlugin(new PresetUi({} as PresetUiPorts));
  host.slash.register(plugin.id, plugin.contributions.slash!, { logger, config: undefined });
}

export function presetUiFixture(self: any) {
  const ui = new PresetUi({
    logger: self.logger ?? logger, repository: self.store.presets ?? self.store, track: work => work,
    repoDisplay: repo => self.repoDisplay?.(repo) ?? repo ?? "", interaction: () => { throw new Error("fixture invokes UI directly"); },
  } as PresetUiPorts);
  const interaction = (native: any) => presetUiInteraction(native, {
    channel: i => self.channelRefFromInteraction?.(i), projectScopeId: i => self.projectScopeId(i),
    mutationRefusal: i => self.slashAccessRefusal?.(i, { kind: "mutating" }),

  });
  return { ui, interaction };
}
