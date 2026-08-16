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
