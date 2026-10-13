import { SlashCommandSubcommandBuilder } from "discord.js";
import type { Plugin } from "../types.js";
import type { MutationActor } from "../../core/config-mutation.js";

export function createSessionMovePlugin(move: (input: {
  sessionId: string; destination: string; adoptDestinationConfig: boolean; actor: MutationActor;
}) => Promise<{ backup: string; record: { id: string; channelRef: string; acpSessionId: string }; sessionReset: boolean }>): Plugin {
  return { id: "session-move", apiVersion: 1, builtin: true, internal: true, contributions: { slash: [{
    command: "seamadmin", acknowledgement: "ephemeral", authorization: "config-admin", access: { kind: "mutating" },
    leaf: new SlashCommandSubcommandBuilder().setName("move-session").setDescription("Move an idle legacy Chat session into an empty session Space")
      .addStringOption(o => o.setName("session").setDescription("Existing stable session record id").setRequired(true))
      .addStringOption(o => o.setName("space").setDescription("Destination session Space id or spaces/<id>").setRequired(true))
      .addBooleanOption(o => o.setName("adopt-destination-config").setDescription("Accept differing config and its normal session reset rules")).toJSON(),
    help: "`/seamadmin move-session session:<record> space:<id>` — backed-up, idle-only move; matching config preserves ACP",
    handle: async invocation => {
      const result = await move({ sessionId: invocation.string("session")!, destination: invocation.string("space")!,
        adoptDestinationConfig: invocation.boolean("adopt-destination-config") === true, actor: invocation.actor });
      await invocation.reply(`Moved ${result.record.id} to ${result.record.channelRef}. ${result.sessionReset
        ? "ACP reset by the adopted configuration." : `ACP unchanged: ${result.record.acpSessionId || "not started"}.`} Backup: ${result.backup}`);
    },
  }] } };
}
