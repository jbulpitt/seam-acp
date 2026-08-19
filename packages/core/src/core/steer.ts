/**
 * Steering — redirect a running (or idle) node mid-flow.
 *
 * A "steer" preemptively cancels a node's in-flight turn and injects a fresh
 * instruction into its LIVE session (its history/session is preserved). The
 * instruction is wrapped in a `<seam-steer>` fence so the agent recognises it
 * as an operator mid-task redirect rather than ordinary user input.
 *
 * This module holds only the pure framing so both the `/seam steer` command
 * (which cancels + injects directly) and the seam-MCP `steer` tool (which
 * enqueues a live dispatch carrying the framed text) share one wrapping.
 */

/** Wrap a raw steering instruction in the `<seam-steer>` directive frame. */
export function frameSteerPrompt(prompt: string): string {
  return (
    `<seam-steer>\n${prompt}\n</seam-steer>\n\n` +
    `The operator is steering you mid-task — adjust to the above now.`
  );
}

/**
 * Wrap a raw interrupt directive in the `<seam-interrupt>` frame (#67). Unlike a
 * steer (which layers onto whatever the agent was doing), an interrupt has just
 * PREEMPTIVELY CANCELLED the agent's in-flight turn — so the frame tells it its
 * prior work was aborted and it must reorient. `fresh` distinguishes the two
 * tiers: a kept session pivots off partial work; a reset session starts clean.
 */
export function frameInterruptPrompt(prompt: string, fresh: boolean): string {
  return (
    `<seam-interrupt>\n${prompt}\n</seam-interrupt>\n\n` +
    (fresh
      ? `A teammate interrupted you: your previous turn was cancelled and your session was reset. ` +
        `Disregard any earlier task — start fresh on the directive above now.`
      : `A teammate interrupted you: your previous turn was cancelled. ` +
        `Abandon that partial work and pivot to the directive above now.`)
  );
}
