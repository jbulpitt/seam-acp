import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

export const usage: SessionUpdate = { sessionUpdate: "usage_update", used: 1, size: 1_000_000 };
export const extension: SessionUpdate = { sessionUpdate: "_seam/progress", percent: 40 };
export const text: SessionUpdate = {
  sessionUpdate: "agent_message_chunk", messageId: "message",
  content: { type: "text", text: "ok" },
};

// Known variants must not escape validation through the future-variant catch-all.
// @ts-expect-error usage_update requires size.
export const incomplete: SessionUpdate = { sessionUpdate: "usage_update", used: 1 };
// @ts-expect-error A text block requires text, not txt.
export const malformed: SessionUpdate = { sessionUpdate: "agent_message_chunk", messageId: "message", content: { type: "text", txt: "ok" } };
// @ts-expect-error Implementation-specific variants require the underscore prefix.
export const unprefixed: SessionUpdate = { sessionUpdate: "seam/progress", percent: 40 };
