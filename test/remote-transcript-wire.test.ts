import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { WebSocket } from "ws";
import { asLocalAdapter, PROTOCOL_VERSION, readErrorClassification } from "@seam/adapters";
import { makeAgyAcpProfile } from "../packages/adapters/src/profiles/agy-acp.js";
import { buildBridgeRpcReply, dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";
import type { Config } from "../packages/core/src/config.js";
import { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import { hashBridgeToken } from "../packages/core/src/core/bridge-pairing.js";
import type { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { remoteSessionManager } from "../packages/core/src/core/remote-session-manager.js";

const SID = "same-own-fixture-id";
const EXPECTED_TEXT = "### User\nQuestion 🧪\nline\n\n### Assistant\nAnswer αβ\n\n### Assistant\nSeparate assistant\n\n### User\nNext\n\n### Assistant\nDone";
const LEGACY_TEXT = "legacy manager transcript";
const LEGACY_ERROR = "Legacy fixture cannot read its transcript";
const NATIVE_ERROR = { code: -32603, message: "Fixture load failed", data: { status: 503, fixture: "wire-load-cause" } };
const EXPECTED_CLASSIFICATION = {
  errorKind: "overloaded", agentId: "agy-acp", sourceKind: "503", details: NATIVE_ERROR.message,
};
const logger = pino({ level: "silent" });
const stops: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const stop of stops.splice(0).reverse()) {
    try { await stop(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Wire fixture cleanup outcomes");
});

function records(file: string): any[] {
  return fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

function fixtureAdapters(loadError = false, legacyError = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "seam-transcript-wire-"));
  stops.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const requests = path.join(cwd, "requests.jsonl");
  const lifecycle = path.join(cwd, "lifecycle.jsonl");
  const native = makeAgyAcpProfile({
    defaultModel: "fixture-flash", cliPath: process.execPath,
    acpArgs: [fileURLToPath(new URL("./fixtures/agy-acp-server.mjs", import.meta.url))], cwd,
    environment: { ...process.env, AGY_ACP_TEST_TRANSCRIPT: "1", AGY_ACP_TEST_REQUESTS: requests,
      AGY_ACP_TEST_LIFECYCLE: lifecycle,
      ...(loadError ? { AGY_ACP_TEST_LOAD_ERROR: JSON.stringify(NATIVE_ERROR) } : {}) },
  });
  const legacyRead = vi.fn(async (_cwd: string, _sessionId: string) => {
    if (legacyError) throw new Error(LEGACY_ERROR);
    return LEGACY_TEXT;
  });
  const legacy = asLocalAdapter({
    id: "agy", displayName: "Legacy fixture", defaultModel: "fixture-high",
    spawn: () => { throw new Error("legacy transcript uses its manager"); },
    sessionManager: { listSessions: async () => [], getTranscript: legacyRead,
      cloneSession: async () => {}, deleteSession: async () => {} },
  });
  const context = { adapters: new Map([["agy", legacy], ["agy-acp", native]]), workspaceRoot: cwd, cwd };
  // Inspect only the exact child identity recorded by this unchanged fixture.
  stops.push(() => {
    if (!fs.existsSync(lifecycle)) return;
    for (const row of records(lifecycle).filter(row => row.event === "start")) {
      if (process.platform !== "linux") continue;
      let stat: string;
      try { stat = fs.readFileSync(`/proc/${row.pid}/stat`, "utf8"); }
      catch (error: any) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      expect(fields[19] !== row.start || ["Z", "X"].includes(fields[0]!)).toBe(true);
    }
  });
  return { cwd, requests, lifecycle, native, legacyRead, context };
}

type AdapterFixture = ReturnType<typeof fixtureAdapters>;
type Request = { v: number; type: "rpc"; id: string; method: string; params: unknown; agentId?: string };
type ObservedRpc = { request: Request; reply?: ReturnType<typeof buildBridgeRpcReply>; dispatchError?: unknown };

function assertReaderClosed(f: AdapterFixture) {
  const calls = records(f.requests);
  expect(calls.map(row => row.method)).toEqual(["initialize", "session/load", "session/close"]);
  expect(calls[0].params).toEqual({ protocolVersion: 1,
    clientInfo: { name: "seam-acp", version: "0.1.0" }, clientCapabilities: {} });
  expect(calls[1].params).toEqual({ sessionId: SID, cwd: f.cwd, mcpServers: [] });
  expect(calls[2].params).toEqual({ sessionId: SID });
  const events = records(f.lifecycle);
  expect(events.map(row => row.event)).toEqual(["start", "close", "eof", "exit"]);
  expect(new Set(events.map(row => `${row.pid}/${row.start}`)).size).toBe(1);
}

async function wireFixture(loadError = false, legacyError = false) {
  const f = fixtureAdapters(loadError, legacyError);
  const server = createServer();
  stops.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const token = "transcript-wire-fixture-token";
  const hub = new BridgeHub({ logger,
    config: { REPOS_ROOT: f.cwd, bridgePresets: new Map() } as Config,
    httpServer: server, healthPort: port, dataDir: f.cwd,
    mutation: {} as ConfigMutationService, localBridgeTokenHash: hashBridgeToken(token),
  });
  stops.push(() => hub.close());
  let readyBridge: string | undefined;
  const ready = new Promise<void>(resolve => {
    const unsubscribe = hub.onBridgeReady(id => { readyBridge = id; resolve(); });
    stops.push(unsubscribe);
  });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { Authorization: `Bearer ${token}` } });
  const closed = new Promise<void>(resolve => { socket.once("close", () => resolve()); });
  const failures: unknown[] = [];
  socket.on("error", error => failures.push(error));
  const pending = new Set<Promise<void>>();
  const rpcs: ObservedRpc[] = [];
  const otherFrames: any[] = [];
  stops.push(async () => {
    await Promise.all([...pending]);
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close();
    await closed;
    if (failures.length) throw new AggregateError(failures, "Wire fixture callback outcomes");
  });
  async function receive(raw: string) {
    const frame = JSON.parse(raw);
    if (frame.type === "cmd" && frame.action === "listSlots") {
      otherFrames.push(frame);
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "cmd_reply", cmdId: frame.cmdId,
        payload: { slots: [], health: [] } }));
      return;
    }
    if (frame.type !== "rpc") { otherFrames.push(frame); return; }
    const observed: ObservedRpc = { request: frame };
    rpcs.push(observed);
    let reply: ReturnType<typeof buildBridgeRpcReply>;
    try {
      const result = await dispatchBridgeRpc(frame.method, frame.params, frame.agentId, f.context);
      reply = buildBridgeRpcReply(frame.id, { ok: true, result });
    } catch (error) {
      observed.dispatchError = error;
      reply = buildBridgeRpcReply(frame.id, { ok: false, error });
    }
    const bytes = JSON.stringify(reply);
    observed.reply = JSON.parse(bytes);
    socket.send(bytes);
  }
  socket.on("message", raw => {
    const work = receive(raw.toString()).catch(error => { failures.push(error); });
    pending.add(work);
    void work.then(() => pending.delete(work));
  });
  await once(socket, "open");
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", bridgeId: "local",
    instanceId: "transcript-wire-fixture-instance", protocolVersion: PROTOCOL_VERSION,
    capabilities: { durableSlots: true },
    host: { os: process.platform, arch: process.arch, workspaceRoot: f.cwd },
    agents: [...f.context.adapters.keys()].map(agentId => ({ agentId, version: 1, installed: true })),
  }));
  await ready;
  expect(readyBridge).toBe("local");
  expect(hub.listConnected()[0]?.agents.get("agy")?.ready).toBe(true);
  expect(hub.listConnected()[0]?.agents.get("agy-acp")?.ready).toBe(true);
  expect(rpcs.map(row => [row.request.method, row.request.agentId])).toEqual([["prepare", "agy"], ["prepare", "agy-acp"]]);
  expect(rpcs.every(row => row.reply?.ok === true)).toBe(true);
  expect(fs.existsSync(f.requests)).toBe(false);
  return { ...f, hub, rpcs, otherFrames, failures };
}

type WireFixture = Awaited<ReturnType<typeof wireFixture>>;
function transcriptCalls(f: WireFixture, owners: string[]) {
  const calls = f.rpcs.filter(row => row.request.method === "getTranscript");
  expect(calls.map(row => row.request.agentId)).toEqual(owners);
  expect(new Set(calls.map(row => row.request.id)).size).toBe(owners.length);
  for (const row of calls) {
    expect(row.request.v).toBe(PROTOCOL_VERSION);
    expect(row.request.params).toEqual({ cwd: f.cwd, sessionId: SID });
    expect(row.reply).toMatchObject({ v: PROTOCOL_VERSION, type: "rpc_reply", id: row.request.id });
  }
  expect(f.failures).toEqual([]);
  return calls;
}

function assertNativeError(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject(NATIVE_ERROR);
  expect(readErrorClassification(error)).toEqual(EXPECTED_CLASSIFICATION);
}

describe("remote transcript over the actual bridge WebSocket", () => {
  it("C1 routes native and legacy same-SID transcripts over the bridge wire", async () => {
    const f = await wireFixture();
    const native = remoteSessionManager(f.hub, "local", "agy-acp");
    const legacy = remoteSessionManager(f.hub, "local", "agy");
    expect(await native.getTranscript(f.cwd, SID)).toBe(EXPECTED_TEXT);
    expect(f.legacyRead).not.toHaveBeenCalled();
    assertReaderClosed(f);
    expect(await legacy.getTranscript(f.cwd, SID)).toBe(LEGACY_TEXT);
    expect(f.legacyRead).toHaveBeenCalledExactlyOnceWith(f.cwd, SID);
    expect(f.native.sessionManager).toBeUndefined();
    const calls = transcriptCalls(f, ["agy-acp", "agy"]);
    for (const [index, text] of [EXPECTED_TEXT, LEGACY_TEXT].entries()) {
      expect(calls[index]!.reply).toEqual({ v: PROTOCOL_VERSION, type: "rpc_reply",
        id: calls[index]!.request.id, ok: true, result: text });
    }
    assertReaderClosed(f);
  });

  it("C2 direct dispatcher retains the native structured load error after partial replay", async () => {
    const f = fixtureAdapters(true);
    const outcome = await dispatchBridgeRpc("getTranscript", { cwd: f.cwd, sessionId: SID }, "agy-acp", f.context)
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    assertReaderClosed(f);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Partial replay became successful transcript text");
    assertNativeError(outcome.error);
    expect(f.legacyRead).not.toHaveBeenCalled();
  });

  it("R1 preserves native getTranscript error fields over the bridge wire", async () => {
    const f = await wireFixture(true);
    const manager = remoteSessionManager(f.hub, "local", "agy-acp");
    const outcome = await manager.getTranscript(f.cwd, SID)
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    assertReaderClosed(f);
    const [call] = transcriptCalls(f, ["agy-acp"]);
    assertNativeError(call!.dispatchError);
    expect(call!.reply).toMatchObject({ ok: false, error: NATIVE_ERROR.message });
    expect(f.legacyRead).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Partial replay became successful transcript text");
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toBe(`Session host "local" could not answer getTranscript: ${NATIVE_ERROR.message}`);
    expect(outcome.error.cause).toBeInstanceOf(Error);
    // This preservation contract is predicted RED with the current string-only reply/mux.
    expect.soft(outcome.error.cause).toMatchObject(NATIVE_ERROR);
    expect.soft(readErrorClassification(outcome.error.cause)).toEqual(EXPECTED_CLASSIFICATION);
  });

  it("C3 keeps ordinary string RPC errors usable over the same wire", async () => {
    const f = await wireFixture(false, true);
    const outcome = await remoteSessionManager(f.hub, "local", "agy").getTranscript(f.cwd, SID)
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    const [call] = transcriptCalls(f, ["agy"]);
    expect(call!.dispatchError).toBeInstanceOf(Error);
    expect(call!.reply).toEqual({ v: PROTOCOL_VERSION, type: "rpc_reply", id: call!.request.id,
      ok: false, error: LEGACY_ERROR });
    expect(f.legacyRead).toHaveBeenCalledExactlyOnceWith(f.cwd, SID);
    expect(fs.existsSync(f.requests)).toBe(false);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Plain legacy error became successful text");
    expect(outcome.error.message).toBe(`Session host "local" could not answer getTranscript: ${LEGACY_ERROR}`);
    expect(outcome.error.cause).toBeInstanceOf(Error);
    expect(outcome.error.cause.message).toBe(LEGACY_ERROR);
    expect(readErrorClassification(outcome.error.cause)).toBeNull();
  });
});
