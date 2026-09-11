import { createHash } from "node:crypto";
import type { StructuredPanel } from "../types.js";

/** Discord accepts at most 25 characters for a create-message nonce. */
export const DELIVERY_NONCE_LENGTH = 25;

/**
 * Stable, opaque nonce for one logical terminal delivery.
 *
 * The digest is necessary because dispatch/attempt ids are commonly UUIDs and
 * Discord rejects nonces longer than 25 characters. The domain separator keeps
 * these values disjoint from any other shortened id this process may emit.
 */
export function deliveryNonce(attemptId: string): string {
  return createHash("sha256")
    .update("seam-terminal-delivery\0")
    .update(attemptId)
    .digest("base64url")
    .slice(0, DELIVERY_NONCE_LENGTH);
}

/** The exact final Discord create-message payload retained across a crash. */
export type DurableDeliveryPayload =
  | { kind: "message"; text: string }
  | { kind: "panel"; panel: StructuredPanel }
  | {
      kind: "file";
      file: {
        dataBase64: string;
        filename: string;
        mimeType: string;
        caption?: string;
      };
    };
