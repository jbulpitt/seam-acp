import { chunkForDiscord } from "../../core/text-chunker.js";
import type { StatusPanel } from "../../core/types.js";
import type { KV, Renderer } from "../renderer.js";

const ICON_BY_STATE: Record<StatusPanel["state"], string> = {
  Done: "✅",
  Failed: "❌",
  "Timed out": "⏱️",
  Waiting: "⏸️",
  Working: "⏳",
};

function trim(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function box(opts: {
  title: string;
  icon?: string;
  rows: KV[];
  footer?: string;
}): string {
  const icon = opts.icon ?? "ℹ️";
  const maxKey = opts.rows.reduce((m, r) => Math.max(m, r.key.length), 0);
  const lines: string[] = [];
  lines.push(`${icon} **${opts.title}**`);
  lines.push("```text");
  for (const { key, value } of opts.rows) {
    lines.push(`${key.padEnd(maxKey)} : ${value}`);
  }
  lines.push("```");
  if (opts.footer && opts.footer.trim().length > 0) {
    lines.push(opts.footer);
  }
  return lines.join("\n").replace(/\s+$/, "");
}

export const discordRenderer: Renderer = {
  statusPanel(state) {
    return box({
      title: state.state,
      icon: ICON_BY_STATE[state.state],
      rows: [
        { key: "elapsed", value: `${state.elapsedSeconds}s` },
        { key: "repo", value: trim(state.repoDisplay, 80) },
        { key: "model", value: trim(state.model, 40) },
        { key: "doing", value: trim(state.action, 220) },
      ],
    });
  },

  infoBox(opts) {
    return box(opts);
  },

  codeBlock(content, lang) {
    return `\`\`\`${lang ?? ""}\n${content}\n\`\`\``;
  },

  trimShort: trim,
  quote: (s) => `\`${s}\``,
  chunk: (s) => chunkForDiscord(s),
};
