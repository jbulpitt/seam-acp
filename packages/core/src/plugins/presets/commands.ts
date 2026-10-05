import { SlashCommandBuilder, type APIApplicationCommandSubcommandGroupOption } from "discord.js";

const cmd = new SlashCommandBuilder().setName("seam").setDescription("Seam commands");
  cmd.addSubcommandGroup((g) =>
    g
      .setName("preset")
      .setDescription("Manage reusable session presets")
      .addSubcommand((sub) => sub.setName("list").setDescription("List all presets"))
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create a new preset (opens a builder card)")
          .addBooleanOption((o) =>
            o
              .setName("global")
              .setDescription(
                "Make a global preset (visible in every project). Default: scoped to this project."
              )
              .setRequired(false)
          )
          .addStringOption((o) =>
            o
              .setName("role")
              .setDescription("Role on apply")
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("apply")
          .setDescription("Apply a preset to the current thread")
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("Preset name")
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a preset")
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("Preset name")
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("show")
          .setDescription("Show a preset's details")
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("Preset name")
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription("Edit an existing preset (reopens the builder card)")
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("Preset name")
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("thread")
          .setDescription("Create a new thread from a preset")
          .addStringOption((o) =>
            o
              .setName("preset")
              .setDescription("Preset to apply to the new thread")
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("Base name")
              .setRequired(false)
          )
          .addIntegerOption((o) =>
            o
              .setName("quantity")
              .setDescription("Thread count")
              .setRequired(false)
              .setMinValue(1)
          )
      )
  );

export const PRESET_COMMAND_GROUP = cmd.toJSON().options![0] as APIApplicationCommandSubcommandGroupOption;
export const PRESET_ACCESS = { list: "read-only", create: "mutating", apply: "mutating", delete: "mutating", show: "read-only", edit: "mutating", thread: "mutating" } as const;
