import type { ChatInputCommandInteraction } from "discord.js";
import { resolveThreadLocation, type Config } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { ChannelRef, IncomingMessage } from "../platforms/chat-adapter.js";
import { LOCAL_LOCATION } from "./location.js";
import type { SessionRecord } from "./types.js";
import type { SessionStore } from "./session-store.js";
import { resolveSessionCwd, type SessionRouter } from "./session-router.js";
import type { ModelCatalogService } from "./model-catalog/service.js";
import { CONFIG_SET_FIELD_NAMES, type ConfigApplyPlan } from "./config-apply-plan.js";
import type { PluginHost } from "../plugins/host.js";
import type { SlashInvocation } from "../plugins/slash-registry.js";
import type { InheritedConfig } from "../platforms/discord/config-editor.js";
import type { ConfigInteraction, ConfigUiPorts } from "../plugins/config-ui/ports.js";
import type { ConfigUi } from "../plugins/config-ui/ui.js";

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
}

/** Read-only configuration projection, without a thread overlay. */
function inheritedConfigFor(deps: ConfigUiDependencies, record: SessionRecord): InheritedConfig {
  const { config, store, modelCatalog } = deps;
  const chan = record.parentRef ? config.channelPresets.get(record.parentRef) : undefined;
  const cfg = store.readConfig(record);
  const agent = chan?.agent?.value ?? record.agentId;
  const location = resolveThreadLocation(config, record.channelRef);
  const model = chan?.model?.value ?? cfg.model ?? modelCatalog.model({ agentId: agent, location }, "default")?.id ?? "default";
  const chanEffort = chan?.effort?.value;
  const effortUsable = Boolean(chanEffort && modelCatalog.effortChoices({ agentId: agent, location: LOCAL_LOCATION }, model).includes(chanEffort));
  return {
    location: LOCAL_LOCATION, agent, model, effort: effortUsable ? chanEffort! : cfg.reasoningEffort ?? null,
    cwd: resolveSessionCwd({ repoPath: record.repoPath, sessionCwdExplicit: cfg.sessionCwdExplicit === true, channelCwd: chan?.cwd?.value, defaultCwd: config.REPOS_ROOT }).value,
    permission: (cfg.permissionPolicy ?? config.DEFAULT_PERMISSION_POLICY ?? "ask") as InheritedConfig["permission"],
    detached: false, fastMode: false,
    statusCardStyle: chan?.statusCardStyle?.value === "simple" || chan?.statusCardStyle?.value === "full" ? chan.statusCardStyle.value : "full",
    simpleCardGif: typeof chan?.simpleCardGif?.value === "boolean" ? chan.simpleCardGif.value : false,
    role: chan?.role?.value ?? null, disableThreadPrefix: chan?.disableThreadPrefix?.value === true,
  };
}

/** Controller-only facade: expose UI snapshots and audited operations, never stores or runtimes. */
export function installConfigUi(deps: ConfigUiDependencies) {
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
    bind: channel => { ensure(channel); },
    readConfig: channel => deps.store.readConfig(ensure(channel)),
    snapshot: channel => {
      const record = ensure(channel);
      const chan = channel.parentId ? deps.config.channelPresets.get(channel.parentId) : undefined;
      return { desc: deps.router.describeConfig(record), withoutThread: inheritedConfigFor(deps, record), channelPins: {
        ...(chan?.agent?.value ? { agent: chan.agent.value } : {}), ...(chan?.model?.value ? { model: chan.model.value } : {}),
        ...(chan?.cwd?.value ? { cwd: chan.cwd.value } : {}), ...(chan?.effort?.value ? { effort: chan.effort.value } : {}),
        ...(chan?.role?.value ? { role: chan.role.value } : {}), ...(chan?.disableThreadPrefix?.value === true ? { disableThreadPrefix: true } : {}),
      } };
    },
    canEditChannelPreset: deps.canEditChannelPreset, hasFastMode: agent => deps.router.getProfile(agent)?.fastMode !== undefined,
    agentChoices: deps.agentChoices, promptRepoPath: deps.promptRepoPath,
    saveEditor: (draft, actor) => deps.plan().saveEditor(draft, actor, parent => deps.canEditChannelPreset(actor.id!, parent)),
    prepareSet: (channel, request) => deps.plan().prepareConfigSet(ensure(channel), channel, request),
    applySet: async (channel, request, prepared, actor, options) => {
      const result = await deps.plan().applyPreparedConfigSet(ensure(channel), channel, request, prepared, actor, options);
      return result.ok ? { ok: true, effective: result.effective, restartRequested: result.restartRequested } : result;
    },
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
