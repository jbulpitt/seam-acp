import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { makeMux, parseCommandBusFrame, PROTOCOL_VERSION, readErrorClassification } from "@seam/adapters";
import { buildBridgeRpcReply } from "../packages/bridge/src/rpc.js";

const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const stop of stops.splice(0).reverse()) {
    try { await stop(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "RPC compatibility fixture cleanup");
});

async function rpcRejection(replyFor: (id: string) => Record<string, unknown>) {
  const server = createServer();
  stops.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const wss = new WebSocketServer({ server });
  stops.push(() => new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve())));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const accepted = new Promise<WebSocket>(resolve => { wss.once("connection", resolve); });
  const peer = new WebSocket(`ws://127.0.0.1:${port}`);
  const peerClosed = new Promise<void>(resolve => { peer.once("close", () => resolve()); });
  const failures: unknown[] = [];
  peer.on("error", error => failures.push(error));
  const observed: { request?: { id: string; method: string; agentId?: string }; reply?: unknown } = {};
  stops.push(async () => {
    if (peer.readyState === WebSocket.CONNECTING) peer.terminate();
    else if (peer.readyState === WebSocket.OPEN) peer.close();
    await peerClosed;
    if (failures.length) throw new AggregateError(failures, "RPC compatibility peer errors");
  });
  peer.on("message", raw => {
    try {
      const request = JSON.parse(raw.toString());
      if (request.type !== "rpc") return;
      observed.request = request;
      const bytes = JSON.stringify(replyFor(request.id));
      observed.reply = parseCommandBusFrame(JSON.parse(bytes));
      peer.send(bytes);
    } catch (error) { failures.push(error); peer.close(); }
  });
  await once(peer, "open");
  const muxSocket = await accepted;
  const muxClosed = new Promise<void>(resolve => { muxSocket.once("close", () => resolve()); });
  // The actual server-side socket belongs to the mux; peer is the other endpoint.
  const mux = makeMux({ id: "rpc-error-compatibility-fixture" });
  mux.attach(muxSocket);
  stops.push(async () => { peer.close(); await peerClosed; await muxClosed; });
  const outcome = await mux.rpc("getTranscript", { cwd: "/own-fixture", sessionId: "own-fixture-id" }, { agentId: "agy" })
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  expect(failures).toEqual([]);
  expect(observed.request).toMatchObject({ method: "getTranscript", agentId: "agy" });
  expect(observed.reply).toMatchObject({ v: PROTOCOL_VERSION, type: "rpc_reply", id: observed.request!.id, ok: false });
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("Error reply unexpectedly resolved");
  expect(outcome.error).toBeInstanceOf(Error);
  return { error: outcome.error, observed };
}

describe("RPC error wire compatibility", () => {
  it("accepts an old string-only writer without inventing optional error fields", async () => {
    const { error, observed } = await rpcRejection(id => ({
      v: PROTOCOL_VERSION, type: "rpc_reply", id, ok: false, error: "Legacy writer message",
    }));
    expect(error.message).toBe("Legacy writer message");
    expect(Object.hasOwn(error, "code")).toBe(false);
    expect(Object.hasOwn(error, "data")).toBe(false);
    expect(readErrorClassification(error)).toBeNull();
    expect(observed.reply).toEqual({ v: PROTOCOL_VERSION, type: "rpc_reply", id: observed.request!.id,
      ok: false, error: "Legacy writer message" });
  });

  it.each([
    { name: "ordinary string code", code: "ENOENT", data: { fixture: "ordinary-coded-error" } },
    { name: "zero code and null data", code: 0, data: null },
  ])("carries $name through the shared producer and real mux", async ({ code, data }) => {
    const original = Object.assign(new Error("Ordinary coded fixture error"), { code, data });
    const { error, observed } = await rpcRejection(id => buildBridgeRpcReply(id, { ok: false, error: original }));
    expect(observed.reply).toEqual({ v: PROTOCOL_VERSION, type: "rpc_reply", id: observed.request!.id,
      ok: false, error: original.message, errorCode: code, errorData: data });
    expect(error.message).toBe(original.message);
    expect(error.code).toBe(code);
    expect(error.data).toEqual(data);
    expect(readErrorClassification(error)).toBeNull();
  });
});
