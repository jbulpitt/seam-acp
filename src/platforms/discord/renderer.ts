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
  /** Optional extra lines appended inside the code block, after the rows. */
  extra?: string;
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
  if (opts.extra && opts.extra.length > 0) {
    lines.push(opts.extra);
  }
  lines.push("```");
  if (opts.footer && opts.footer.trim().length > 0) {
    lines.push(opts.footer);
  }
  return lines.join("\n").replace(/\s+$/, "");
}

export const discordRenderer: Renderer = {
  statusPanel(state) {
    const rows: KV[] = [
      { key: "elapsed", value: `${state.elapsedSeconds}s` },
      { key: "repo", value: trim(state.repoDisplay, 80) },
      { key: "model", value: trim(state.model, 40) },
      { key: "doing", value: trim(state.action, 220) },
    ];
    const activityLines =
      state.activity && state.activity.length > 0
        ? state.activity.map((a) => `  • ${trim(a, 80)}`).join("\n")
        : undefined;
    // Thoughts go in a blockquote BELOW the code block — blockquote markdown
    // doesn't render inside a code fence. Edits to the same status message
    // carry both sections in one Discord request.
    const thinkingFooter =
      state.thinking && state.thinking.length > 0
        ? state.thinking
            .map((t) => `> ${trim(t.replace(/[*_`]/g, ""), 300)}`)
            .join("\n")
        : undefined;
    return box({
      title: state.state,
      icon: ICON_BY_STATE[state.state],
      rows,
      ...(activityLines ? { extra: activityLines } : {}),
      ...(thinkingFooter ? { footer: thinkingFooter } : {}),
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
