/**
 * Human injection helpers (#63) — the *human* producer side of the agent inbox
 * (#61). A person can push a message into a running (or idle) agent's inbox from
 * Discord, either implicitly (a bare mid-turn reply, when routing is enabled) or
 * explicitly (`/seam steer … now:false`). Delivery is pull-only: the agent reads
 * the queued text at its next `poll_inbox`, no turn is cancelled or started.
 *
 * Two pure concerns live here so both the mid-turn path and the `/seam steer`
 * command share one implementation (and both are unit-testable without Discord):
 *   1. Attribution — how a human's display name/id (via speaker-identity #57)
 *      becomes the inbox `fromRef`.
 *   2. Restricted-profile scrubbing — stripping Discord URLs from queued human
 *      text for `restrictDiscordAccess` agents, the same guard the prompt path
 *      applies to attachments (a Discord CDN link is a dead end on a network-
 *      restricted agent host, so the model must never be handed one).
 */

/**
 * Build the inbox `fromRef` for a human producer. Prefer the resolved display
 * name (speaker-identity #57: override map → nickname → global name → username),
 * falling back to the raw author id so attribution is never empty. Prefixed
 * `human:` so a drained message reads `from human:Jesse`, unambiguously a person
 * rather than another agent's channel ref.
 */
export function humanInboxFrom(name: string | null | undefined, id: string): string {
  const clean = (name ?? "").trim();
  return clean ? `human:${clean}` : `human:${id}`;
}

/**
 * Discord URLs (message/channel links and CDN/attachment hosts). Matched greedily
 * to the first whitespace so query strings and fragments are removed too.
 */
const DISCORD_URL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:discord(?:app)?\.com|discord\.gg|discordapp\.net|discordapp\.com)\/\S*/gi;

/**
 * Replace every Discord URL in `text` with a placeholder. Applied to queued human
 * text only when the target agent is `restrictDiscordAccess` — mirrors the prompt
 * path, which likewise keeps Discord URLs away from a restricted agent host.
 */
export function scrubDiscordUrls(text: string): string {
  return text.replace(DISCORD_URL_RE, "[discord link removed]");
}
