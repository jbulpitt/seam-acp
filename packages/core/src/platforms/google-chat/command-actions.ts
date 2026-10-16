import type { RuntimeTransition } from "../../core/runtime-transition.js";
import type { ConfigApplyPlan } from "../../core/config-apply-plan.js";
import type { ModelCatalogService } from "../../core/model-catalog/service.js";
import type { SessionRouter } from "../../core/session-router.js";
import type { SessionRecord } from "../../core/types.js";
import type { ConfigMutationService, MutationActor, ThreadPresetChanges } from "../../core/config-mutation.js";
import type { SessionStore } from "../../core/session-store.js";
import { threadPresetKey, type ThreadPreset } from "../../config.js";
import { normalizeLocation } from "../../core/location.js";
import type { ChannelRef } from "../chat-adapter.js";
import type { Orchestrator } from "../discord/orchestrator.js";
import type { GoogleChatCommand } from "./commands.js";

export { GoogleChatSessionSpaces, resolveGoogleChatOrgDefaults, prepareGoogleChatSpaceSelection,
  bindGoogleChatSessionSpace } from "./session-spaces.js";

export interface GoogleChatCommandDeps {
  /** The adapter owns resource-name -> canonical ChannelRef mapping. */
  channelFor(space: string, thread: string | null): ChannelRef;
  router: Pick<SessionRouter, "ensureSessionRecord" | "describeConfig" | "bindRecordLocation">;
  store: Pick<SessionStore, "getByChannel">;
  mutation: Pick<ConfigMutationService, "readThreadPresetEntry" | "applyThreadOverlay">;
  runtimeTransition: Pick<RuntimeTransition, "applyAgentChange" | "applyModelChange" | "configure">;
  configPlan: Pick<ConfigApplyPlan, "applyRepoChange" | "listRepos">;
  modelCatalog: Pick<ModelCatalogService, "effortChoices">;
  cancelChannel: Orchestrator["cancelChannel"];
  cwd: string;
  location?: string;
  respond(channel: ChannelRef, text: string): Promise<void>;
}

type CancelOutcome = Awaited<ReturnType<Orchestrator["cancelChannel"]>>;
type SwitchOutcome = Awaited<ReturnType<RuntimeTransition["applyModelChange"]>>;
export type GoogleChatCommandResult =
  | { command: "cancel"; channel: ChannelRef; outcome: CancelOutcome }
  | { command: "usage"; requestedCommand: "agent" | "model" | "repo" | "effort"; channel: ChannelRef; message: string }
  | { command: "agent" | "model"; channel: ChannelRef; outcome: SwitchOutcome }
  | { command: "repo"; channel: ChannelRef; outcome: Awaited<ReturnType<ConfigApplyPlan["applyRepoChange"]>> }
  | { command: "effort"; channel: ChannelRef; outcome: Awaited<ReturnType<RuntimeTransition["configure"]>> };

/** Uses the same core cancellation and configuration operations as Discord. */
export async function executeGoogleChatCommand(
  command: Omit<GoogleChatCommand, "command"> & { command: Exclude<GoogleChatCommand["command"], "new" | "schedules"> },
  deps: GoogleChatCommandDeps,
): Promise<GoogleChatCommandResult> {
  const channel = deps.channelFor(command.space, command.thread);
  if (command.command === "cancel") return {
    command: "cancel", channel, outcome: await deps.cancelChannel(channel),
  };
  const record = deps.store.getByChannel(channel.platform, channel.id);
  if (!record) {
    const message = "Start a session Space with /new before changing its configuration.";
    await deps.respond(channel, message);
    return { command: "usage", requestedCommand: command.command, channel, message };
  }
  deps.router.bindRecordLocation(record);
  if (!command.args.trim()) {
    const current = deps.router.describeConfig(record);
    let message: string;
    if (command.command === "repo") {
      message = `Usage: /repo <path> — current: ${current.cwd.value} (host: ${current.location.value})`;
      try {
        const repos = await deps.configPlan.listRepos(record);
        message += `\nAvailable repos: ${repos.length ? repos.join(", ") : "none listed"}`;
      } catch (err) {
        message += `\nAvailable repos unavailable: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (command.command === "effort") {
      const levels = deps.modelCatalog.effortChoices({ agentId: current.agent.value, location: current.location.value }, current.model.value);
      message = `Usage: /effort <level> — current: ${current.effort.value ?? "auto"}\nValid levels for ${current.agent.value}/${current.model.value}: ${levels.length ? levels.join(", ") : "none advertised"}. Use auto for the default.`;
    } else message = `Usage: /${command.command} <id> — current: ${current[command.command].value}`;
    await deps.respond(channel, message);
    return { command: "usage", requestedCommand: command.command, channel, message };
  }
  const actor = { id: command.user.id, name: command.user.name };
  const respond = (text: string) => deps.respond(channel, text);
  if (command.command === "repo") {
    const outcome = await deps.configPlan.applyRepoChange(channel, record, command.args, actor);
    await respond(outcome.ok ? outcome.message : outcome.error);
    return { command: "repo", channel, outcome };
  }
  if (command.command === "effort") {
    const outcome = await deps.runtimeTransition.configure(record, record, { effort: command.args }, actor);
    await respond(outcome.ok
      ? `Effort set to ${outcome.applied.effort}. Session not reset.${outcome.runtimeReloaded ? " Runtime reloaded with the same context." : ""}${outcome.warnings.length ? `\n${outcome.warnings.join("\n")}` : ""}`
      : outcome.error);
    return { command: "effort", channel, outcome };
  }
  const outcome = command.command === "agent"
    ? await deps.runtimeTransition.applyAgentChange(channel, record, command.args, actor, respond)
    : await deps.runtimeTransition.applyModelChange(channel, record, command.args, actor, respond);
  return { command: command.command, channel, outcome };
}

/** Seed new Chat sessions through the same persisted overlay and bridge binding as thread config. */
export function bindGoogleChatSession(
  channel: ChannelRef,
  deps: Pick<GoogleChatCommandDeps, "store" | "router" | "mutation" | "cwd" | "location">,
  actor: MutationActor,
): SessionRecord {
  if (!deps.store.getByChannel(channel.platform, channel.id)) {
    const preset = deps.mutation.readThreadPresetEntry(threadPresetKey(channel.platform, channel.id)) as ThreadPreset | undefined;
    const location = normalizeLocation(deps.location);
    const changes: ThreadPresetChanges = {
      ...(!preset?.location && location !== "local" ? { location } : {}),
      ...(!preset?.cwd ? { cwd: deps.cwd } : {}),
    };
    if (Object.keys(changes).length) {
      const applied = deps.mutation.applyThreadOverlay({ threadId: channel.id, platform: channel.platform,
        parentRef: channel.parentId, changes, actor });
      if (!applied.ok) throw new Error(applied.error);
    }
  }
  const record = deps.router.ensureSessionRecord({
    platform: channel.platform, channelRef: channel.id,
    ...(channel.parentId ? { parentRef: channel.parentId } : {}), cwd: deps.cwd,
  });
  deps.router.bindRecordLocation(record);
  return record;
}
