import type { StatusPanel, StructuredPanel } from "../../core/types.js";
import { discordRenderer } from "../discord/renderer.js";

/** Chat keeps the shared title/model/tool styling, with a smaller status body. */
export function googleChatStatusPanel(state: StatusPanel): StructuredPanel {
  const thinking = state.thinking?.slice(state.thinkingPending ? -2 : -1);
  const panel = discordRenderer.statusPanel({ ...state, style: "full",
    activity: state.activity?.slice(-3), thinking });
  const lines = (thinking ?? []).map(line =>
    `💡 ${discordRenderer.trimShort(line.replace(/[*_`]/g, ""), 200)}`);
  const segments = [`⏱ ${state.elapsedSeconds}s`];
  const pct = state.contextPct ?? state.context?.match(/\((\d+)%\)/)?.[1];
  if (pct != null) segments.push(`🪟 ${pct}%`);
  segments.push(`🧠 ${state.effort ?? "default"}`);
  if (state.fastMode) segments.push(`⚡ fast ${state.fastMode}`);
  // Recovery/terminal reasons arrive in Action; keep them visible without a field.
  const reason = state.state === "Waiting" || state.state === "Failed" || state.state === "Timed out"
    ? state.action : undefined;
  return { ...panel,
    fields: panel.fields.filter(field => field.name !== "Action"),
    description: [panel.description, reason].filter(Boolean).join("\n") || undefined,
    footer: [...lines, segments.join(" • ")].join("\n"),
  };
}
