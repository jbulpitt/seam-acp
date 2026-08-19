import type { StatusPanel, StructuredPanel } from "../core/types.js";

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
  statusPanel(state: StatusPanel): StructuredPanel;

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

/**
 * Serialize a {@link StructuredPanel} to plain text. Used as a fallback when
 * the chat adapter doesn't support rich panels (embeds).
 */
export function serializePanelText(panel: StructuredPanel): string {
  const lines: string[] = [];
  lines.push(`**${panel.title}**`);
  lines.push("```text");
  const maxKey = panel.fields.reduce((m, f) => Math.max(m, f.name.length), 0);
  for (const f of panel.fields) {
    lines.push(`${f.name.padEnd(maxKey)} : ${f.value}`);
  }
  lines.push("```");
  if (panel.description) {
    lines.push(panel.description);
  }
  if (panel.footer) {
    lines.push(`_${panel.footer}_`);
  }
  return lines.join("\n").replace(/\s+$/, "");
}
