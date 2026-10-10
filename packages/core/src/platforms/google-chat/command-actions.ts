import type { RuntimeTransition } from "../../core/runtime-transition.js";
import type { SessionRouter } from "../../core/session-router.js";
import type { SessionRecord } from "../../core/types.js";
import type { ChannelRef, ChatAdapter } from "../chat-adapter.js";
import type { Orchestrator } from "../discord/orchestrator.js";
import type { GoogleChatCommand } from "./commands.js";

export interface GoogleChatCommandDeps {
  /** The adapter owns resource-name -> canonical ChannelRef mapping. */
  channelFor(space: string, thread: string | null): ChannelRef;
  createThread: NonNullable<ChatAdapter["createThread"]>;
  router: Pick<SessionRouter, "ensureSessionRecord" | "describeConfig">;
  runtimeTransition: Pick<RuntimeTransition, "applyAgentChange" | "applyModelChange">;
  cancelChannel: Orchestrator["cancelChannel"];
  cwd: string;
  respond(channel: ChannelRef, text: string): Promise<void>;
}

type CancelOutcome = Awaited<ReturnType<Orchestrator["cancelChannel"]>>;
type SwitchOutcome = Awaited<ReturnType<RuntimeTransition["applyModelChange"]>>;
export type GoogleChatCommandResult =
  | { command: "new"; channel: ChannelRef; record: SessionRecord }
  | { command: "cancel"; channel: ChannelRef; outcome: CancelOutcome }
  | { command: "usage"; requestedCommand: "agent" | "model"; channel: ChannelRef; message: string }
  | { command: "agent" | "model"; channel: ChannelRef; outcome: SwitchOutcome };

/** Uses the same core operations as /seam new, /seam cancel and /seam config. */
export async function executeGoogleChatCommand(
  command: GoogleChatCommand,
  deps: GoogleChatCommandDeps,
): Promise<GoogleChatCommandResult> {
  if (command.command === "new") {
    const parent = deps.channelFor(command.space, null);
    const channel = await deps.createThread(parent, command.args || "seam");
    const record = bind(channel, deps);
    return { command: "new", channel, record };
  }
  const channel = deps.channelFor(command.space, command.thread);
  if (command.command === "cancel") return {
    command: "cancel", channel, outcome: await deps.cancelChannel(channel),
  };
  const record = bind(channel, deps);
  if (!command.args.trim()) {
    const current = deps.router.describeConfig(record)[command.command].value;
    const message = `Usage: /${command.command} <id> — current: ${current}`;
    await deps.respond(channel, message);
    return { command: "usage", requestedCommand: command.command, channel, message };
  }
  const actor = { id: command.user.id, name: command.user.name };
  const respond = (text: string) => deps.respond(channel, text);
  const outcome = command.command === "agent"
    ? await deps.runtimeTransition.applyAgentChange(channel, record, command.args, actor, respond)
    : await deps.runtimeTransition.applyModelChange(channel, record, command.args, actor, respond);
  return { command: command.command, channel, outcome };
}

function bind(channel: ChannelRef, deps: GoogleChatCommandDeps): SessionRecord {
  return deps.router.ensureSessionRecord({
    platform: channel.platform, channelRef: channel.id,
    ...(channel.parentId ? { parentRef: channel.parentId } : {}), cwd: deps.cwd,
  });
}
