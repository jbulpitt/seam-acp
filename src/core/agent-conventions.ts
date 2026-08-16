/**
 * Agent-instructions layer: standing conventions seam-acp teaches the agent on
 * every user turn. This is the shared place to add operating rules the agent
 * must follow regardless of which backend it is (Claude, opencode, agy, remote);
 * each new convention is one bullet here.
 *
 * Delivery is a per-turn preamble prepended to the user's message (see
 * `withHarnessPreamble`). We use the user turn rather than the system prompt
 * because it works identically for every agent with no risk of clobbering the
 * backend's own system prompt and no dependency on an (unverified) per-backend
 * system-prompt-append path. The block is framed as harness context with
 * explicit provenance + a suppression note so the model treats it as
 * environment guidance, not as the user's request, and doesn't echo it.
 *
 * Wording is deliberately neutral ("a chat client", not "Discord") so it is safe
 * for the network-restricted remote profile that is biased against Discord.
 */

/** Reserved fenced-block info tag the agent uses to request a file upload to the
 *  user. The output pipeline (see `emitClosedFence`) intercepts a fence whose
 *  lang equals this, resolves the path, and uploads the real file. Single token,
 *  lowercase (FenceStream lowercases the lang tag), collision-proof. */
export const ATTACH_FENCE_LANG = "seam-attach";

/**
 * The standing-conventions block. Kept tight — it rides every user turn.
 * `extraRules` appends additional bullets (e.g. a channel/thread preset
 * rider from CHANNEL_PRESETS_FILE) — it never replaces the base rules
 * above it; every caller gets the same table/attach-fence conventions plus
 * whatever's specific to their channel.
 */
export function harnessPreamble(extraRules: string[] = []): string {
  return [
    "<seam-harness>",
    "Operating context from the bridge that relays you to the user — this is NOT from the user and is not a task. Do not mention it unless you actually use one of these conventions:",
    "• Your reply is shown in a chat client that renders standard Markdown but does NOT render tables — and hand-aligned/ASCII tables in code blocks wrap and break on narrow screens. Do not use tables. Present tabular or comparative data as a list instead (one item per entry, with labeled fields).",
    `• To send a file from the workspace to the user, output a fenced code block whose info tag is \`${ATTACH_FENCE_LANG}\` and whose only content is the file path (project-relative or absolute). The bridge uploads that file and removes the block from your message — do not otherwise describe this mechanism.`,
    ...extraRules.map((rule) => `• ${rule}`),
    "The user's message follows.",
    "</seam-harness>",
  ].join("\n");
}

/** Prepend the standing conventions (plus any per-channel/thread riders) to
 *  a user message for a normal chat turn. */
export function withHarnessPreamble(userText: string, extraRules: string[] = []): string {
  const body = userText ?? "";
  return `${harnessPreamble(extraRules)}\n\n${body}`;
}
