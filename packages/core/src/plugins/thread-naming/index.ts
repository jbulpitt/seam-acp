import { ApplicationCommandOptionType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import {
  ThreadNamer, formatThreadNamerRules, parseThreadNamerRules,
  type ThreadNamerConfigStore, type ThreadNamerDeps, type ApplyThreadNameResult,
} from "../../platforms/discord/thread-namer.js";
import type { Plugin } from "../types.js";
import type { SlashContribution, SlashInvocation } from "../slash-registry.js";
import type { ComponentEvent } from "../../platforms/chat-adapter.js";
import type { NamingThread } from "../identity-registry.js";

/** Bootstrap-only facades. No kernel object crosses into the plugin. */
export interface ThreadNamingPorts {
  threads: Omit<ThreadNamerDeps, "setNamePrefix" | "getConfig">;
  internal: {
    rules: Pick<ThreadNamerConfigStore, "get" | "save">;
    setNamePrefix(sessionId: string, prefix: string | null): void;
    get(threadId: string): Parameters<ThreadNamer["applyThreadName"]>[0] | undefined;
    all(): Array<Parameters<ThreadNamer["applyThreadName"]>[0]>;
  };
}

const group = { name: "naming", description: "Admin-only: rebuild thread names, or edit the naming symbol tables" };
const EDIT_TTL = 600_000;
const namespace = "seam-namer:";
function editorId(action: string, userId: string, deadline: number): string {
  return `${namespace}${action}:${userId}:${deadline.toString(36)}`;
}

export function createThreadNamingPlugin(ports: ThreadNamingPorts): Plugin {
  const namer = new ThreadNamer({ ...ports.threads, getConfig: () => ports.internal.rules.get(), setNamePrefix: ports.internal.setNamePrefix });
  const current = (threadId: string) => ports.internal.get(threadId);
  const render = (owner: string, deadline: number, error?: string) => {
    const rules = ports.internal.rules.get();
    const preview = (text: string) => `\`\`\`\n${text || "(none)"}\n\`\`\``.slice(0, 1024);
    return {
      embeds: [new EmbedBuilder().setTitle("🏷️ Thread namer").setColor(error ? 0xed4245 : 0x5865f2)
        .setDescription(error ? `❌ ${error}\n\nNothing was saved.` : "Ordered substring rules. First match wins; blank lines and `#` comments are ignored.")
        .addFields(...(["agents", "models", "roles"] as const).map((key, index) => ({
          name: ["Agents", "Models", "Roles"][index]!, value: preview(formatThreadNamerRules(rules[key], ["agent", "model", "role"][index] as "agent" | "model" | "role")),
        })))],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(editorId("edit", owner, deadline)).setLabel("Edit match tables").setStyle(ButtonStyle.Primary))],
    };
  };
  const refresh = async () => {
    const records = ports.internal.all();
    for (const parent of new Set(records.flatMap(record => record.parentRef ? [record.parentRef] : []))) {
      await namer.recompactChannel("discord", parent);
    }
    for (const record of records.filter(record => !record.parentRef)) await namer.applyThreadName(record);
  };
  const rename = async (invocation: SlashInvocation) => {
    const record = current(invocation.threadId);
    if (!record) return invocation.reply("Use inside a thread.");
    const options = { migrateLegacy: invocation.boolean("migrate-legacy") ?? false, roleName: invocation.boolean("role-name") ?? false };
    if (invocation.string("scope") === "channel") {
      if (!record.parentRef) return invocation.reply("This thread has no parent channel.");
      await invocation.defer();
      const results = await namer.recompactChannel(record.platform, record.parentRef, options);
      const count = (status: string) => results.filter(result => result.status === status).length;
      await invocation.edit(`Recomputed ${results.length} channel thread(s): ${count("rebuilt")} rebuilt, ${count("renamed")} renamed, ${count("unchanged")} unchanged, ${count("unmanaged") + count("roleless") + count("opted_out")} left untouched, ${count("gone")} gone, ${count("failed")} failed.`);
      return;
    }
    await invocation.defer();
    const result = await namer.applyThreadName(record, options);
    await invocation.edit(renameDetail(result));
  };
  const slash: SlashContribution[] = [
    { command: "seamadmin", group,
      leaf: { type: ApplicationCommandOptionType.Subcommand, name: "rename", description: "Refresh/migrate names", options: [
        { type: ApplicationCommandOptionType.String, name: "scope", description: "Rename scope", choices: [{ name: "thread", value: "thread" }, { name: "channel", value: "channel" }] },
        { type: ApplicationCommandOptionType.Boolean, name: "migrate-legacy", description: "Migrate legacy prefix" },
        { type: ApplicationCommandOptionType.Boolean, name: "role-name", description: "Use role as base" },
      ] }, access: { kind: "mutating" }, authorization: "config-admin", help: "`/seamadmin naming rename [scope] [migrate-legacy] [role-name]` — rebuild thread names", handle: rename },
    { command: "seamadmin", group,
      leaf: { type: ApplicationCommandOptionType.Subcommand, name: "namer", description: "Edit naming rules" },
      access: { kind: "mutating" }, authorization: "config-admin", help: "`/seamadmin naming namer` — edit the agent/model/role symbol tables",
      handle: async invocation => invocation.view(render(invocation.actor.id, Date.now() + EDIT_TTL)) },
  ];
  const component = async (invocation: ComponentEvent) => {
    const [, action, owner, encodedDeadline] = invocation.customId.split(":");
    const deadline = parseInt(encodedDeadline ?? "", 36);
    if (owner !== invocation.userId) return invocation.replyEphemeral("This editor belongs to another user.");
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return invocation.replyEphemeral("This editor expired — run `/seamadmin naming namer` again.");
    if (action === "edit" && invocation.kind === "button") {
      const rules = ports.internal.rules.get();
      await invocation.showModal({ customId: editorId("save", owner, deadline), title: "Thread namer rules", inputs: (["agents", "models", "roles"] as const).map((key, index) => ({
        id: key, label: ["Agent rules: match=emoji", "Model rules: match=emoji @agent", "Role rules: match=emoji"][index]!, style: "paragraph", maxLength: 4000, required: false,
        value: formatThreadNamerRules(rules[key], ["agent", "model", "role"][index] as "agent" | "model" | "role"),
      })) });
    } else if (action === "save" && invocation.kind === "modal") {
      let error: string | undefined;
      try {
        ports.internal.rules.save({ agents: parseThreadNamerRules(invocation.fields?.agents ?? "", "agent"), models: parseThreadNamerRules(invocation.fields?.models ?? "", "model"), roles: parseThreadNamerRules(invocation.fields?.roles ?? "", "role") });
      } catch (err) { error = err instanceof Error ? err.message : String(err); }
      await invocation.replyEphemeralView(render(owner, deadline, error));
      if (!error) await refresh();
    } else await invocation.replyEphemeral("Unknown thread-namer action.");
  };
  const onIdentity = async (thread: Readonly<NamingThread>, fresh: boolean) => {
    const record = current(thread.id);
    if (record) await namer.applyThreadName(record, { fresh });
  };
  return {
    id: "thread-naming", apiVersion: 1, builtin: true, internal: true,
    contributions: {
      slash,
      mcp: [{
        descriptor: { name: "rename_thread", description: "Rename YOUR OWN Discord thread base. Managed prefixes are recomputed around it; unmanaged threads remain unmanaged. Restricted participants cannot rename.", inputSchema: { type: "object", properties: { name: { type: "string", description: "New thread title (max 100 characters)." } }, required: ["name"] } },
        access: "mutating", authorization: "user", instruction: "- rename_thread(name): rename YOUR OWN thread (free-form title). Restricted participants cannot.",
        available: invocation => Boolean(current(invocation.threadId)),
        handle: async invocation => {
          const name = invocation.args.name;
          if (typeof name !== "string" || !name.trim()) throw new Error("name must be a non-empty string");
          const record = current(invocation.threadId);
          if (!record) throw new Error("the calling thread no longer exists");
          await namer.renameBase(record, name.slice(0, 100));
          return { content: [{ type: "text", text: `Renamed this thread to ${name.slice(0, 100)}.` }] };
        },
      }],
      components: [{ namespace, types: ["button", "modal"], lifetime: "persistent", access: "mutating", authorization: "config-admin", handle: component }],
      identity: [
        { event: "thread-created", handle: async event => onIdentity(event.thread, true) },
        { event: "identity-changed", handle: async event => {
          if (event.reason === "channel preset committed" && event.thread.parentId) await namer.recompactChannel(event.thread.platform, event.thread.parentId);
          else await onIdentity(event.thread, false);
        } },
      ],
    },
  };
}

function renameDetail(result: ApplyThreadNameResult): string {
  switch (result.status) {
    case "unmanaged": return "Name left untouched because its exact stored prefix boundary is unavailable. Use migrate-legacy:true for explicit cleanup.";
    case "roleless": return "Name left untouched because this thread has no resolved role.";
    case "opted_out": return "Name left untouched because automatic naming is disabled.";
    case "renamed": case "rebuilt": return `${result.status === "rebuilt" ? "Rebuilt" : "Renamed"} as ${result.name}.`;
    default: return "Name already matches.";
  }
}
