/**
 * Shared framing for a course correction in an existing session.
 *
 * `/seam steer now:true` cancels and reprompts; MCP `steer` queues a separate
 * turn. The frame identifies the instruction without claiming either timing.
 */

/** Wrap a raw steering instruction in the `<seam-steer>` directive frame. */
export function frameSteerPrompt(prompt: string): string {
  return (
    `<seam-steer>\n${prompt}\n</seam-steer>\n\n` +
    `The operator has sent a course correction. Apply the instruction above using the existing session context.`
  );
}

/** Frame a next-turn directive without claiming the preceding turn was cancelled. */
export function frameInterruptPrompt(prompt: string, fresh: boolean): string {
  return (
    `<seam-interrupt>\n${prompt}\n</seam-interrupt>\n\n` +
    (fresh
      ? `A teammate prioritized this directive as your next turn. Your session was reset after the previous turn finished. ` +
        `Start fresh on the directive above; queued tasks will follow afterwards.`
      : `A teammate prioritized this directive as your next turn. The previous turn was not cancelled. ` +
        `Use the existing context for the directive above; queued tasks will follow afterwards.`)
  );
}
