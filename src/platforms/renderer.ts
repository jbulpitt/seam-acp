import type { StatusPanel } from "../core/types.js";

/** A simple key/value pair used in status / error boxes. */
export interface KV {
  key: string;
  value: string;
}

/**
 * Platform-specific text formatting. Each chat platform gets its own
 * implementation so we can use Discord's Markdown subset, Slack's mrkdwn,
 * terminal escape codes, etc. without leaking platform details into the core.
 */
export interface Renderer {
  /** Render the editable status panel shown during an agent turn. */
  statusPanel(state: StatusPanel): string;

  /** Render an "info box": a titled, key/value, optionally captioned block. */
  infoBox(opts: {
    title: string;
    icon?: string;
    rows: KV[];
    footer?: string;
  }): string;

  /** Render fenced code (or platform equivalent). */
  codeBlock(content: string, lang?: string): string;

  /** Trim a string to a max length with an ellipsis. */
  trimShort(s: string, max: number): string;

  /** Inline `code` style. */
  quote(s: string): string;

  /** Split a long message into platform-sized chunks. */
  chunk(text: string): string[];
}
