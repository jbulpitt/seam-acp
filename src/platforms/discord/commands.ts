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
      .setDescription("Set reasoning effort (or run with no level to see current)")
      .addStringOption((o) =>
        o
          .setName("level")
          .setDescription("low | medium | high | xhigh | max — agent falls back if model doesn't support it")
          .setRequired(false)
          .addChoices(
            { name: "low", value: "low" },
            { name: "medium", value: "medium" },
            { name: "high", value: "high" },
            { name: "xhigh", value: "xhigh" },
            { name: "max", value: "max" }
          )
      )
  );

  cmd.addSubcommand((sub) =>
    sub.setName("abort").setDescription("Stop the current turn — cancel, then force-kill if it's hung")
  );

  cmd.addSubcommand((sub) =>
    sub.setName("cancel").setDescription("Gracefully cancel the current turn (cleaner; use abort if it ignores it)")
  );

  cmd.addSubcommand((sub) =>
    sub.setName("kill").setDescription("Force-kill ALL active agent sessions, including this thread (each resumes on next message)")
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("steer")
      .setDescription("Redirect a node mid-task: cancel its running turn and inject a new instruction (history kept)")
      .addStringOption((o) =>
        o
          .setName("thread")
          .setDescription("Target thread id to steer")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("prompt")
          .setDescription("The steering instruction to inject now")
          .setRequired(true)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("image")
      .setDescription("Generate an image (Nano Banana 2 / Pro, Imagen 4, FLUX 2)")
      .addStringOption((o) =>
        o
          .setName("prompt")
          .setDescription("Image prompt. Leave blank to type a longer one in a modal.")
          .setRequired(false)
      )
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
    sub
      .setName("workflows")
      .setDescription("View the delegation ledger + this thread's pending wakes (active + recent)")
      .addIntegerOption((o) =>
        o
          .setName("limit")
          .setDescription("How many recent rows to show (default 20)")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(100)
      )
      // Wakes are agent-authored bookkeeping (#59, D4) — surfaced here, not in
      // the human `/seam schedule` UI. This option cancels one pending wake in
      // the current thread by id (D6: visible + cancellable).
      .addStringOption((o) =>
        o
          .setName("cancel-wake")
          .setDescription("Cancel a pending wake in this thread by id")
          .setRequired(false)
      )
      // Watches (#60, D7) are agent-authored condition triggers — surfaced +
      // cancelled here (not in the human `/seam schedule` UI), same as wakes.
      .addStringOption((o) =>
        o
          .setName("cancel-watch")
          .setDescription("Cancel a pending watch in this thread by id")
          .setRequired(false)
      )
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
          .setDescription("Agent id (e.g. copilot, claude)")
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

  // Grouped under `/seam info` to stay within Discord's 25-option-per-command
  // cap (these are low-frequency meta commands). Routed via getSubcommandGroup.
  cmd.addSubcommandGroup((g) =>
    g
      .setName("info")
      .setDescription("Bot & account info")
      .addSubcommand((sub) =>
        sub.setName("whoami").setDescription("Show which account this thread's agent is signed in as")
      )
      .addSubcommand((sub) =>
        sub.setName("usage").setDescription("Show usage / credits for this thread's agent (agy only)")
      )
      .addSubcommand((sub) =>
        sub.setName("avatar").setDescription("Push the bot avatar and banner to Discord (force re-upload)")
      )
      .addSubcommand((sub) =>
        sub.setName("help").setDescription("Show help")
      )
  );

  cmd.addSubcommandGroup((g) =>
    g
      .setName("schedule")
      .setDescription("Recurring scheduled prompts for this thread")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Create a scheduled prompt (finish setup on the card)")
          .addAttachmentOption((o) =>
            o.setName("file").setDescription("Optional reference file (re-sent on every run)").setRequired(false)
          )
          .addAttachmentOption((o) =>
            o.setName("file2").setDescription("Optional reference file").setRequired(false)
          )
          .addAttachmentOption((o) =>
            o.setName("file3").setDescription("Optional reference file").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("List this thread's scheduled prompts")
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Delete a scheduled prompt")
          .addStringOption((o) => o.setName("id").setDescription("Schedule id (see /seam schedule list)").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("toggle")
          .setDescription("Enable or disable a scheduled prompt")
          .addStringOption((o) => o.setName("id").setDescription("Schedule id").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("addfile")
          .setDescription("Attach another reference file to a scheduled prompt")
          .addStringOption((o) => o.setName("id").setDescription("Schedule id").setRequired(true))
          .addAttachmentOption((o) => o.setName("file").setDescription("File to add").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("removefile")
          .setDescription("Remove a reference file from a scheduled prompt")
          .addStringOption((o) => o.setName("id").setDescription("Schedule id").setRequired(true))
          .addStringOption((o) => o.setName("filename").setDescription("Filename to remove").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription("Edit a scheduled prompt (reopens the builder card)")
          .addStringOption((o) => o.setName("id").setDescription("Schedule id").setRequired(true))
      )
  );

  // Presets: reusable bundles of session config (agent/model/effort/repo/
  // permission/tools/instructions). Name options are free-form strings —
  // autocomplete is not wired yet (no autocomplete handler exists bot-wide).
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
      )
      .addSubcommand((sub) =>
        sub
          .setName("apply")
          .setDescription("Apply a preset to the current thread")
          .addStringOption((o) =>
            o.setName("name").setDescription("Preset name").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a preset")
          .addStringOption((o) =>
            o.setName("name").setDescription("Preset name").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("show")
          .setDescription("Show a preset's details")
          .addStringOption((o) =>
            o.setName("name").setDescription("Preset name").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription("Edit an existing preset (reopens the builder card)")
          .addStringOption((o) =>
            o.setName("name").setDescription("Preset name").setRequired(true)
          )
      )
  );

  // Projects: DB-backed channel activation (#22). Activating a channel makes it
  // respond at runtime — additive to the static env allowlist, no redeploy.
  cmd.addSubcommandGroup((g) =>
    g
      .setName("project")
      .setDescription("Activate this channel for the bot (DB-backed, no redeploy)")
      .addSubcommand((sub) =>
        sub
          .setName("new")
          .setDescription("Activate the current channel")
          .addStringOption((o) =>
            o
              .setName("description")
              .setDescription("Optional note about this project")
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("List active channels")
      )
      .addSubcommand((sub) =>
        sub.setName("remove").setDescription("Deactivate the current channel")
      )
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
  | "cancel"
  | "kill"
  | "steer"
  | "image"
  | "reset"
  | "tools"
  | "config"
  | "config-set"
  | "sessions"
  | "workflows"
  | "repos"
  | "init"
  | "approve"
  | "agent"
  | "attach"
  | "whoami"
  | "usage"
  | "avatar"
  | "help";

export function getSubcommand(
  i: ChatInputCommandInteraction
): SeamSubcommand {
  return i.options.getSubcommand(true) as SeamSubcommand;
}
