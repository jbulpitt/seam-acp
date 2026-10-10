import { createHash } from "node:crypto";

export function googleChatClientMessageId(nonce: string): string {
  return `client-${createHash("sha256").update(nonce).digest("hex").slice(0, 56)}`;
}
