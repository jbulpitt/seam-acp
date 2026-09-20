/**
 * #427 — two ways a bridge RPC dies at the generic 30s timeout, neither of
 * which is slowness.
 *
 * **The deterministic one, and the higher-volume one.** `pendingRpcs` and
 * `pendingCmds` were each settled in exactly two places: a matching reply
 * frame, or their own 30s timer. `close`, `error` and `attach()`'s replacement
 * of the incumbent socket all left them untouched. So every call in flight
 * across an ORDINARY reconnect was orphaned — its reply can never arrive,
 * because the bridge answers on the socket it was asked on — and burned the
 * full 30s before failing with `rpc 'spawn' timed out after 30s`. With a 5s
 * reconnect delay, Mac sleep, wifi blips and cloudflared restarts, that is
 * routine. The transport is known dead at close time and we waited anyway.
 *
 * **The half-open one.** TCP gone with no FIN or RST leaves `readyState ===
 * OPEN` on both ends forever, so nothing closes and the client's correct
 * reconnect-on-close never fires. That needs a liveness probe.
 *
 * The outcome distinction is load-bearing throughout: a call that was on the
 * wire may have been APPLIED by the bridge before the socket died, so these
 * failures are "outcome unknown", not "the bridge said no".
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { makeMux, BridgeUnreachableError } from "@seam/adapters";

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.terminate(); } catch { /* gone */ } }
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
    sockets.push(c as never);
  });
  const clientWs = [...wss.clients][0] as never as WebSocket;
  mux.attach(serverWs as never);
  return { mux, serverWs, clientWs, events };
}

const settled = async <T>(p: Promise<T>): Promise<unknown> =>
  p.then((v) => ({ ok: v }), (e) => e);

describe("#427 an ordinary reconnect must not orphan in-flight calls", () => {
  it("settles a pending RPC on close instead of letting it burn 30s", async () => {
    const { mux, serverWs } = await connectedPair();
    // No reply will ever come; before this fix the only thing that settled it
    // was its own 30s timer.
    const inFlight = mux.rpc("spawn", { slot: 1 });
    await new Promise((r) => setTimeout(r, 20));
    serverWs.close();

    const err = await settled(inFlight);
    expect(err).toBeInstanceOf(BridgeUnreachableError);
    expect((err as BridgeUnreachableError).message).not.toMatch(/timed out/);
    // The whole point: it did not wait for the generic timeout.
    expect((err as BridgeUnreachableError).outcomeUnknown).toBe(true);
  }, 10_000);

  it("settles a pending RPC when attach() replaces the incumbent socket", async () => {
    // The case the per-socket `close` handler CANNOT cover: by the time it
    // fires, `bridgeWs` already points at the new socket, so its identity
    // guard correctly skips it and the old call is orphaned forever.
    const { mux } = await connectedPair();
    const inFlight = mux.rpc("spawn", { slot: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const replacement = await connectedPair();
    mux.attach(replacement.serverWs as never);

    const err = await settled(inFlight);
    expect(err).toBeInstanceOf(BridgeUnreachableError);
    expect((err as BridgeUnreachableError).message).toMatch(/reconnect/i);
    expect((err as BridgeUnreachableError).outcomeUnknown).toBe(true);
  }, 10_000);

  it("does not settle live calls when the SAME socket is re-attached", () => {
    // The identity guard the orchestrator asked for: a no-op re-attach must not
    // reject work that the very same socket is still able to answer. Asserted
    // as "still pending", because the alternative — rejected — is exactly the
    // regression this guard prevents.
    return (async () => {
      const { mux, serverWs } = await connectedPair();
      const inFlight = mux.rpc("echo", { n: 1 });
      let outcome: string | null = null;
      void inFlight.then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
      await new Promise((r) => setTimeout(r, 20));

      mux.attach(serverWs as never);
      await new Promise((r) => setTimeout(r, 50));
      expect(outcome).toBeNull();

      // And it still settles normally when the socket really does go.
      serverWs.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(outcome).toBe("rejected");
    })();
  }, 10_000);

  it("reports a never-sent call as outcome KNOWN, unlike one on the wire", async () => {
    // The distinction a caller must not get wrong. The bridge's spawn handler
    // configures the slot and returns, so an in-flight call may have been
    // applied; a call that never left this process definitely was not.
    const { mux, serverWs } = await connectedPair();
    serverWs.close();
    await new Promise((r) => setTimeout(r, 50));

    const err = await settled(mux.rpc("spawn", { slot: 1 }));
    expect(err).toBeInstanceOf(BridgeUnreachableError);
    expect((err as BridgeUnreachableError).outcomeUnknown).toBe(false);
  }, 10_000);

  it("names unreachability rather than reading as a slow operation", async () => {
    const { mux, serverWs } = await connectedPair();
    const inFlight = mux.rpc("spawn", {});
    await new Promise((r) => setTimeout(r, 20));
    serverWs.close();
    const err = await settled(inFlight) as Error;
    // "timed out after 30s" is what sent every investigation looking for
    // slowness in a handler that does pure config work.
    expect(err.message).toMatch(/bridge/i);
    expect(err.message).not.toMatch(/timed out after/);
  }, 10_000);
});

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
