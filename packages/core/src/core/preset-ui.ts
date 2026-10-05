import type { ChatInputCommandInteraction, MessageComponentInteraction } from "discord.js";
import { resolveThreadLocation, type Config } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { ChannelRef } from "../platforms/chat-adapter.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRouter } from "./session-router.js";
import type { Preset, SessionRecord } from "./types.js";
import type { ConfigApplyPlan } from "./config-apply-plan.js";
import type { ModelCatalogService } from "./model-catalog/service.js";
import { LOCAL_LOCATION } from "./location.js";
import type { PluginHost } from "../plugins/host.js";
import type { SlashInvocation } from "../plugins/slash-registry.js";
import type { PresetUi } from "../plugins/presets/ui.js";
import type { PresetInteraction, PresetUiPorts } from "../plugins/presets/ports.js";

interface PresetDependencies {
  plugins: PluginHost; config: Config; logger: Logger; store: SessionStore; router: SessionRouter; modelCatalog: ModelCatalogService;
  plan(): ConfigApplyPlan;
  agentsByHost(): ReadonlyMap<string, ReadonlySet<string>>;
  listWorkspace: PresetUiPorts["listWorkspace"];
  promptRepoPath: PresetUiPorts["promptRepoPath"];
  resolveRequestedRepoPath: PresetUiPorts["resolveRequestedRepoPath"];
  repoDisplay: PresetUiPorts["repoDisplay"];
  transport: PresetUiPorts["transport"];
  createThread(channelId: string, name: string, author: string): Promise<ChannelRef>;
  bindThread(channel: ChannelRef): SessionRecord;
  openTurn(channel: ChannelRef, record: SessionRecord, preset: Preset, author: string): void;
  canCreateThread: boolean;
  interaction(i: ChatInputCommandInteraction | MessageComponentInteraction): PresetInteraction;
}

/** Thread creation, preset application and the existing opening-turn admission path. */
export function installPresetUi(deps: PresetDependencies) {
  const interactions = new WeakMap<SlashInvocation, PresetInteraction>();
  const ports: PresetUiPorts = {
    logger: deps.logger.child({ plugin: "presets" }), repository: deps.store.presets,
    catalog: { models: (binding, view) => deps.modelCatalog.models(binding, view), model: (binding, model) => deps.modelCatalog.model(binding, model) },
    transport: { ...(deps.transport.sendChoicePicker ? { sendChoicePicker: (channel, options) => deps.transport.sendChoicePicker!(channel, options) } : {}) },
    builderDefaults: channel => {
      const location = resolveThreadLocation(deps.config, channel?.id);
      const local = deps.router.listProfiles();
      const profiles = location === LOCAL_LOCATION ? local : [...(deps.agentsByHost().get(location) ?? new Set<string>())].sort()
        .map(id => local.find(profile => profile.id === id) ?? { id, displayName: id });
      return { location, profiles: profiles.map(profile => ({ id: profile.id, displayName: profile.displayName })) };
    },
    listWorkspace: deps.listWorkspace, promptRepoPath: deps.promptRepoPath, resolveRequestedRepoPath: deps.resolveRequestedRepoPath,
    repoDisplay: deps.repoDisplay, canCreateThread: deps.canCreateThread,
    defaultRole: parent => deps.config.channelPresets.get(parent)?.role?.value,
    apply: (channel, preset) => deps.plan().applyPresetToSession(channel, deps.router.ensureSessionRecord({
      platform: channel.platform, channelRef: channel.id, ...(channel.parentId ? { parentRef: channel.parentId } : {}), cwd: deps.config.REPOS_ROOT,
    }), preset),
    createFromPreset: async (channelId, name, author, preset) => {
      const thread = await deps.createThread(channelId, name, author);
      const record = deps.bindThread(thread);
      const summary = await deps.plan().applyPresetToSession(thread, record, preset, { fresh: true });
      deps.openTurn(thread, record, preset, author);
      return { thread, summary };
    },
    interaction: invocation => interactions.get(invocation)!,
  };
  let ui: PresetUi;
  const ready = deps.plugins.loadBuiltins([{ id: "presets", load: async () => {
    const { PresetUi, createPresetPlugin } = await import("../plugins/presets/index.js");
    ui = new PresetUi(ports);
    return createPresetPlugin(ui);
  } }]);
  return {
    ready, get ui() { return ui; }, interaction: deps.interaction,
    bind: (invocation: SlashInvocation, i: ChatInputCommandInteraction) => interactions.set(invocation, deps.interaction(i)),
  };
}
