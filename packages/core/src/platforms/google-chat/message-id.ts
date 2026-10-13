import { createHash } from "node:crypto";

export function googleChatClientMessageId(nonce: string, prefix = "client-"): string {
  return `${prefix}${createHash("sha256").update(nonce).digest("hex").slice(0, 63 - prefix.length)}`;
}
