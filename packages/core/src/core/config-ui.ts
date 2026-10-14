import type { ChatInputCommandInteraction } from "discord.js";
import type { Config } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { ChannelRef, IncomingMessage } from "../platforms/chat-adapter.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRouter } from "./session-router.js";
import type { ModelCatalogService } from "./model-catalog/service.js";
import { CONFIG_SET_FIELD_NAMES, type ConfigApplyPlan } from "./config-apply-plan.js";
import type { PluginHost } from "../plugins/host.js";
import type { SlashInvocation } from "../plugins/slash-registry.js";
import type { ConfigInteraction, ConfigUiPorts } from "../plugins/config-ui/ports.js";
import type { ConfigUi } from "../plugins/config-ui/ui.js";
import { ParentConfigCleanup, type ConfigParentChannel } from "./channel-config-cleanup.js";
import { checkFastModeEligibility } from "./fast-mode.js";

interface ConfigUiDependencies {
  plugins: PluginHost; config: Config; logger: Logger; store: SessionStore; router: SessionRouter; modelCatalog: ModelCatalogService;
  plan(): ConfigApplyPlan;
  transport: ConfigUiPorts["transport"];
  canEditChannelPreset: ConfigUiPorts["canEditChannelPreset"];
  agentChoices: ConfigUiPorts["agentChoices"];
  promptRepoPath: ConfigUiPorts["promptRepoPath"];
  rebuild: ConfigUiPorts["rebuild"];
  codeBlock: ConfigUiPorts["codeBlock"];
  repoDisplay: ConfigUiPorts["repoDisplay"];
  autocomplete(option: string): ConfigUiPorts["autocomplete"][number]["respond"] | undefined;
  interaction(i: ChatInputCommandInteraction): ConfigInteraction;
  parentChannels(): Promise<ConfigParentChannel[]>;
}

/** Controller-only facade: expose UI snapshots and audited operations, never stores or runtimes. */
export function installConfigUi(deps: ConfigUiDependencies) {
  const cleanup = new ParentConfigCleanup({ config: deps.config, store: deps.store, plan: deps.plan, parents: deps.parentChannels });
  const interactions = new WeakMap<SlashInvocation, ConfigInteraction>();
  const ensure = (channel: ChannelRef) => deps.router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id,
    ...(channel.parentId ? { parentRef: channel.parentId } : {}), cwd: deps.config.REPOS_ROOT });
  const transport: ConfigUiPorts["transport"] = {
    sendMessage: (channel, text, options) => deps.transport.sendMessage(channel, text, options),
    ...(deps.transport.sendPanel ? { sendPanel: (channel, panel) => deps.transport.sendPanel!(channel, panel) } satisfies Partial<ConfigUiPorts["transport"]> : {}),
    ...(deps.transport.editPanel ? { editPanel: (message, panel) => deps.transport.editPanel!(message, panel) } satisfies Partial<ConfigUiPorts["transport"]> : {}),
    ...(deps.transport.sendFile ? { sendFile: (channel, file) => deps.transport.sendFile!(channel, file) } satisfies Partial<ConfigUiPorts["transport"]> : {}),
    ...(deps.transport.sendChoicePicker ? { sendChoicePicker: (channel, options) => deps.transport.sendChoicePicker!(channel, options) } satisfies Partial<ConfigUiPorts["transport"]> : {}),
  };
  const ports: ConfigUiPorts = {
    logger: deps.logger.child({ plugin: "config-ui" }), transport,
    catalog: {
      models: (binding, view) => deps.modelCatalog.models(binding, view), model: (binding, model) => deps.modelCatalog.model(binding, model),
      effortChoices: (binding, model) => deps.modelCatalog.effortChoices(binding, model), isHidden: (binding, model) => deps.modelCatalog.isHidden?.(binding, model) ?? false,
    },
    bind: channel => { if (channel.parentId) ensure(channel); },
    readConfig: channel => channel.parentId ? deps.store.readConfig(ensure(channel)) : deps.plan().describeTarget(channel),
    snapshot: channel => deps.plan().snapshot(channel),
    canEditChannelPreset: deps.canEditChannelPreset,
    fastModeStatus: (channel, binding, model) => {
      const descriptor = deps.router.getProfile(binding.agentId, binding.location)?.fastMode;
      const eligible = checkFastModeEligibility({ requested: true, agentId: binding.agentId, descriptor });
      if (!eligible.ok) return { descriptor, available: false, reason: eligible.error };
      const record = deps.store.getByChannel(channel.platform, channel.id);
      const described = record && deps.router.describeConfig(record);
      const runtime = record && deps.router.getRuntime(record.id);
      if (!runtime) return { descriptor, available: false, reason: `No live ${binding.agentId}@${binding.location} session has advertised Fast mode yet.` };
      if (described!.agent.value !== binding.agentId || described!.location.value !== binding.location || described!.model.value !== model) {
        return { descriptor, available: false, reason: "Save the agent/model selection first; Fast availability comes from that live session." };
      }
      return { descriptor, ...runtime.getFastModeAvailability() };
    },
    agentChoices: deps.agentChoices, promptRepoPath: deps.promptRepoPath,
    saveEditor: (draft, actor) => deps.plan().saveEditor(draft, actor, parent => deps.canEditChannelPreset(actor.id!, parent)),
    prepareSet: (channel, request) => deps.plan().prepareConfigSet(ensure(channel), channel, request),
    applySet: async (channel, request, prepared, actor, options) => {
      const result = await deps.plan().applyPreparedConfigSet(ensure(channel), channel, request, prepared, actor, options);
      return result.ok ? { ok: true, effective: result.effective, restartRequested: result.restartRequested } : result;
    },
    prepareChannelSet: (channel, request) => deps.plan().prepareChannelSet(channel, request),
    applyChannelSet: (channel, prepared, actor) => deps.plan().applyChannelSet(channel, prepared, actor),
    overrideCounts: (id, fields) => deps.plan().overrideCounts(id, fields),
    followChannel: (id, fields, actor) => deps.plan().followChannel(id, fields, actor),
    clearThreadOverrides: (channel, fields, actor) => deps.plan().clearThreadOverrides(channel, fields, actor),
    cleanup,
    rebuild: deps.rebuild, auditEntries: limit => deps.store.listConfigMutations(limit), codeBlock: deps.codeBlock, repoDisplay: deps.repoDisplay,
    description: key => deps.plugins.configKeys.list().find(entry => entry.key === key)?.description,
    autocomplete: CONFIG_SET_FIELD_NAMES.map(option => ({ option, policy: "canonical", respond: ctx => deps.autocomplete(option)?.(ctx) ?? [] })),
    interaction: invocation => interactions.get(invocation)!,
  };
  let ui: ConfigUi;
  let active = false;
  const ready = deps.plugins.loadBuiltins([{ id: "config-ui", load: async () => {
    const { ConfigUi, createConfigUiPlugin } = await import("../plugins/config-ui/index.js");
    ui = new ConfigUi(ports);
    return createConfigUiPlugin(ui, { activate: () => { active = true; }, dispose: () => { active = false; } });
  } }]);
  return {
    ready, get ui() { return ui; }, interaction: deps.interaction,
    bind: (invocation: SlashInvocation, interaction: ChatInputCommandInteraction) => interactions.set(invocation, deps.interaction(interaction)),
    open: async (channel: ChannelRef, user: string) => active ? ui.openConfigEditorCard(channel, user) : null,
    consumeRider: async (message: IncomingMessage) => {
      if (!active) return false;
      try { return await ui.tryConsumeConfigEditorRiderUpload(message); }
      catch (err) { ports.logger.error({ err }, "config editor rider handler failed"); return false; }
    },
  };
}
