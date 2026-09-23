import type { HelloFrame } from "@seam/adapters";

/**
 * Build the bridge handshake from observed startup facts.
 *
 * `durableSlots` is a behavioural capability, not a release/version proxy.
 * Removing it makes a new controller treat every bridge restart as child loss
 * and evict work that sessiond still owns, so the returned shape is tested.
 */
export function bridgeHello(input: Omit<HelloFrame, "v" | "type" | "protocolVersion" | "capabilities"> & {
  protocolVersion: number;
}): HelloFrame {
  return {
    v: input.protocolVersion,
    type: "hello",
    ...input,
    capabilities: { durableSlots: true },
  };
}
