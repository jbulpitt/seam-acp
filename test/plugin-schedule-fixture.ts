import { pino } from "pino";
import { ScheduleUi, createScheduleUiPlugin } from "../packages/core/src/plugins/schedule-ui/index.js";
import { scheduleUiPorts } from "../packages/core/src/core/schedule-ui.js";
import { scheduleUiInteraction } from "../packages/core/src/platforms/discord/schedule-ui-transport.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";

const logger = pino({ level: "silent" });
/** Existing UI fixtures drive the production facades and interaction wrapper. */
export function scheduleUiFixture(self: any) {
  const ports = scheduleUiPorts({
    config: self.config ?? {}, logger, store: self.store, router: self.router, modelCatalog: self.modelCatalog,
    manager: () => self.scheduledManager, runNow: id => self.runScheduledPrompt(id),
  }, () => { throw new Error("fixture invokes the UI directly"); }, () => { throw new Error("fixture invokes components directly"); });
  const ui = new ScheduleUi(ports);
  const interaction = (native: any) => scheduleUiInteraction(native, {
    channel: i => self.channelRefFromInteraction(i),
    mutationRefusal: i => self.slashAccessRefusal?.(i, { kind: "mutating" }),
    lifecycle: (i, collector, expired) => {
      const host = Object.assign(Object.create(Orchestrator.prototype), {
        logger, trackedCardWork: (work: Promise<unknown>) => work, trackCardJob: () => {},
      }, self);
      return host.attachListLifecycle(i, collector, expired);
    },
  });
  return { ui, interaction, ports };
}

export function registerScheduleCommands(host: Pick<PluginHost, "slash">): void {
  const plugin = createScheduleUiPlugin({ logger, repository: {} } as never);
  host.slash.register(plugin.id, plugin.contributions.slash!, { logger, config: undefined });
}
