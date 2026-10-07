// Real sessiond/adapter-child processes and SQLite; the provider is a fixture.
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { makeMux, type AgentProfile } from "@seam/adapters";
import { classifyCodexError } from "../../packages/adapters/src/profiles/codex.js";
import { SessiondServer } from "../../packages/bridge/src/sessiond-server.js";
import { SessiondClient } from "../../packages/bridge/src/sessiond-client.js";
import { SupervisedSlots } from "../../packages/bridge/src/supervised-slots.js";
import { SessionRouter } from "../../packages/core/src/core/session-router.js";
import { SessionStore } from "../../packages/core/src/core/session-store.js";
import { Orchestrator } from "../../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "../model-catalog-fixture.js";
import { visualConfig } from "../plugin-card-visuals-fixture.js";
import type { SessionExecutables } from "./saved-session-executables.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.resolve(here, "../fixtures/fake-acp-agent.mjs");
export const SAVED_SESSION = "saved-conversation";

export async function savedSessionHost(options: {
  failLoad?: boolean;
  loadGate?: boolean;
  newGate?: boolean;
  sessionGone?: boolean;
  legacy?: boolean;
  oldAuthDisarm?: boolean;
  authFailure?: boolean;
  writerLock?: boolean;
  recoverySleep?: (ms: number) => Promise<void>;
} & Partial<SessionExecutables> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-797-"));
  const failure = path.join(root, "load.failure");
  if (options.failLoad) await fs.writeFile(failure, "fixture outage");
  const authFailure = path.join(root, "auth.failure");
  if (options.authFailure) await fs.writeFile(authFailure, "fixture authentication required");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await fs.symlink(fakeAgent, path.join(bin, "codex-acp"));
  const server = new SessiondServer({ socketPath: path.join(root, "control.sock"),
    statePath: path.join(root, "slots.json"), resumeDir: path.join(root, "resume"),
    holderPath: options.holderPath ?? process.env.SEAM_SLOT_HOLDER_PATH ?? path.join(here, "slot-holder-source.mjs") });
  await server.start();
  const client = await SessiondClient.connect(path.join(root, "control.sock"));
  const logger = pino({ level: "silent" });
  const commands: any[] = [];
  let slots!: SupervisedSlots;
  class Socket extends EventEmitter {
    readyState = 1;
    deliver(frame: unknown) { this.emit("message", Buffer.from(JSON.stringify(frame))); }
    send(raw: string) {
      const frame = JSON.parse(raw);
      commands.push(frame);
      void this.handle(frame).catch(error => this.deliver(frame.type === "rpc"
        ? { type: "rpc_reply", id: frame.id, ok: false, error: error.message }
        : frame.type === "data" ? { slot: frame.slot, type: "exit", code: 1, spawnError: error.message }
        : { type: "cmd_reply", cmdId: frame.cmdId, error: error.message }));
    }
    async handle(frame: any) {
      if (frame.type === "data") { await slots.writeInput(frame.slot, frame.data); return; }
      if (frame.type === "kill") { await slots.kill(frame.slot); return; }
      if (frame.type === "ping") { this.deliver({ type: "pong" }); return; }
      if (frame.type === "rpc" && frame.method === "spawn") {
        slots.configure(frame.params.slot, frame.params);
        this.deliver({ type: "rpc_reply", id: frame.id, ok: true,
          result: { projectMcpInjection: true, rung1RecoveryVersion: 1 } });
        return;
      }
      if (frame.type !== "cmd") return;
      const p = frame.payload;
      let result: unknown;
      let activate: (() => void) | undefined;
      switch (frame.action) {
        case "listSlots": result = await slots.listSlots(); break;
        case "replayOutput": {
          const replay = await slots.replay(p.slot, p.afterSeq);
          result = replay.result; activate = replay.activate; break;
        }
        case "ackOutput": await slots.ack(p.slot, p.throughSeq); result = {}; break;
        case "armRung1Recovery": result = await slots.armRecovery(p.slot, p); break;
        case "disarmRung1Recovery": result = await slots.disarmRecovery(p.slot, p.submissionId); break;
        case "reconcileRung1Recovery": result = await slots.reconcileRecovery(p.slot, p); break;
        default: throw new Error(`unexpected fixture command: ${frame.action}`);
      }
      this.deliver({ type: "cmd_reply", cmdId: frame.cmdId, payload: result });
      activate?.();
    }
    close() { this.readyState = 3; this.emit("close"); }
  }
  const socket = new Socket();
  slots = new SupervisedSlots({ client, copilotCmd: fakeAgent, localCwd: root,
    adapterChildPath: options.adapterChildPath ?? path.join(here, options.oldAuthDisarm ? "adapter-child-old-auth-disarm.mjs"
      : options.legacy ? "adapter-child-legacy.mjs" : "adapter-child-source.mjs"),
    environment: { HOME: root, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_AGENT_PIDS: path.join(root, "agent.pids"), FAKE_AGENT_REQUESTS: path.join(root, "requests.jsonl"),
      FAKE_AGENT_LOAD_FAILURE: failure, FAKE_AGENT_NEW_SESSION_ID: "replacement-conversation",
      ...(options.loadGate ? { FAKE_AGENT_LOAD_GATE: path.join(root, "load.release") } : {}),
      ...(options.newGate ? { FAKE_AGENT_NEW_GATE: path.join(root, "new.release") } : {}),
      FAKE_AGENT_AUTH_FAILURE: authFailure,
      ...(options.writerLock ? { FAKE_AGENT_WRITER_LOCK: path.join(root, "session.writer") } : {}),
      ...(options.sessionGone ? { FAKE_AGENT_MISSING_SESSION: SAVED_SESSION } : {}) },
    onFrame: frame => socket.deliver(frame), onStderr: () => {} });
  const mux = makeMux({ id: "fixture" });
  mux.attach(socket as never);
  socket.deliver({ type: "hello", instanceId: "fixture", capabilities: { durableSlots: true } });
  const db = path.join(root, "sessions.db");
  const store = new SessionStore(db);
  const now = new Date().toISOString();
  const record = { id: "discord:fixture-thread", platform: "discord", channelRef: "fixture-thread",
    parentRef: null, agentId: "codex", acpSessionId: SAVED_SESSION, repoPath: root,
    configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const profile = { id: "codex", defaultModel: "default", classifyError: classifyCodexError,
    spawn() { throw new Error("must use bridge"); } } as unknown as AgentProfile;
  const catalog = fixtureModelCatalog([profile]);
  const routers: SessionRouter[] = [];
  const notices: Array<{ channel: unknown; text: string }> = [];
  function makeRouter() {
    const router = new SessionRouter({ logger, store, profiles: [profile], modelCatalog: catalog,
      defaultAgentId: "codex", defaultModel: "default", threadPresets: new Map([[record.channelRef, { location: "fixture" }]]),
      seamMcp: { registry: {} as any, getPort: () => undefined, isBridgeSession: () => true,
        bindSessionLocation: () => {}, muxForSession: () => mux } });
    routers.push(router);
    return router;
  }
  function makeOrchestrator(router: SessionRouter) {
    const adapter = { sendMessage: async (channel: unknown, text: string) => {
      notices.push({ channel, text }); return { channel, id: "fixture-message" };
    },
      editPanel: async () => {}, deleteMessage: async () => {} };
    const orch = new Orchestrator({ logger, store, router, modelCatalog: catalog,
      adapter: adapter as any, renderer: discordRenderer as any,
      ...(options.recoverySleep ? { recoverySleep: options.recoverySleep } : {}),
      config: { ...visualConfig, DATA_DIR: root, REPOS_ROOT: root, REPO_EMOJIS: new Map(),
        DISCORD_ALLOWED_USER_IDS: new Set(["fixture-user"]),
        channelPresets: new Map(), threadPresets: new Map() } as any });
    orch.setBridgeHub({ muxFor: () => mux, onBridgeReady: () => () => {} } as any);
    return orch;
  }
  const requests = async () => (await fs.readFile(path.join(root, "requests.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  return { root, db, record, store, mux, slots, client, commands, notices, makeRouter, makeOrchestrator, requests,
    repairLoad: () => fs.rm(failure, { force: true }),
    releaseLoad: () => fs.writeFile(path.join(root, "load.release"), "released"),
    releaseNew: () => fs.writeFile(path.join(root, "new.release"), "released"),
    async close() {
      for (const router of routers) await router.disposeAll();
      socket.close();
      client.close();
      await server.close({ terminateChildren: true });
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    } };
}

export async function loadOutageProof(recoverySleep?: (ms: number) => Promise<void>, executables?: SessionExecutables) {
  const h = await savedSessionHost({ ...executables, failLoad: true, recoverySleep });
  try {
    const router = h.makeRouter();
    let loadError: any;
    const first = await router.getOrStartRuntime(h.record).catch(error => { loadError = error; });
    const afterFailure = h.store.get(h.record.id)!.acpSessionId;
    const beforeRepair = await h.requests();
    await h.repairLoad();
    const orch = h.makeOrchestrator(router);
    const runtime = first ?? await (orch as any).acquireRecordedRuntime(h.record, "fixture-turn", SAVED_SESSION);
    await runtime.prompt("continue");
    const reopened = new SessionStore(h.db);
    const finalId = reopened.get(h.record.id)!.acpSessionId;
    reopened.close();
    const requests = await h.requests();
    return { afterFailure, finalId, loadError: loadError && { message: loadError.message,
      code: loadError.code, data: loadError.data },
      loadsBeforeRepair: beforeRepair.filter(r => r.method === "session/load").length,
      newSessions: requests.filter(r => r.method === "session/new").length,
      promptSession: requests.findLast(r => r.method === "session/prompt")?.params.sessionId };
  } finally { await h.close(); }
}

export async function sessionGoneProof(recordedResume = false, recoverySleep?: (ms: number) => Promise<void>, executables?: SessionExecutables) {
  const h = await savedSessionHost({ ...executables, sessionGone: true, recoverySleep });
  try {
    const router = h.makeRouter();
    const orch = h.makeOrchestrator(router);
    const first = await orch.injectTurn(h.record, "continue first turn", { session: "live",
      ...(recordedResume ? { resumeSessionId: SAVED_SESSION } : {}) });
    if (first.error) throw first.cause ?? new Error(first.error);
    const afterRecovery = h.store.get(h.record.id)!.acpSessionId;
    await router.invalidate(h.record.id);
    const later = await orch.injectTurn(h.store.get(h.record.id)!, "continue later turn", { session: "live" });
    if (later.error) throw later.cause ?? new Error(later.error);
    const reopened = new SessionStore(h.db);
    const finalId = reopened.get(h.record.id)!.acpSessionId;
    reopened.close();
    const requests = await h.requests();
    return { afterRecovery, finalId, notices: h.notices,
      missingLoads: requests.filter(r => r.method === "session/load" && r.params.sessionId === SAVED_SESSION).length,
      laterLoads: requests.filter(r => r.method === "session/load" && r.params.sessionId === afterRecovery).length,
      newSessions: requests.filter(r => r.method === "session/new").length,
      promptSessions: requests.filter(r => r.method === "session/prompt").map(r => r.params.sessionId) };
  } finally { await h.close(); }
}

export async function handoverProof(legacy = false, executables?: SessionExecutables) {
  const h = await savedSessionHost({ ...executables, legacy });
  try {
    const previous = h.makeRouter();
    const runtime = await previous.getOrStartRuntime(h.record);
    const child = (runtime as any).child;
    const slot = child.slot;
    const before = (await h.client.listSlots()).health.find(row => row.slot === slot)!;
    h.store.turnAttempts.registerOwner("old-controller");
    const attempt = h.store.turnAttempts.claim({ id: "stranded", target: h.record.channelRef, prompt: "missing prompt",
      session: "live", kind: "parked", createdUtc: new Date().toISOString() }, "fixture-identity", "old-controller", "dispatch");
    h.store.turnAttempts.bind(attempt, SAVED_SESSION);
    h.store.turnAttempts.startPrompt(attempt);
    const snapshot = await h.slots.armRecovery(slot, { submissionId: "stranded-submission", acpSessionId: SAVED_SESSION,
      continuation: "continue" });
    h.store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "fixture", slot,
      submissionId: snapshot.submissionId, acpSessionId: SAVED_SESSION, delegatedUtc: snapshot.updatedUtc });
    h.store.turnAttempts.suspendBoot("old-controller");
    runtime.releaseRecovery();
    child.detach();
    const router = h.makeRouter();
    const orch = h.makeOrchestrator(router);
    await orch.loadPlugins();
    await (orch as any).adoptRemoteRecoveryOwned(h.store.turnAttempts.get(attempt.id));
    const boundAfterSettlement = h.mux.isBound(slot);
    const next = await router.getOrStartRuntime(h.store.get(h.record.id)!);
    const newSlot = next.getSlot();
    let delegated = false;
    const response = await next.prompt("continue next turn", undefined, {
      onRemoteRecovery: binding => { delegated = binding.slot === slot && binding.acpSessionId === SAVED_SESSION; },
      onRemoteRecoveryReleased: () => {},
    });
    const after = (await h.client.listSlots()).health.find(row => row.slot === newSlot)!;
    const requests = await h.requests();
    return { legacy, beforePid: before.pid, afterPid: after.pid, slot, newSlot, boundAfterSettlement,
      state: h.store.turnAttempts.get(attempt.id)?.state, response: response.stopReason, delegated,
      processes: new Set(requests.map(r => r.pid)).size,
      loads: requests.filter(r => r.method === "session/load").length,
      prompts: requests.filter(r => r.method === "session/prompt").map(r => ({ pid: r.pid, session: r.params.sessionId })) };
  } finally { await h.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = process.argv[2] === "load" ? await loadOutageProof()
    : process.argv[2] === "gone" ? await sessionGoneProof() : await handoverProof(process.argv[2] === "legacy");
  console.log(JSON.stringify(result, null, 2));
}
