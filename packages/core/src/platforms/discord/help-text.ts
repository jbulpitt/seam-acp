/**
 * `/seam info help` content, as PAGES that each fit a Discord message.
 *
 * The old help was one 2,554-character string sent as a single `reply({
 * content })`. Discord's message-content cap is 2,000, so the reply was
 * rejected outright (`BASE_TYPE_MAX_LENGTH`) — the one command whose entire job
 * is to tell you what the other commands are had silently stopped working.
 *
 * Splitting the tree in #151 makes that worse, not better: there are now two
 * commands to document. So the text lives here as titled SECTIONS, packed
 * greedily into pages that never exceed {@link HELP_PAGE_MAX}. A section is
 * never split mid-list — a page break lands between sections — unless a single
 * section is itself over budget, in which case {@link chunkForDiscord} cuts it
 * at a newline as a last resort.
 *
 * Pure and exported so the length ceiling is a unit test rather than a runtime
 * surprise (`test/help-text.test.ts`).
 */
import { chunkForDiscord } from "../../core/text-chunker.js";

/** Discord's hard cap on a message's `content`. Exceeding it is a 400. */
export const DISCORD_MESSAGE_CONTENT_MAX = 2000;

/** Our budget, with headroom under the hard cap. */
export const HELP_PAGE_MAX = 1900;

/**
 * The help body, one entry per section. Kept as sections (not one blob) so the
 * packer can break between them and so a section can be re-ordered or dropped
 * without re-flowing the whole document.
 */
export function seamHelpSections(): string[] {
  return [
    [
      "**seam-acp** — control the agent in this thread.",
      "Free-form messages in a thread are sent to the agent.",
      "",
      "**`/seam`** — everyday surface",
      "`/seam new [name]` — create a new agent thread + config card",
      "`/seam cancel` — gracefully cancel this thread's turn",
      "`/seam cancel force:true` — escalate if the turn ignores cancel",
      "`/seam cancel scope:all` — force-kill every active session",
      "`/seam steer <prompt> [thread] [now]` — steer a node (defaults to here)",
      "`/seam queue <prompt>` — queue the next live turn (does not abort)",
      "`/seam workflows` — delegation ledger + pending wakes/watches/live-help",
    ].join("\n"),

    [
      "**`/seam config`**",
      "`model [id]` · `effort [level]` · `agent [id]` — model / reasoning / agent@location",
      "`role [value] [scope]` — naming role for this thread",
      "`mode <id>` · `repo [path] [scope]` · `tools <allow|exclude> [list]`",
      "`approve <always|ask|deny>` — permission policy",
      "`card [full|simple] [scope]` · `gif [on|off] [scope]` — status-card layout",
      "`reset` — end this thread's ACP session; next message starts fresh",
      "`init` — bind this thread + open the config card",
      "`detach <detached|attached>` — no bot replies (history is kept)",
      "`tts [on|off] [voice] [pace] [style]` — omit options for the settings card",
      "`show` · `set <json>` · `edit` — inspect / replace / edit session config",
      "`audit [limit] [entry]` — recent config mutations (who/what/when)",
    ].join("\n"),

    [
      "**`/seam info`**",
      "`whoami` — the account this thread's agent is signed in as",
      "`usage` — usage / credits for this thread's agent",
      "`avatar` — re-push the bot avatar and banner",
      "`help` — this list · `sessions` — recent sessions · `repos` — repos under REPOS_ROOT",
      "",
      "**`/seam preset`**",
      "`list` · `create [global] [role]` · `apply <name>` · `delete <name>`",
      "`show <name>` · `edit <name>` · `thread <preset> [name] [quantity]`",
    ].join("\n"),

    [
      "**`/seamadmin`** — operator surface (needs Manage Server; hidden otherwise)",
      "`/seamadmin rebuild [agent] [model]` — rebuild this session from thread history",
      "`/seamadmin naming rename [scope] [migrate-legacy] [role-name]` — rebuild thread names",
      "`/seamadmin naming namer` — edit the agent/model/role symbol tables",
      "`/seamadmin schedule` — `add` `list` `remove` `toggle` `edit` (no attachments)",
      "`/seamadmin project` — `new` `list` `remove` (activate a channel, no redeploy)",
      "`/seamadmin upload` — `pull <path>` `push <file> <path>` `secret`",
      "`/seamadmin bridge` — `add` `rotate` `list` `remove` (remote hosts)",
      "`/seamadmin debug` — `tail` `exec` `status` `voice-ping` `voice-capture` `voice-live`",
      "`/seamadmin voice` — `start` `add` `remove` `configure` `console` `status` `stop`",
    ].join("\n"),
  ];
}

/**
 * Pack the sections into pages of at most `max` characters.
 *
 * Guarantee: every returned page satisfies `page.length <= max`. Callers may
 * send each page as its own message content without re-checking.
 */
export function buildSeamHelpPages(max = HELP_PAGE_MAX): string[] {
  const pages: string[] = [];
  let current = "";
  for (const section of seamHelpSections()) {
    // A section that cannot fit on a page of its own is cut at a newline.
    if (section.length > max) {
      if (current) {
        pages.push(current);
        current = "";
      }
      pages.push(...chunkForDiscord(section, max));
      continue;
    }
    const joined = current ? `${current}\n\n${section}` : section;
    if (joined.length <= max) {
      current = joined;
      continue;
    }
    if (current) pages.push(current);
    current = section;
  }
  if (current) pages.push(current);
  return pages;
}
