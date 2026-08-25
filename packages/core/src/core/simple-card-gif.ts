/**
 * Standalone simple-card GIF message (#96 follow-up).
 *
 * The GIF used to live on the status-card embed (`imageUrl` / `setImage`).
 * Discord restarts a GIF animation on every embed edit, so the status card's
 * many per-turn edits made it loop from frame 1. The GIF is now a separate
 * message that is never edited, then deleted on a terminal turn state.
 *
 * Mid-turn bot restart may orphan the message — acceptable.
 */
import type { StatusCardStyle, StructuredPanel, TurnState } from "./types.js";

/** Same set #103 used to hide the GIF on the card. Monitoring/Waiting keep it. */
export const SIMPLE_CARD_GIF_TERMINAL: ReadonlySet<TurnState> = new Set([
  "Done",
  "Failed",
  "Timed out",
]);

export function isSimpleCardGifTerminal(state: TurnState): boolean {
  return SIMPLE_CARD_GIF_TERMINAL.has(state);
}

/** Pick one GIF URL at turn start, or undefined when the card should not have one. */
export function pickSimpleCardGifUrl(opts: {
  style: StatusCardStyle;
  gifOn: boolean;
  randomGif: () => string | null;
}): string | undefined {
  if (opts.style !== "simple" || !opts.gifOn) return undefined;
  return opts.randomGif() ?? undefined;
}

/** Minimal embed: just the animated GIF. Posted once, never edited. */
export function simpleCardGifPanel(url: string): StructuredPanel {
  return {
    color: 0x2b2d31,
    fields: [],
    imageUrl: url,
  };
}

export async function postSimpleCardGifMessage<TRef>(opts: {
  url: string;
  sendPanel?: (panel: StructuredPanel) => Promise<TRef>;
  sendMessage: (text: string) => Promise<TRef>;
}): Promise<TRef | undefined> {
  try {
    if (opts.sendPanel) return await opts.sendPanel(simpleCardGifPanel(opts.url));
    return await opts.sendMessage(opts.url);
  } catch {
    return undefined;
  }
}

export async function deleteSimpleCardGifMessage<TRef>(opts: {
  ref: TRef | undefined;
  deleteMessage?: (ref: TRef) => Promise<void>;
}): Promise<void> {
  if (!opts.ref || !opts.deleteMessage) return;
  try {
    await opts.deleteMessage(opts.ref);
  } catch {
    // Already gone — best-effort.
  }
}
