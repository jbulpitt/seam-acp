import { isMessageCardOrNoise, type MessagePageItem } from "../message-reader.js";
import { DISPATCH_PANEL_TITLES } from "../dispatch/presentation.js";
import {
  ASSISTANT_FRAGMENT_GAP_MS,
  type LogicalReconstructionMessage,
} from "./types.js";

const HARNESS_BLOCK = /<seam-harness\b[^>]*>[\s\S]*?<\/seam-harness>/gi;
const HARNESS_UNCLOSED = /<seam-harness\b[^>]*>[\s\S]*$/gi;

export function stripSeamHarness(text: string): string {
  return text.replace(HARNESS_BLOCK, "").replace(HARNESS_UNCLOSED, "").replace(/^\s+|\s+$/g, "");
}

function deliveredPrompt(post: MessagePageItem): {
  text: string; authorName: string; responseEndTimestampMs?: number;
} | undefined {
  for (const embed of post.embeds ?? []) {
    const prefix = Object.values(DISPATCH_PANEL_TITLES).find(title => embed.title?.startsWith(`${title} · `));
    if (embed.title?.startsWith("⏰ Running scheduled: ") && embed.fields.some(field => field.name === "Schedule")) {
      return { text: "[Scheduled prompt text was not recorded in this Discord card.]",
        authorName: `scheduled — ${embed.title.slice("⏰ Running scheduled: ".length)}` };
    }
    if (!prefix) continue;
    const lines = embed.description?.split("\n") ?? [];
    const text = embed.fields.find(field => field.name === "Prompt")?.value
      ?? lines.find(line => line.startsWith("💬 "))?.slice("💬 ".length);
    const source = embed.fields.find(field => field.name === "From")?.value
      ?? lines.find(line => line.startsWith("↩ "))?.slice("↩ ".length);
    const kind = prefix.slice(prefix.indexOf(" ") + 1).toLowerCase();
    const terminal = embed.title?.endsWith(" · Done") || embed.title?.endsWith(" · Failed");
    return {
      text: text?.trim() || "[Prompt text was not recorded in this Discord card.]",
      authorName: `${kind}${source ? ` from ${source}` : ""}${text?.trim() ? " (Discord prompt excerpt)" : ""}`,
      ...(terminal && post.editedTimestampMs != null ? { responseEndTimestampMs: post.editedTimestampMs } : {}),
    };
  }
}

export function projectDiscordConversation(
  posts: readonly MessagePageItem[],
  opts: { seamBotId: string }
): LogicalReconstructionMessage[] {
  const seamBotId = opts.seamBotId;
  const chronological = [...posts].sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    return a.messageId.localeCompare(b.messageId);
  });

  const logical: LogicalReconstructionMessage[] = [];
  for (const post of chronological) {
    const ownOutput = post.isOwnOutput || (post.authorType === "bot" && post.authorId === seamBotId);
    if (post.authorType === "bot" && !ownOutput) continue;
    const prompt = ownOutput ? deliveredPrompt(post) : undefined;
    if (!prompt && isMessageCardOrNoise(post)) {
      const previous = logical.at(-1);
      if (ownOutput && previous?.role === "user" && post.editedTimestampMs != null && post.embeds?.some(embed =>
        (embed.title === "Done" || embed.title === "Failed")
        && embed.fields.some(field => field.name === "Repo") && embed.fields.some(field => field.name === "Action"))) {
        previous.responseEndTimestampMs = post.editedTimestampMs;
      }
      continue;
    }

    const raw = prompt?.text ?? post.content.trim();
    const attachmentNote =
      post.attachmentNames.length > 0
        ? `[attachment: ${post.attachmentNames.map((name) => name || "unnamed").join(", ")}]`
        : "";
    const stripped = stripSeamHarness(raw);
    const text = [stripped, attachmentNote].filter(Boolean).join(stripped ? "\n" : "");
    if (!text) continue;

    const role: LogicalReconstructionMessage["role"] =
      prompt ? "prompt" : ownOutput ? "assistant" : "user";

    const previous = logical[logical.length - 1];
    const sameAssistantFragment =
      previous &&
      previous.role === "assistant" &&
      role === "assistant" &&
      ownOutput &&
      post.timestampMs - previous.timestampMs <= ASSISTANT_FRAGMENT_GAP_MS;

    if (sameAssistantFragment && previous) {
      previous.text = `${previous.text}\n\n${text}`;
      previous.sourcePostIds.push(post.messageId);
      continue;
    }

    logical.push({
      id: post.messageId,
      sourcePostIds: [post.messageId],
      role,
      authorName: prompt?.authorName ?? (role === "user" ? post.authorName || "Human" : "Seam"),
      timestampMs: post.timestampMs,
      ...(prompt?.responseEndTimestampMs != null ? { responseEndTimestampMs: prompt.responseEndTimestampMs } : {}),
      text,
    });
  }
  return logical;
}
