import type { WebSocket as WsSocket } from "ws";

type WsCtor = typeof import("ws").WebSocket;

/**
 * Outbound framing for the slot mux (#444).
 *
 * Lives outside `index.ts` because that file is the CLI entrypoint and
 * `process.exit(1)`s on import, so nothing in it can be tested. Three
 * mutations to this logic survived a full suite while it was inline: not
 * logging when the socket was closed, omitting `seq` from the wire, and
 * forwarding raw chunks instead of lines. All three are the bug this story
 * fixes, and none of them was observable.
 */
export function muxSend(
  ws: WsSocket | null,
  WebSocket: WsCtor,
  slot: number,
  type: string,
  payload: Record<string, unknown>,
  /**
   * #444: when given, the frame is recorded BEFORE the socket is consulted and
   * carries its `seq` on the wire. The early return below used to discard
   * output whenever the socket was not OPEN, while stdin in the other
   * direction was queued and replayed — the asymmetry this story removes.
   *
   * An older seam-acp ignores the extra `seq` field, so tagging is safe on a
   * mixed-version fleet.
   */
  log?: { append(slot: number, type: string, payload: Record<string, unknown>): number },
) {
  const seq = log?.append(slot, type, payload);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ slot, type, ...payload, ...(seq === undefined ? {} : { seq }) }));
}

/**
 * Forward a stdout chunk as whole lines (#444).
 *
 * stdout was forwarded as raw `Buffer` chunks, so a reconnect could splice a
 * partial JSON line into a line-delimited JSON-RPC stream and the consumer
 * would parse garbage. A frame is now always a complete message.
 */
export function forwardAgentStdout(
  chunk: Buffer | string,
  framer: { push(chunk: string): string[] },
  emit: (line: string) => void
): void {
  for (const line of framer.push(chunk.toString())) emit(line);
}
