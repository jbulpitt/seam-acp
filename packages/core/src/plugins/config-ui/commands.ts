import { SlashCommandSubcommandBuilder } from "discord.js";

export function addConfigScope(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return sub.addStringOption(o => o.setName("scope").setDescription("This thread or channel default; parent commands use channel default")
    .addChoices({ name: "This thread", value: "thread" }, { name: "Channel default", value: "channel" }));
}

/** Keep `/seam new` and `/seam config set` on one registered option contract. */
export function addConfigSetOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return sub
    .addStringOption((o) =>
      o.setName("json").setDescription("Full config JSON; cannot mix with fields").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("agent").setDescription("Agent id or agent@host").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName("model").setDescription("Model id").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName("effort").setDescription("Reasoning effort; default clears").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName("repo").setDescription("Working repo path").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName("role").setDescription("Naming role; auto clears").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName("permissions").setDescription("always, ask, or deny").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName("card").setDescription("full, simple, or default").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName("gif").setDescription("on, off, or default").setRequired(false).setAutocomplete(true)
    )
    .addBooleanOption((o) =>
      o.setName("rebuild").setDescription("Rebuild session from Discord after applying").setRequired(false)
    );
}

export const CONFIG_UI_GROUP = { name: "config", description: "Session and bot configuration" };
export const CONFIG_UI_LEAVES = [
  { name: "show", method: "cmdConfig", access: "read-only", help: "`/seam config show` — inspect session config", leaf: new SlashCommandSubcommandBuilder().setName("show").setDescription("Show current session config").toJSON() },
  { name: "edit", method: "cmdConfigEdit", access: "mutating", help: "`/seam config edit [scope]` — edit config, then Save/Cancel", leaf: addConfigScope(new SlashCommandSubcommandBuilder().setName("edit").setDescription("Open the config editor (draft, then Save/Cancel)")).toJSON() },
  { name: "set", method: "cmdConfigSet", access: "mutating", help: "`/seam config set [json|fields] [scope]` — update configuration", leaf: addConfigScope(addConfigSetOptions(new SlashCommandSubcommandBuilder().setName("set").setDescription("Patch config fields together, or replace session JSON"))).toJSON() },
  { name: "audit", method: "cmdConfigAudit", access: "read-only", help: "`/seam config audit [limit] [entry]` — recent config mutations (who/what/when)", leaf: new SlashCommandSubcommandBuilder().setName("audit").setDescription("Show recent config mutations (who/what/when), newest first")
    .addIntegerOption(o => o.setName("limit").setDescription("How many recent mutations to show (default 20)").setRequired(false).setMinValue(1).setMaxValue(100))
    .addStringOption(o => o.setName("entry").setDescription("Show the before→after diff for one entry id").setRequired(false)).toJSON() },
] as const;
