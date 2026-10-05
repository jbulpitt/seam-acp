import type { ChatInputCommandInteraction } from "discord.js";
import type { Config } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRouter } from "./session-router.js";
import type { ModelCatalogService } from "./model-catalog/service.js";
import type { ScheduledPromptManager } from "./scheduled-prompts/manager.js";
import type { PluginHost } from "../plugins/host.js";
import type { SlashInvocation } from "../plugins/slash-registry.js";
import type { ScheduleInteraction, ScheduleUiPorts } from "../plugins/schedule-ui/ports.js";

interface ScheduleUiDependencies {
  config: Config; logger: Logger; store: SessionStore; router: SessionRouter;
  modelCatalog: ModelCatalogService; manager(): ScheduledPromptManager | undefined;
  runNow(id: string): Promise<void>;
}

/** Controller-only schedule repository and administration facade. */
export function scheduleUiPorts(deps: ScheduleUiDependencies, interaction: ScheduleUiPorts["interaction"], component: ScheduleUiPorts["component"]): ScheduleUiPorts {
  return {
    logger: deps.logger.child({ plugin: "schedule-ui" }), reposRoot: deps.config.REPOS_ROOT,
    repository: {
      list: channel => deps.store.listScheduledByChannel("discord", channel),
      get: id => deps.store.getScheduled(id) ?? undefined, save: row => deps.store.upsertScheduled(row), remove: id => deps.store.deleteScheduled(id),
    },
    admin: {
      arm: row => deps.manager()?.armFromRow(row), disarm: id => deps.manager()?.disarm(id), reschedule: id => deps.manager()?.reschedule(id),
      runNow: async id => { const manager = deps.manager(); if (manager) await manager.runNow(id); else await deps.runNow(id); },
    },
    builderDefaults: channel => {
      const record = deps.router.ensureSessionRecord({ platform: "discord", channelRef: channel.id,
        ...(channel.parentId ? { parentRef: channel.parentId } : {}), cwd: deps.config.REPOS_ROOT });
      const current = deps.router.describeConfig(record);
      return {
        agent: current.agent.value, registered: Boolean(deps.router.getProfile(current.agent.value)), model: current.model.value, cwd: current.cwd.value,
        models: deps.modelCatalog.models({ agentId: current.agent.value, location: current.location.value }, { current: current.model.value })
          .map(model => ({ modelId: model.id, name: model.displayName })).slice(0, 24),
      };
    },
    interaction, component,
  };
}

export function installScheduleUi(deps: ScheduleUiDependencies & {
  plugins: PluginHost;
  interaction(i: ChatInputCommandInteraction): ScheduleInteraction;
  component: ScheduleUiPorts["component"];
}) {
  const interactions = new WeakMap<SlashInvocation, ScheduleInteraction>();
  const ports = scheduleUiPorts(deps, invocation => interactions.get(invocation)!, deps.component);
  return {
    ready: deps.plugins.loadBuiltins([{ id: "schedule-ui", load: async () => (await import("../plugins/schedule-ui/index.js")).createScheduleUiPlugin(ports) }]),
    bind: (invocation: SlashInvocation, interaction: ChatInputCommandInteraction) => { interactions.set(invocation, deps.interaction(interaction)); },
  };
}
