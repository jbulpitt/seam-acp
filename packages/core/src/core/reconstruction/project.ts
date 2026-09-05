import { isMessageCardOrNoise, type MessagePageItem } from "../message-reader.js";
import {
  ASSISTANT_FRAGMENT_GAP_MS,
  type LogicalReconstructionMessage,
} from "./types.js";

const HARNESS_BLOCK = /<seam-harness\b[^>]*>[\s\S]*?<\/seam-harness>/gi;
const HARNESS_UNCLOSED = /<seam-harness\b[^>]*>[\s\S]*$/gi;

export function stripSeamHarness(text: string): string {
  return text.replace(HARNESS_BLOCK, "").replace(HARNESS_UNCLOSED, "").replace(/^\s+|\s+$/g, "");
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
    if (isMessageCardOrNoise(post)) continue;
    if (post.authorType === "bot" && post.authorId !== seamBotId) continue;

    const raw = post.content.trim();
    const attachmentNote =
      post.attachmentNames.length > 0
        ? `[attachment: ${post.attachmentNames.map((name) => name || "unnamed").join(", ")}]`
        : "";
    const stripped = stripSeamHarness(raw);
    const text = [stripped, attachmentNote].filter(Boolean).join(stripped ? "\n" : "");
    if (!text) continue;

    const role: LogicalReconstructionMessage["role"] =
      post.authorType === "bot" && post.authorId === seamBotId ? "assistant" : "user";
    if (post.authorType === "bot" && role !== "assistant") continue;

    const previous = logical[logical.length - 1];
    const sameAssistantFragment =
      previous &&
      previous.role === "assistant" &&
      role === "assistant" &&
      post.authorId === seamBotId &&
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
      authorName: role === "user" ? post.authorName || "Human" : "Seam",
      timestampMs: post.timestampMs,
      text,
    });
  }
  return logical;
}
