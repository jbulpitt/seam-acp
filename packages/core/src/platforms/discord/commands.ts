import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";

/**
 * `/seam` slash-command tree (#78).
 *
 * Discord caps each command at 25 top-level options (subcommands + groups).
 * The tree is 15/25: 6 top-level subcommands + 9 groups. Future surfaces
 * default to living INSIDE a group (each group has its own 25 budget).
 *
 *   TOP-LEVEL (6): cancel, steer, new, workflows, queue, rebuild
 *   GROUPS (9):
 *     config   (17) model effort agent mode repo tools card gif approve reset init detach tts show edit set audit
 *     info     (6)  whoami usage avatar help sessions repos
 *     schedule (7)  unchanged
 *     preset   (7)  list create apply delete show edit thread
 *     project  (3)  unchanged
 *     upload   (3)  pull push secret  — admin-only; hard cutover of /seam attach
 *     bridge   (4)  add rotate list remove  — admin-only pairing (#83/#86)
 *     debug    (6)  tail exec status voice-ping voice-capture voice-live — admin-only even when SEAM_BRIDGE_DEV (#83)
 *     voice    (7)  start add remove configure console status stop — Voice Console V2, admin-only
 */
export function buildSeamCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName("seam")
    .setDescription("Control the seam-acp agent");

  // --- top-level (6): cancel, steer, new, workflows, queue, rebuild --------

  cmd.addSubcommand((sub) =>
    sub
      .setName("cancel")
      .setDescription("Cancel this turn; force escalates, scope:all stops all sessions")
      .addBooleanOption((o) =>
        o
          .setName("force")
          .setDescription("Force-stop this turn if graceful cancel fails")
          .setRequired(false)
      )
      // Options are free (they don't count toward the 25 top-level cap).
      // `scope:all` is the old `/seam kill` — privileged, NOT lock-exempt
      // and NOT participant-allowed. Gates inspect the resolved option.
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("Stop every active session")
          .setRequired(false)
          .addChoices({ name: "all", value: "all" })
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("steer")
      .setDescription("Steer a node mid-task: queue a note to its inbox, or now:true to cancel-and-reprompt (history kept)")
      // Discord rejects the whole /seam PUT if a required option follows an
      // optional one (APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID). prompt
      // must come first; thread defaults to the invoking channel in cmdSteer.
      .addStringOption((o) =>
        o
          .setName("prompt")
          .setDescription("The steering instruction to inject now")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("thread")
          .setDescription("Target thread id (default: this thread)")
          .setRequired(false)
          .setAutocomplete(true)
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
          .setAutocomplete(true)
      )
      // Watches (#60, D7) are agent-authored condition triggers — surfaced +
      // cancelled here (not in the human `/seam schedule` UI), same as wakes.
      .addStringOption((o) =>
        o
          .setName("cancel-watch")
          .setDescription("Cancel a pending watch in this thread by id")
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName("cancel-choice")
          .setDescription("Cancel an open choice card in this thread by id")
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName("cancel-ingest")
          .setDescription("Revoke a headless ingest endpoint in this thread by id")
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName("cancel-live")
          .setDescription("Hang up a live-help Gemini voice call by id")
          .setRequired(false)
          .setAutocomplete(true)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("queue")
      .setDescription("Queue the next live turn in this thread (waits; does not abort the current one)")
      .addStringOption((o) =>
        o
          .setName("prompt")
          .setDescription("The prompt to run when the current turn ends (or now, if idle)")
          .setRequired(true)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("rebuild")
      .setDescription("Rebuild this session from Discord thread history, optionally changing agent/model")
      .addStringOption((o) =>
        o
          .setName("agent")
          .setDescription("Target agent id (uses its default model when model is omitted)")
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("model")
          .setDescription("Target model id")
          .setRequired(false)
      )
  );

  // --- groups (9) -----------------------------------------------------------

  cmd.addSubcommandGroup((g) =>
    g
      .setName("config")
      .setDescription("Session and bot configuration")
      .addSubcommand((sub) =>
        sub
          .setName("model")
          .setDescription("Get or set the agent model for this thread")
          .addStringOption((o) =>
            o.setName("id").setDescription("Model id").setRequired(false).setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("effort")
          .setDescription("Set reasoning effort (or run with no level to see current)")
          .addStringOption((o) =>
            o
              .setName("level")
              .setDescription("low | medium | high | xhigh | max | ultra — agent falls back if model doesn't support it")
              .setRequired(false)
              .addChoices(
                { name: "low", value: "low" },
                { name: "medium", value: "medium" },
                { name: "high", value: "high" },
                { name: "xhigh", value: "xhigh" },
                { name: "max", value: "max" },
                { name: "ultra", value: "ultra" }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("agent")
          .setDescription(
            "Get or set the agent@location for this thread (resets the session when changed)"
          )
          .addStringOption((o) =>
            o
              .setName("id")
              .setDescription("agent id or agentId@location (e.g. claude, claude@mac)")
              .setRequired(false)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("role")
          .setDescription("Set naming role")
          .addStringOption((o) =>
            o
              .setName("value")
              .setDescription("Role; auto clears")
              .setRequired(false)
          )
          .addStringOption((o) =>
            o
              .setName("scope")
              .setDescription("Save scope")
              .setRequired(false)
              .addChoices(
                { name: "session", value: "session" },
                { name: "thread", value: "thread" },
                { name: "channel", value: "channel" }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("mode")
          .setDescription("Set the agent operational mode")
          .addStringOption((o) =>
            o.setName("id").setDescription("Mode id").setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("repo")
          .setDescription("Set the working repo for this thread")
          .addStringOption((o) =>
            o
              .setName("path")
              .setDescription("Path under REPOS_ROOT (or absolute). Omit to open a picker.")
              .setRequired(false)
              .setAutocomplete(true)
          )
          .addStringOption((o) =>
            o
              .setName("scope")
              .setDescription("session (this thread, default) | thread preset | channel (all threads)")
              .setRequired(false)
              .addChoices(
                { name: "session (this thread override)", value: "session" },
                { name: "thread preset", value: "thread" },
                { name: "channel (all threads inherit)", value: "channel" }
              )
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
          .setName("card")
          .setDescription("Get or set the status-card layout (full or simple)")
          .addStringOption((o) =>
            o
              .setName("style")
              .setDescription("full (default) | simple (compact, brand icon)")
              .setRequired(false)
              .addChoices(
                { name: "full", value: "full" },
                { name: "simple", value: "simple" }
              )
          )
          .addStringOption((o) =>
            o
              .setName("scope")
              .setDescription("session (this thread, default) | thread preset | channel (all threads)")
              .setRequired(false)
              .addChoices(
                { name: "session (this thread override)", value: "session" },
                { name: "thread preset", value: "thread" },
                { name: "channel (all threads inherit)", value: "channel" }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("gif")
          .setDescription("Random GIF thumbnail on the simple status card (on or off)")
          .addStringOption((o) =>
            o
              .setName("state")
              .setDescription("on | off")
              .setRequired(false)
              .addChoices(
                { name: "on", value: "on" },
                { name: "off", value: "off" }
              )
          )
          .addStringOption((o) =>
            o
              .setName("scope")
              .setDescription("session (this thread, default) | thread preset | channel (all threads)")
              .setRequired(false)
              .addChoices(
                { name: "session (this thread override)", value: "session" },
                { name: "thread preset", value: "thread" },
                { name: "channel (all threads inherit)", value: "channel" }
              )
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
        sub
          .setName("detach")
          .setDescription(
            "Stop treating this thread as a session (no bot replies). Does not delete history."
          )
          .addStringOption((o) =>
            o
              .setName("state")
              .setDescription("detached = no bot replies; attached = bind on next message")
              .setRequired(true)
              .addChoices(
                { name: "detached", value: "detached" },
                { name: "attached", value: "attached" }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("tts")
          .setDescription("TTS settings card (omit options), or set on/off/voice/pace/style now")
          .addStringOption((o) =>
            o
              .setName("state")
              .setDescription("on = attach a spoken copy after each turn; off = text only")
              .setRequired(false)
              .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })
          )
          .addStringOption((o) =>
            o
              .setName("voice")
              .setDescription("Gemini TTS voice (autocomplete; in-thread sample on the TTS card)")
              .setRequired(false)
              .setAutocomplete(true)
          )
          .addStringOption((o) =>
            o
              .setName("pace")
              .setDescription("Spoken pacing (director's note)")
              .setRequired(false)
              .addChoices(
                { name: "slow", value: "slow" },
                { name: "natural", value: "natural" },
                { name: "fast", value: "fast" },
                { name: "faster", value: "faster" }
              )
          )
          .addStringOption((o) =>
            o
              .setName("style")
              .setDescription("Spoken style (director's note)")
              .setRequired(false)
              .addChoices(
                { name: "neutral", value: "neutral" },
                { name: "warm", value: "warm" },
                { name: "clear", value: "clear" }
              )
          )
      )
      .addSubcommand((sub) =>
        sub.setName("show").setDescription("Show current session config")
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription("Open the visual thread config editor (draft, then Save/Cancel)")
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
      .addSubcommand((sub) =>
        sub
          .setName("rename")
          .setDescription("Rename")
          .addStringOption((o) =>
            o
              .setName("scope")
              .setDescription("Scope")
              .setRequired(false)
              .addChoices(
                { name: "thread", value: "thread" },
                { name: "channel", value: "channel" }
              )
          )
          .addBooleanOption((o) =>
            o
              .setName("migrate-legacy")
              .setDescription("Legacy")
              .setRequired(false)
          )
          .addBooleanOption((o) =>
            o
              .setName("role-name")
              .setDescription("Use role as base")
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("namer")
          .setDescription("Edit naming rules")
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
        sub.setName("usage").setDescription("Show usage / credits for this thread's agent (agy, claude, copilot, grok, codex)")
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
          .addStringOption((o) =>
            o
              .setName("id")
              .setDescription("Schedule id (see /seam schedule list)")
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("toggle")
          .setDescription("Enable or disable a scheduled prompt")
          .addStringOption((o) =>
            o.setName("id").setDescription("Schedule id").setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("addfile")
          .setDescription("Attach another reference file to a scheduled prompt")
          .addStringOption((o) =>
            o.setName("id").setDescription("Schedule id").setRequired(true).setAutocomplete(true)
          )
          .addAttachmentOption((o) => o.setName("file").setDescription("File to add").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("removefile")
          .setDescription("Remove a reference file from a scheduled prompt")
          .addStringOption((o) =>
            o.setName("id").setDescription("Schedule id").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((o) =>
            o
              .setName("filename")
              .setDescription("Filename to remove")
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription("Edit a scheduled prompt (reopens the builder card)")
          .addStringOption((o) =>
            o.setName("id").setDescription("Schedule id").setRequired(true).setAutocomplete(true)
          )
      )
  );

  // Presets: reusable bundles of session config (agent/model/effort/repo/
  // permission/tools/instructions). Existing-preset name options
  // (`thread.preset`, `apply`/`delete`/`show`/`edit` `name`) autocomplete via
  // the bot-wide AutocompleteRegistry (#93). `create` takes a NEW name and
  // stays free-form.
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

  // Admin-only host file xfer. Hard cutover of top-level `/seam attach`.
  cmd.addSubcommandGroup((g) =>
    g
      .setName("upload")
      .setDescription("Admin-only: pull/push host files, or pass a one-shot secret")
      .addSubcommand((sub) =>
        sub
          .setName("pull")
          .setDescription("Post a host file into this thread (zips if over Discord's size cap)")
          .addStringOption((o) =>
            o
              .setName("path")
              .setDescription("Absolute path, or relative to the bot process cwd")
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("push")
          .setDescription("Write an uploaded Discord file to a host path")
          .addAttachmentOption((o) =>
            o.setName("file").setDescription("File to write on the host").setRequired(true)
          )
          .addStringOption((o) =>
            o
              .setName("path")
              .setDescription("Absolute dest, or relative to the bot process cwd")
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("secret")
          .setDescription("One-shot secret for this thread (path-only; deleted after the next turn)")
      )
  );

  cmd.addSubcommandGroup((g) =>
    g
      .setName("bridge")
      .setDescription("Admin-only: pair, rotate, list, or remove remote bridges")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Pair a new bridge (prints a one-line bootstrap with the token once)")
          .addStringOption((o) =>
            o.setName("name").setDescription("Bridge name (becomes the id slug)").setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("emoji").setDescription("Host emoji (D11)").setRequired(false)
          )
          .addStringOption((o) =>
            o.setName("short-name").setDescription("Short display name").setRequired(false)
          )
          .addStringOption((o) =>
            o
              .setName("workspace-root")
              .setDescription("Host workspace root this bridge exposes")
              .setRequired(false)
          )
          .addStringOption((o) =>
            o
              .setName("url")
              .setDescription("Client-mode: wss URL of the bridge (omit for server-mode bootstrap)")
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("rotate")
          .setDescription("Issue a new token for a paired bridge")
          .addStringOption((o) =>
            o.setName("name").setDescription("Bridge id or name").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("List paired bridges and connection status")
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Unpair a bridge")
          .addStringOption((o) =>
            o.setName("name").setDescription("Bridge id or name").setRequired(true)
          )
      )
  );

  cmd.addSubcommandGroup((g) =>
    g
      .setName("debug")
      .setDescription("Admin-only: tail, exec, status a paired bridge, or live-help voice spike")
      .addSubcommand((sub) =>
        sub
          .setName("tail")
          .setDescription("Tail a log file on the bridge host (dev-mode)")
          .addStringOption((o) =>
            o.setName("bridge").setDescription("Paired bridge id").setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("path").setDescription("Log path under the host workspace root").setRequired(false)
          )
          .addIntegerOption((o) =>
            o.setName("lines").setDescription("Lines to return (default 80)").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("exec")
          .setDescription("Run a command on the bridge host (dev-mode)")
          .addStringOption((o) =>
            o.setName("bridge").setDescription("Paired bridge id").setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("command").setDescription("Command to run (dev-mode shell)").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("status")
          .setDescription("Show bridge connection, inventory, and ready state")
          .addStringOption((o) =>
            o.setName("bridge").setDescription("Paired bridge id (default: all)").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("voice-ping")
          .setDescription("Spike: join the test General VC, play a sample, leave")
      )
      .addSubcommand((sub) =>
        sub
          .setName("voice-capture")
          .setDescription("Spike: join General, capture your voice to 16 kHz PCM, leave")
      )
      .addSubcommand((sub) =>
        sub
          .setName("voice-live")
          .setDescription("Spike: capture in General, Gemini Live replies in the VC")
      )
  );

  cmd.addSubcommandGroup((g) =>
    g
      .setName("voice")
      .setDescription("Shared Voice Console (admin)")
      .addSubcommand((sub) =>
        sub
          .setName("start")
          .setDescription("Start a console in your self-muted VC")
          .addStringOption((o) =>
            o.setName("alias").setDescription("Binding alias").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Add this thread to the console")
          .addStringOption((o) =>
            o.setName("alias").setDescription("Binding alias").setRequired(false)
          )
          .addBooleanOption((o) =>
            o.setName("claim").setDescription("Select it for input (default true)").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove this binding; preserve finalized text")
          .addBooleanOption((o) =>
            o.setName("discard-pending").setDescription("Discard unowned finalized text").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("configure")
          .setDescription("Set alias and speech profile for this binding")
          .addStringOption((o) =>
            o.setName("alias").setDescription("Unique alias").setRequired(false)
          )
          .addStringOption((o) =>
            o.setName("voice").setDescription("TTS voice").setRequired(false).setAutocomplete(true)
          )
          .addStringOption((o) =>
            o.setName("pace").setDescription("Speech pace").setRequired(false)
              .addChoices(
                { name: "slow", value: "slow" },
                { name: "natural", value: "natural" },
                { name: "fast", value: "fast" },
                { name: "faster", value: "faster" }
              )
          )
          .addStringOption((o) =>
            o.setName("style").setDescription("Speech style").setRequired(false)
              .addChoices(
                { name: "neutral", value: "neutral" },
                { name: "warm", value: "warm" },
                { name: "clear", value: "clear" }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("console")
          .setDescription("Show or repost the VC control card")
          .addBooleanOption((o) =>
            o.setName("repost").setDescription("Replace the card in VC chat").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("status")
          .setDescription("Show console diagnostics")
      )
      .addSubcommand((sub) =>
        sub
          .setName("stop")
          .setDescription("Stop console; preserve finalized text")
          .addBooleanOption((o) =>
            o
              .setName("discard-pending")
              .setDescription("Delete undispatched finalized text")
              .setRequired(false)
          )
      )
  );

  return cmd;
}

export type SeamSubcommand =
  | "new"
  | "cancel"
  | "steer"
  | "workflows"
  | "rebuild"
  | "pull"
  | "push"
  | "secret"
  | "model"
  | "effort"
  | "agent"
  | "mode"
  | "repo"
  | "tools"
  | "approve"
  | "reset"
  | "init"
  | "detach"
  | "show"
  | "edit"
  | "set"
  | "audit"
  | "whoami"
  | "usage"
  | "avatar"
  | "help"
  | "sessions"
  | "repos"
  | "add"
  | "rotate"
  | "list"
  | "remove"
  | "tail"
  | "exec"
  | "status"
  | "voice-ping"
  | "voice-capture"
  | "voice-live"
  | "start"
  | "stop";

export function getSubcommand(
  i: ChatInputCommandInteraction
): SeamSubcommand {
  return i.options.getSubcommand(true) as SeamSubcommand;
}
