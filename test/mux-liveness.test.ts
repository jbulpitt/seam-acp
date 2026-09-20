/**
 * #427 — a half-open socket reads OPEN forever, so nothing ever closes it.
 *
 * TCP gone with no FIN or RST — the ordinary outcome through a proxy or tunnel
 * — leaves `readyState === OPEN` on both ends. `rpc()`'s offline guard passes,
 * the frame goes into the void, and because nothing closes the socket the
 * client's (correct) reconnect-on-close never fires. The connection is dead
 * permanently and both ends believe in it.
 *
 * #429 settles the callers of a socket that DOES close. This is the case where
 * it never does, and it is the harder half: the only way out is for the server
 * to stop believing the socket and terminate it, so that `close` fires.
 *
 * These tests run the REAL monitor on real timers against real `ws` sockets;
 * only the window is shortened through an injectable option, so production
 * logic is what executes. The peer is dropped by pausing its underlying socket
 * — no close frame, `readyState` stays OPEN — which is what a vanished TCP
 * path actually looks like.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { makeMux, BridgeUnreachableError } from "@seam/adapters";

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try { s.removeAllListeners(); s.on("error", () => {}); s.terminate(); } catch { /* gone */ }
  }
  // Let in-flight handshakes settle before the servers go, so nothing rejects
  // into an empty listener set.
  await new Promise((r) => setTimeout(r, 20));
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

/** A real ws pair: an actual server socket handed to the mux, and its client. */
async function connectedPair(liveness?: {
  silenceMs?: number; graceMs?: number; tickMs?: number;
}): Promise<{
  mux: ReturnType<typeof makeMux>;
  serverWs: WebSocket;
  clientWs: WebSocket;
  events: string[];
}> {
  const http = createServer();
  servers.push(http);
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as { port: number }).port;

  const events: string[] = [];
  const mux = makeMux({
    id: "test-bridge",
    onDisconnect: () => events.push("disconnect"),
    onLivenessTimeout: () => events.push("liveness-timeout"),
    ...(liveness ? { liveness } : {}),
  } as never);

  const serverWs = await new Promise<WebSocket>((resolve) => {
    wss.on("connection", (ws) => resolve(ws as never));
    const c = new WebSocket(`ws://127.0.0.1:${port}`);
    // Teardown terminates these; a socket still mid-handshake then emits
    // "closed before the connection was established", which vitest counts as
    // an unhandled error even though every test passed. Own it here.
    c.on("error", () => {});
    sockets.push(c as never);
  });
  const clientWs = [...wss.clients][0] as never as WebSocket;
  mux.attach(serverWs as never);
  return { mux, serverWs, clientWs, events };
}

const settled = async <T>(p: Promise<T>): Promise<unknown> =>
  p.then((v) => ({ ok: v }), (e) => e);

describe("#427 a half-open socket is detected and terminated", () => {
  // Real monitor, real timers, production logic — only the window is shortened
  // so the test does not wait out the ~50s production budget.
  const FAST = { silenceMs: 60, graceMs: 40, tickMs: 15 };

  it("terminates a silent peer and fires close, so the client can reconnect", async () => {
    // The half-open simulation: the peer is dropped with NO close frame, so
    // `readyState` stays OPEN and nothing would ever close it. Pausing the
    // underlying socket stops the library's automatic pong without sending
    // anything, which is exactly what a vanished TCP path looks like.
    const { serverWs, clientWs, events } = await connectedPair(FAST);
    expect(serverWs.readyState).toBe(WebSocket.OPEN);
    const closed = new Promise<void>((r) => serverWs.once("close", () => r()));

    (clientWs as never as { _socket: { pause(): void } })._socket.pause();

    await closed;
    expect(events).toContain("liveness-timeout");
    expect(serverWs.readyState).not.toBe(WebSocket.OPEN);
    // `close` fired, which is the event the client's existing reconnect waits
    // for — the whole reason terminate() is used rather than close().
    expect(events).toContain("disconnect");
  }, 15_000);

  it("fails an RPC issued on a dying socket as unreachable, not as a timeout", async () => {
    const { mux, clientWs } = await connectedPair(FAST);
    const inFlight = mux.rpc("spawn", { slot: 1 });
    (clientWs as never as { _socket: { pause(): void } })._socket.pause();

    const err = await settled(inFlight);
    expect(err).toBeInstanceOf(BridgeUnreachableError);
    expect((err as Error).message).not.toMatch(/timed out after/);
    expect((err as BridgeUnreachableError).outcomeUnknown).toBe(true);
  }, 15_000);

  it("does NOT terminate a healthy idle connection", async () => {
    // The failure mode that would be worse than the bug. This peer sends
    // nothing at all for many full windows; it is alive only in the sense that
    // it answers the probe at protocol level, which is precisely the case the
    // active probe exists to protect.
    const { serverWs, events } = await connectedPair(FAST);
    await new Promise((r) => setTimeout(r, 60 * 8));
    expect(serverWs.readyState).toBe(WebSocket.OPEN);
    expect(events).not.toContain("liveness-timeout");
    expect(events).not.toContain("disconnect");
  }, 15_000);
});
