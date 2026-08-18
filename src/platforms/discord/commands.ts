import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";

/**
 * `/seam` slash-command tree (#78).
 *
 * Discord caps each command at 25 top-level options (subcommands + groups).
 * The tree is 10/25: 5 top-level subcommands + 5 groups. Future surfaces
 * default to living INSIDE a group (each group has its own 25 budget).
 *
 *   TOP-LEVEL (5): cancel, steer, new, attach, workflows
 *   GROUPS (5):
 *     config   (12) model effort agent mode repo tools approve reset init show set audit
 *     info     (6)  whoami usage avatar help sessions repos
 *     schedule (7)  unchanged
 *     preset   (6)  unchanged
 *     project  (3)  unchanged
 */
export function buildSeamCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName("seam")
    .setDescription("Control the seam-acp agent");

  // --- top-level (5) --------------------------------------------------------

  cmd.addSubcommand((sub) =>
    sub
      .setName("cancel")
      .setDescription("Cancel this thread's turn; force:true escalates, scope:all kills every session")
      .addBooleanOption((o) =>
        o
          .setName("force")
          .setDescription("Force-kill this thread's turn if it ignores the cancel (old /seam abort)")
          .setRequired(false)
      )
      // Options are free (they don't count toward the 25 top-level cap).
      // `scope:all` is the old `/seam kill` — privileged, NOT lock-exempt
      // and NOT participant-allowed. Gates inspect the resolved option.
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("Kill every active session bot-wide (old /seam kill)")
          .setRequired(false)
          .addChoices({ name: "all", value: "all" })
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("steer")
      .setDescription("Steer a node mid-task: queue a note to its inbox, or now:true to cancel-and-reprompt (history kept)")
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
      // #63: options are free (they don't count toward the 25 top-level cap), so
      // the two tiers live on this one command. Default false = cooperative inbox
      // push (#61); true = preemptive cancel-and-reprompt (the original behavior).
      .addBooleanOption((o) =>
        o
          .setName("now")
          .setDescription("Preemptive: cancel the running turn and reprompt now (default: queue to inbox, no cancel)")
          .setRequired(false)
      )
  );

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

  // --- groups (5) -----------------------------------------------------------

  cmd.addSubcommandGroup((g) =>
    g
      .setName("config")
      .setDescription("Session and bot configuration")
      .addSubcommand((sub) =>
        sub
          .setName("model")
          .setDescription("Get or set the agent model for this thread")
          .addStringOption((o) =>
            o.setName("id").setDescription("Model id").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
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
      )
      .addSubcommand((sub) =>
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
      )
      .addSubcommand((sub) =>
        sub
          .setName("mode")
          .setDescription("Set the agent operational mode")
          .addStringOption((o) =>
            o.setName("id").setDescription("Mode id").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("repo")
          .setDescription("Set the working repo for this thread")
          .addStringOption((o) =>
            o
              .setName("path")
              .setDescription("Path under REPOS_ROOT (or absolute)")
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
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
      )
      .addSubcommand((sub) =>
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
      )
      .addSubcommand((sub) =>
        sub
          .setName("reset")
          .setDescription(
            "End the current ACP session for this thread; next message starts fresh"
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("init")
          .setDescription("Bind this thread as a session and show repo picker")
      )
      .addSubcommand((sub) =>
        sub.setName("show").setDescription("Show current session config")
      )
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Replace session config with a JSON blob")
          .addStringOption((o) =>
            o.setName("json").setDescription("Config JSON").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("audit")
          .setDescription("Show recent config mutations (who/what/when), newest first")
          .addIntegerOption((o) =>
            o
              .setName("limit")
              .setDescription("How many recent mutations to show (default 20)")
              .setRequired(false)
              .setMinValue(1)
              .setMaxValue(100)
          )
          .addStringOption((o) =>
            o
              .setName("entry")
              .setDescription("Show the before→after diff for one entry id")
              .setRequired(false)
          )
      )
  );

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
      .addSubcommand((sub) =>
        sub.setName("sessions").setDescription("List recent sessions")
      )
      .addSubcommand((sub) =>
        sub.setName("repos").setDescription("List repos under REPOS_ROOT")
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
  | "cancel"
  | "steer"
  | "attach"
  | "workflows"
  | "model"
  | "effort"
  | "agent"
  | "mode"
  | "repo"
  | "tools"
  | "approve"
  | "reset"
  | "init"
  | "show"
  | "set"
  | "audit"
  | "whoami"
  | "usage"
  | "avatar"
  | "help"
  | "sessions"
  | "repos";

export function getSubcommand(
  i: ChatInputCommandInteraction
): SeamSubcommand {
  return i.options.getSubcommand(true) as SeamSubcommand;
}
