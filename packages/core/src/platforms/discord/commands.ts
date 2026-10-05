import { PRESET_COMMAND_GROUP, PRESET_ACCESS } from "../../plugins/presets/commands.js";
import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandSubcommandGroupBuilder,
  SlashCommandSubcommandBuilder,
  type ChatInputCommandInteraction,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { addConfigSetOptions, CONFIG_UI_GROUP, CONFIG_UI_LEAVES } from "../../plugins/config-ui/commands.js";
import type { SlashRegistry } from "../../plugins/slash-registry.js";
import type { InteractionResponseMode } from "../interaction-response.js";

/** The everyday user + agent surface. */
export const SEAM_COMMAND_NAME = "seam";
/** The operator surface — ManageGuild-gated, guild-only (#151). */
export const SEAM_ADMIN_COMMAND_NAME = "seamadmin";

export interface SlashCommandAccess {
  kind: "read-only" | "mutating";
  participantAllowed?: boolean;
  lockExempt?: boolean;
}

type SlashOptionReader = (name: string) => string | null | undefined;
type SlashAccessDeclaration = SlashCommandAccess | ((option: SlashOptionReader) => SlashCommandAccess);
const accessDeclarations = new WeakMap<SlashCommandSubcommandBuilder, SlashAccessDeclaration>();
const acknowledgementDeclarations = new WeakMap<SlashCommandSubcommandBuilder, InteractionResponseMode>();

/** Keep access on the leaf, without adding fields to Discord's JSON. */
function declareAccess(
  sub: SlashCommandSubcommandBuilder,
  declaration: SlashAccessDeclaration,
  acknowledgement: InteractionResponseMode
): SlashCommandSubcommandBuilder {
  accessDeclarations.set(sub, declaration);
  acknowledgementDeclarations.set(sub, acknowledgement);
  return sub;
}

/**
 * The two slash-command trees (#78, split in #151).
 *
 * Discord caps a SINGLE application command at 8,000 characters — the sum of
 * every name, description and choice value in the whole tree — and at 25
 * top-level options. Exceeding either makes Discord reject registration of the
 * ENTIRE command at boot, not just the offending option.
 *
 * `/seam` hit 7,885 of 8,000. #150 could only land `role-name` by DELETING help
 * text ("Refresh/migrate names" → "Rename"). The budget is per command, not per
 * bot, so a second registered command gets a fresh 8,000 — that is the whole
 * fix. `test/commands.test.ts` guards both at 7,900.
 *
 *   /seam       (8 slots)  everyday surface — no admin verbs
 *     cancel · steer · new · workflows · queue
 *     info   (6)  whoami usage avatar help sessions repos
 *     preset (7)  list create apply delete show edit thread
 *     config (18) model effort agent role mode repo tools card gif approve
 *                 reset init detach tts show edit set audit
 *
 *   /seamadmin  (12 slots)  operator surface — ManageGuild + guild-only
 *     rebuild · compact-thread · recover
 *     project  (3)  new list remove
 *     upload   (3)  pull push secret
 *     bridge   (6)  add rotate configure list remove restart
 *     schedule (5)  add list remove toggle edit — no attachments (#158)
 *     debug    (5)  work status voice-ping voice-capture voice-live
 *     voice    (7)  start add remove configure console status stop
 *     naming   (2)  rename namer — lifted out of `config` (#151)
 *
 * The Discord permission is a VISIBILITY control, not the authorization model:
 * every runtime refusal (`SEAM_CONFIG_ADMIN_USER_IDS`, `BRIDGE_ADMIN_REFUSAL`,
 * `THREAD_VOICE_ADMIN_REFUSAL`, and plugin authorization) remains in dispatch.
 * A guild admin can still grant `/seamadmin` to anyone.
 */
export function buildSeamCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName(SEAM_COMMAND_NAME)
    .setDescription("Control the seam-acp agent");

  // --- top-level (5): cancel, steer, new, workflows, queue ------------------

  cmd.addSubcommand((sub) =>
    declareAccess(sub, (option) => ({
      kind: "mutating",
      participantAllowed: option("scope") !== "all",
      lockExempt: option("scope") !== "all",
    }), "ephemeral")
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
    declareAccess(sub, { kind: "mutating", lockExempt: true }, "ephemeral")
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
    addConfigSetOptions(
      declareAccess(sub, { kind: "mutating" }, "ephemeral")
        .setName("new")
        .setDescription("Create and optionally configure an agent thread")
        .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Thread name (optional)")
          .setRequired(false)
      )
    )
  );

  cmd.addSubcommand((sub) =>
    declareAccess(sub, (option) => ({
      kind: ["abandon-older-than", "resume", "cancel-wake", "cancel-watch", "cancel-choice", "cancel-ingest", "cancel-live"]
        .some((name) => option(name)) ? "mutating" : "read-only",
    }), "ephemeral")
      .setName("workflows")
      .setDescription("View this thread's workflows and parked turns, newest first")
      .addStringOption(o => o.setName("scope").setDescription("This thread (default), or all threads for admins")
        .addChoices({ name: "This thread", value: "thread" }, { name: "All threads (admin)", value: "all" }))
      .addStringOption(o => o.setName("resume").setDescription("Continue a parked turn in this thread")
        .setAutocomplete(true))
      .addBooleanOption(o => o.setName("history").setDescription("Include old inert history (records are kept)"))
      .addStringOption(o => o.setName("abandon-older-than").setDescription("Admin: abandon all parked items in this scope older than N days"))
      .addIntegerOption((o) =>
        o
          .setName("limit")
          .setDescription("How many recent rows to show (default 20)")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(100)
      )
      // Wakes are agent-authored bookkeeping (#59, D4) — surfaced here, not in
      // the human `/seamadmin schedule` UI. This option cancels one pending wake in
      // the current thread by id (D6: visible + cancellable).
      .addStringOption((o) =>
        o
          .setName("cancel-wake")
          .setDescription("Cancel a pending wake in this thread by id")
          .setRequired(false)
          .setAutocomplete(true)
      )
      // Watches (#60, D7) are agent-authored condition triggers — surfaced +
      // cancelled here (not in the human `/seamadmin schedule` UI), same as wakes.
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
    declareAccess(sub, { kind: "mutating", participantAllowed: true, lockExempt: true }, "public")
      .setName("queue")
      .setDescription("Queue the next live turn in this thread (waits; does not abort the current one)")
      .addStringOption((o) =>
        o
          .setName("prompt")
          .setDescription("The prompt to run when the current turn ends (or now, if idle)")
          .setRequired(true)
      )
  );

  // --- core groups: config, info -------------------------------------------

  cmd.addSubcommandGroup((g) =>
    g
      .setName("config")
      .setDescription("Session and bot configuration")
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("model")
          .setDescription("Get or set the agent model for this thread")
          .addStringOption((o) =>
            o.setName("id").setDescription("Model id").setRequired(false).setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("effort")
          .setDescription("Set reasoning effort (or run with no level to see current)")
          .addStringOption((o) =>
            o
              .setName("level")
              .setDescription("Model-supported effort")
              .setRequired(false)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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
        declareAccess(sub, (option) => ({ kind: option("value") != null ? "mutating" : "read-only" }), "ephemeral")
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
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("mode")
          .setDescription("Set the agent operational mode")
          .addStringOption((o) =>
            o.setName("id").setDescription("Mode id").setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("reset")
          .setDescription(
            "End the current ACP session for this thread; next message starts fresh"
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("init")
          .setDescription("Bind this thread + open the config card")
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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

  );

  cmd.addSubcommandGroup((g) =>
    g
      .setName("info")
      .setDescription("Bot & account info")
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "read-only" }, "ephemeral").setName("whoami").setDescription("Show which account this thread's agent is signed in as")
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral").setName("avatar").setDescription("Push the bot avatar and banner to Discord (force re-upload)")
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "read-only" }, "ephemeral").setName("help").setDescription("Show help")
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "read-only" }, "ephemeral").setName("repos").setDescription("List repos under REPOS_ROOT")
      )
  );


  return cmd;
}

/**
 * The operator surface (#151).
 *
 * `setDefaultMemberPermissions(ManageGuild)` hides it from non-admins in the
 * command picker entirely — today every admin verb is visible to everyone and
 * only refuses at runtime. `setContexts(Guild)` replaces the deprecated
 * `setDMPermission(false)`: none of these verbs mean anything in a DM.
 */
export function buildSeamAdminCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName(SEAM_ADMIN_COMMAND_NAME)
    .setDescription("Operator surface: hosts, schedules, uploads, voice, naming")
    // Visibility gate only — the runtime refusals remain the authorization model.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    // Guild-only. setDMPermission is deprecated; setContexts is the replacement.
    .setContexts(InteractionContextType.Guild);

  // --- top-level (4): rebuild, compact-thread, recover, canary ---------------

  cmd.addSubcommand((sub) =>
    declareAccess(sub, { kind: "mutating" }, "ephemeral")
      .setName("rebuild")
      .setDescription("Deterministic Discord reconstruction (no summarizer; one seed turn, ≤60% window)")
  );

  cmd.addSubcommand((sub) =>
    declareAccess(sub, { kind: "mutating" }, "ephemeral")
      .setName("compact-thread")
      .setDescription("Model-assisted reconstruction from Discord history")
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

  cmd.addSubcommand((sub) =>
    declareAccess(sub, { kind: "mutating" }, "ephemeral")
      .setName("recover")
      .setDescription("Diagnose and repair one channel queue without restarting the bot")
      .addStringOption((o) =>
        o.setName("thread").setDescription("Thread id to recover").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName("mode")
          .setDescription("auto refuses healthy work; force invalidates it")
          .setRequired(false)
          .addChoices(
            { name: "auto", value: "auto" },
            { name: "force", value: "force" }
          )
      )
  );

  cmd.addSubcommand((sub) =>
    declareAccess(sub, { kind: "mutating" }, "ephemeral")
      .setName("canary")
      .setDescription("Run the real host and agent matrix on a deployment")
      .addStringOption((o) =>
        o
          .setName("target")
          .setDescription("Deployment to test")
          .setRequired(true)
          .addChoices(
            { name: "staging", value: "staging" },
            { name: "self", value: "self" },
          )
      )
  );

  cmd.addSubcommandGroup((group) => group
    .setName("models")
    .setDescription("Hide models from lists without banning their use")
    .addSubcommand((sub) => declareAccess(sub, { kind: "mutating" }, "ephemeral").setName("hide").setDescription("Hide matching models")
      .addStringOption((option) => option.setName("pattern").setDescription("[agent[@host]:]model-glob").setRequired(true)))
    .addSubcommand((sub) => declareAccess(sub, { kind: "mutating" }, "ephemeral").setName("unhide").setDescription("Remove a hide pattern")
      .addStringOption((option) => option.setName("pattern").setDescription("Exact hide pattern to remove").setRequired(true)))
    .addSubcommand((sub) => declareAccess(sub, { kind: "read-only" }, "ephemeral").setName("list").setDescription("List hidden model patterns")));

  // --- groups --------------------------------------------------------------


  // Projects: DB-backed channel activation (#22). Activating a channel makes it
  // respond at runtime — additive to the static env allowlist, no redeploy.
  cmd.addSubcommandGroup((g) =>
    g
      .setName("project")
      .setDescription("Activate this channel for the bot (DB-backed, no redeploy)")
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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
        declareAccess(sub, { kind: "read-only" }, "ephemeral").setName("list").setDescription("List active channels")
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral").setName("remove").setDescription("Deactivate the current channel")
      )
  );

  // Admin-only host file xfer. Hard cutover of top-level `/seam attach`.
  cmd.addSubcommandGroup((g) =>
    g
      .setName("upload")
      .setDescription("Admin-only: pull/push host files, or pass a temporary secret")
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "read-only" }, "ephemeral")
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
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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
        declareAccess(sub, { kind: "mutating" }, "modal")
          .setName("secret")
          .setDescription("Temporary secret for this thread (path-only; expires after about 1 hour)")
      )
  );

  cmd.addSubcommandGroup((g) =>
    g
      .setName("bridge")
      .setDescription("Admin-only: pair and configure remote bridges")
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("rotate")
          .setDescription("Issue a new token for a paired bridge")
          .addStringOption((o) =>
            o.setName("name").setDescription("Bridge id or name").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("configure")
          .setDescription("Set a bridge workspace fallback for legacy hellos")
          .addStringOption((o) =>
            o.setName("name").setDescription("Bridge id or name").setRequired(true)
          )
          .addStringOption((o) =>
            o
              .setName("workspace-root")
              .setDescription("Absolute POSIX workspace path on the bridge host")
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "read-only" }, "ephemeral").setName("list").setDescription("List paired bridges and connection status")
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("remove")
          .setDescription("Unpair a bridge")
          .addStringOption((o) =>
            o.setName("name").setDescription("Bridge id or name").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("restart")
          .setDescription("Stage a controller restart")
      )
  );

  cmd.addSubcommandGroup((g) =>
    g
      .setName("debug")
      .setDescription("Admin-only: bridge status, active work, or live-help voice spike")
      .addSubcommand((sub) => declareAccess(sub, { kind: "read-only" }, "ephemeral").setName("work").setDescription("Identify active scheduled work and restart blockers"))
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "read-only" }, "ephemeral")
          .setName("status")
          .setDescription("Show bridge connection, inventory, and ready state")
          .addStringOption((o) =>
            o.setName("bridge").setDescription("Paired bridge id (default: all)").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("voice-ping")
          .setDescription("Spike: join the test General VC, play a sample, leave")
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("voice-capture")
          .setDescription("Spike: join General, capture your voice to 16 kHz PCM, leave")
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("voice-live")
          .setDescription("Spike: capture in General, Gemini Live replies in the VC")
      )
  );

  cmd.addSubcommandGroup((g) =>
    g
      .setName("voice")
      .setDescription("Shared Voice Console (admin)")
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("start")
          .setDescription("Start a console in your self-muted VC")
          .addStringOption((o) =>
            o.setName("alias").setDescription("Binding alias").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("remove")
          .setDescription("Remove this binding; preserve finalized text")
          .addBooleanOption((o) =>
            o.setName("discard-pending").setDescription("Discard unowned finalized text").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("console")
          .setDescription("Show or repost the VC control card")
          .addBooleanOption((o) =>
            o.setName("repost").setDescription("Replace the card in VC chat").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "read-only" }, "ephemeral")
          .setName("status")
          .setDescription("Show console diagnostics")
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
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

  cmd.addSubcommandGroup((g) =>
    g
      .setName("catalog")
      .setDescription("Refresh cached model catalogs")
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "public")
          .setName("refresh")
          .setDescription("Refresh one agent@host or all catalogs")
          .addStringOption((o) =>
            o
              .setName("agent")
              .setDescription("agent@host or all")
              .setRequired(true)
              .setAutocomplete(true)
          )
          // #236: the bounded operator escape hatch for a quarantined
          // reduction. One refresh, one binding, never persisted.
          .addBooleanOption((o) =>
            o
              .setName("accept-reduction")
              .setDescription("Accept a quarantined model removal this once")
          )
          .addBooleanOption((o) =>
            o
              .setName("refresh-sources")
              .setDescription("Also force intelligence sources and publish")
          )
      )
  );

  // Runtime-only agent routing guard (#308). Rules are audited in the existing
  // config-mutation ledger, never written to an env/config file.
  cmd.addSubcommandGroup((g) =>
    g
      .setName("restrictions")
      .setDescription("Admin-only: restrict an agent to named Discord channels")
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("set")
          .setDescription("Set one agent's complete comma-separated channel allowlist")
          .addStringOption((o) =>
            o.setName("agent").setDescription("Agent id to restrict").setRequired(true)
          )
          .addStringOption((o) =>
            o
              .setName("channels")
              .setDescription("Comma-separated channel ids or #channel mentions")
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "read-only" }, "ephemeral").setName("list").setDescription("List active agent channel allowlists")
      )
      .addSubcommand((sub) =>
        declareAccess(sub, { kind: "mutating" }, "ephemeral")
          .setName("clear")
          .setDescription("Clear one agent's channel allowlist")
          .addStringOption((o) =>
            o.setName("agent").setDescription("Agent id to unrestrict").setRequired(true)
          )
      )
  );


  return cmd;
}

/**
 * The exact payload `registerSlashCommands` PUTs to Discord. Extracted so the
 * registration set is testable without standing up a Client or a REST call —
 * "did we actually ship /seamadmin?" is a unit test, not a boot-time surprise.
 */
export function buildSlashRegistrationBody(plugins?: SlashRegistry): RESTPostAPIApplicationCommandsJSONBody[] {
  const commands = [buildSeamCommand().toJSON(), buildSeamAdminCommand().toJSON()];
  return plugins ? plugins.assemble(commands) : commands;
}

const accessLeaves = new Map<string, SlashAccessDeclaration>();
const acknowledgementLeaves = new Map<string, InteractionResponseMode>();
for (const command of [buildSeamCommand(), buildSeamAdminCommand()]) {
  for (const option of command.options) {
    const group = option instanceof SlashCommandSubcommandGroupBuilder ? option.name : null;
    const leaves = option instanceof SlashCommandSubcommandGroupBuilder ? option.options : [option];
    for (const leaf of leaves) {
      if (!(leaf instanceof SlashCommandSubcommandBuilder)) continue;
      const declaration = accessDeclarations.get(leaf);
      if (declaration) accessLeaves.set([command.name, group, leaf.name].filter(Boolean).join("/"), declaration);
      const acknowledgement = acknowledgementDeclarations.get(leaf);
      if (acknowledgement) acknowledgementLeaves.set([command.name, group, leaf.name].filter(Boolean).join("/"), acknowledgement);
    }
  }
}

for (const leaf of CONFIG_UI_LEAVES) accessLeaves.set(`seam/${CONFIG_UI_GROUP.name}/${leaf.name}`, { kind: leaf.access });

for (const leaf of PRESET_COMMAND_GROUP.options!) accessLeaves.set(`seam/preset/${leaf.name}`, { kind: PRESET_ACCESS[leaf.name as keyof typeof PRESET_ACCESS] });

export function getSlashCommandAccess(
  command: string,
  group: string | null,
  subcommand: string,
  option: SlashOptionReader = () => null
): SlashCommandAccess | undefined {
  const declaration = accessLeaves.get([command, group, subcommand].filter(Boolean).join("/"));
  return typeof declaration === "function" ? declaration(option) : declaration;
}

export function getSlashAcknowledgement(command: string, group: string | null, subcommand: string): InteractionResponseMode | undefined {
  return acknowledgementLeaves.get([command, group, subcommand].filter(Boolean).join("/"));
}

export type SeamSubcommand =
  | "new"
  | "cancel"
  | "steer"
  | "workflows"
  | "rebuild"
  | "compact-thread"
  | "recover"
  | "canary"
  | "restart"
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
