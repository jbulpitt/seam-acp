import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";

/**
 * `/seam` slash-command tree. Subcommands mirror the C# `cp …` text commands.
 * Models are resolved at runtime via the agent's `availableModels`, but for
 * v1 we accept a free-form string with autocomplete in a later phase.
 */
export function buildSeamCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName("seam")
    .setDescription("Control the seam-acp agent");

  cmd.addSubcommand((sub) =>
    sub
      .setName("new")
      .setDescription("Create a new agent thread")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Thread name (optional)")
          .setRequired(false)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("repo")
      .setDescription("Set the working repo for this thread")
      .addStringOption((o) =>
        o
          .setName("path")
          .setDescription("Path under REPOS_ROOT (or absolute)")
          .setRequired(true)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("model")
      .setDescription("Get or set the agent model for this thread")
      .addStringOption((o) =>
        o.setName("id").setDescription("Model id").setRequired(false)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("mode")
      .setDescription("Set the agent operational mode")
      .addStringOption((o) =>
        o.setName("id").setDescription("Mode id").setRequired(true)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("effort")
      .setDescription("Set reasoning effort (if model supports it)")
      .addStringOption((o) =>
        o
          .setName("level")
          .setDescription("low | medium | high")
          .setRequired(true)
          .addChoices(
            { name: "low", value: "low" },
            { name: "medium", value: "medium" },
            { name: "high", value: "high" }
          )
      )
  );

  cmd.addSubcommand((sub) =>
    sub.setName("abort").setDescription("Cancel the current turn")
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("reset")
      .setDescription(
        "End the current ACP session for this thread; next message starts fresh"
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("tools")
      .setDescription("Set tool allow / exclude lists")
      .addStringOption((o) =>
        o
          .setName("action")
          .setDescription("allow | exclude")
          .setRequired(true)
          .addChoices(
            { name: "allow", value: "allow" },
            { name: "exclude", value: "exclude" }
          )
      )
      .addStringOption((o) =>
        o
          .setName("list")
          .setDescription("Comma-separated tool names (empty = clear)")
          .setRequired(false)
      )
  );

  cmd.addSubcommand((sub) =>
    sub.setName("config").setDescription("Show current session config")
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("config-set")
      .setDescription("Replace session config with a JSON blob")
      .addStringOption((o) =>
        o.setName("json").setDescription("Config JSON").setRequired(true)
      )
  );

  cmd.addSubcommand((sub) =>
    sub.setName("sessions").setDescription("List recent sessions")
  );

  cmd.addSubcommand((sub) =>
    sub.setName("repos").setDescription("List repos under REPOS_ROOT")
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("init")
      .setDescription("Bind this thread as a session and show repo picker")
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("approve")
      .setDescription("Set permission policy for this thread")
      .addStringOption((o) =>
        o
          .setName("policy")
          .setDescription("always | ask | deny")
          .setRequired(true)
          .addChoices(
            { name: "always (auto-approve everything)", value: "always" },
            { name: "ask (prompt me on Discord)", value: "ask" },
            { name: "deny (auto-deny everything)", value: "deny" }
          )
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("agent")
      .setDescription(
        "Get or set the agent for this thread (resets the session when changed)"
      )
      .addStringOption((o) =>
        o
          .setName("id")
          .setDescription("Agent id (e.g. copilot, gemini)")
          .setRequired(false)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("attach")
      .setDescription("Upload a local file from the host machine to this channel")
      .addStringOption((o) =>
        o
          .setName("path")
          .setDescription(
            "Absolute path, or path relative to an allowed root (REPOS_ROOT / ATTACH_ROOTS)"
          )
          .setRequired(true)
      )
  );

  cmd.addSubcommand((sub) =>
    sub.setName("avatar").setDescription("Push the bot avatar to Discord (force re-upload)")
  );

  cmd.addSubcommand((sub) =>
    sub.setName("help").setDescription("Show help")
  );

  return cmd;
}

export type SeamSubcommand =
  | "new"
  | "repo"
  | "model"
  | "mode"
  | "effort"
  | "abort"
  | "reset"
  | "tools"
  | "config"
  | "config-set"
  | "sessions"
  | "repos"
  | "init"
  | "approve"
  | "agent"
  | "attach"
  | "avatar"
  | "help";

export function getSubcommand(
  i: ChatInputCommandInteraction
): SeamSubcommand {
  return i.options.getSubcommand(true) as SeamSubcommand;
}
