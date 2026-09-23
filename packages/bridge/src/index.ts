#!/usr/bin/env node
/**
 * remote-agent-bridge (packages/bridge)
 *
 * Mux transport between a local agent CLI and seam-acp over a WebSocket.
 *
 * Protocol: slot mux (data / kill / exit) plus the typed command bus
 * (hello / hello_ack / rpc / rpc_reply / event). listSlots still uses
 * cmd / cmd_reply. SIGUSR2 enters drain mode.
 *
 *   seam-bridge connect --server <wss-url> --id <bridgeId> --token <token> [--cwd] [--dev]
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CLIENT MODE (default): bridge dials out to seam-acp's WS server.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Usage:
 *     node packages/bridge/dist/index.js <ws-url> <token> [--cwd <path>] [agent-cmd]
 *
 *   Arguments:
 *     ws-url      seam-acp WebSocket URL, e.g. wss://tunnel.trycloudflare.com
 *                 (or ws://localhost:9999 for local testing)
 *     token       Shared secret for the WS handshake
 *     --cwd path  Local working directory for spawned agent processes
 *                 (default: process.cwd()). ACP JSON cwd fields are not rewritten.
 *     agent-cmd   Optional path to the agent binary (default: "copilot")
 *                 Override with COPILOT_CMD env var.
 *
 *   Example:
 *     node packages/bridge/dist/index.js wss://your-tunnel.trycloudflare.com mysecret --cwd /Users/you/Projects
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SERVER MODE: bridge hosts a WS server; seam-acp dials in.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Usage:
 *     node packages/bridge/dist/index.js --server <port> <token> [--cwd <path>] [agent-cmd]
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Dependencies:
 *   ws + workspace @seam/adapters (no discord.js / croner / orchestrator)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { RawData, WebSocket as WsSocket } from "ws";
import {
  PROTOCOL_VERSION,
  sweepAgyMcpHomes,
  type AgentAdapter,
} from "@seam/adapters";
import { dispatchBridgeRpc, type SlotSpawnConfig } from "./rpc.js";
import { collectHangEvidence, createProbeGate, readLiveProviderSocket } from "./hang-probe.js";
import { createOomEvidenceRegistry } from "./oom-evidence.js";
import { createStderrRegistry } from "./stderr-ring.js";
import { BridgeMcpInputRewriter } from "./mcp-injection.js";
import {
  inventoryFromAdapters,
  loadHostAdapterInventory,
} from "./inventory.js";
import { createReleaseReceiptWriter, readRunningReleaseSha, type ReleaseReceiptWriter } from "./release-receipt.js";
import { connectSessiond } from "./sessiond-connect.js";
import type { SessiondClient } from "./sessiond-client.js";
import { SupervisedSlots, type SupervisedBridgeFrame } from "./supervised-slots.js";
import { bridgeHello } from "./hello.js";
import { acquireProcessLease } from "./process-lease.js";

type WsCtor = typeof import("ws").WebSocket;
type WssCtor = typeof import("ws").WebSocketServer;

type SqlRow = Record<string, any>;

interface SlotManager {
  setWs(ws: WsSocket | null): void;
  handleMessage(raw: RawData): void;
  drain(): void;
}

const copilotDir = path.join(homedir(), ".copilot");
const dbPath = path.join(copilotDir, "session-store.db");
const sessionStateDir = path.join(copilotDir, "session-state");

/** Write an uploaded attachment to this machine's filesystem under
 *  `<cwd>/.seam-attachments/<filename>` and return the absolute path. Used by
 *  network-restricted remote agents that can't fetch Discord CDN URLs but
 *  can still consume local files. */
async function writeAttachment(cwd: string, filename: string, base64: string) {
  // Sanitize filename: strip path separators so callers can't write outside
  // the .seam-attachments directory.
  const safe = path.basename(filename).replace(/[\/\\]/g, "_");
  const dir = path.join(cwd, ".seam-attachments");
  await fsp.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, safe);
  await fsp.writeFile(absPath, Buffer.from(base64, "base64"));
  return { path: absPath };
}

function escapeSql(val: unknown) {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return String(val);
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function parseSqliteLineFormat(stdout: string): SqlRow[] {
  const lines = stdout.split("\n");
  const results: SqlRow[] = [];
  let currentRow: SqlRow | null = null;
  for (const line of lines) {
    if (!line.trim()) {
      if (currentRow) {
        results.push(currentRow);
        currentRow = null;
      }
      continue;
    }
    const match = line.match(/^\s*([^=\s]+)\s*=\s*(.*)$/);
    if (match) {
      if (!currentRow) currentRow = {};
      currentRow[match[1]!] = match[2];
    }
  }
  if (currentRow) {
    results.push(currentRow);
  }
  return results;
}

function execSql(db: string, sql: string): SqlRow[] {
  try {
    const stdout = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8" });
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch (err: any) {
    try {
      const stdout = execFileSync("sqlite3", ["-line", db, sql], { encoding: "utf8" });
      return parseSqliteLineFormat(stdout);
    } catch (fallbackErr: any) {
      console.error("[bridge] SQL execution error:", err.message, fallbackErr.message);
      throw err;
    }
  }
}


/** Milliseconds to wait before reconnecting after a disconnect (client mode). */
const RECONNECT_DELAY_MS = 5_000;

// Unique ID for this bridge process lifetime. Sent to seam-acp on every WS
// connect so it can detect a bridge restart and evict stale runtimes.
const BRIDGE_INSTANCE_ID = randomUUID();

/** Interval for sending WS ping frames to keep the tunnel/proxy alive. */
const KEEPALIVE_PING_MS = 25_000;
/**
 * #427: how long a ping may go unanswered before this side gives up.
 *
 * The ping was blind — no `pong` listener, no timeout — so the client happily
 * pinged a dead path forever while `readyState` read OPEN. Two intervals plus
 * margin: one missed pong is a hiccup, two in a row through a tunnel that is
 * still forwarding nothing is not. Deliberately longer than the server's own
 * window so the server, which can see every bridge, is normally the one that
 * decides; this is the backstop for the case where the server is the peer that
 * vanished.
 */
const KEEPALIVE_PONG_TIMEOUT_MS = 60_000;

async function loadWs(): Promise<{ WebSocket: WsCtor; WebSocketServer: WssCtor }> {
  try {
    const mod = await import("ws");
    return { WebSocket: mod.WebSocket, WebSocketServer: mod.WebSocketServer };
  } catch {
    console.error("Error: 'ws' package not found. Install it with: npm install ws");
    process.exit(1);
  }
}

/**
 * Create the restartable control-plane view of sessiond-owned slots.
 * New slots are admitted lazily on first input; retained slots rebind fully
 * usable and survive both websocket and bridge-process restarts.
 */
async function makeSlotManager(opts: {
  copilotCmd: string;
  localCwd: string;
  workspaceRoot: string;
  WebSocket: WsCtor;
  bridgeId: string;
  devMode: boolean;
  adapters: Map<string, AgentAdapter>;
  releaseReceipt?: ReleaseReceiptWriter | null;
  /** Standing release identity. Null when this process has no stage receipt. */
  releaseSha?: string | null;
  sessiond: SessiondClient;
}): Promise<SlotManager> {
  const { copilotCmd, localCwd, workspaceRoot, WebSocket, bridgeId, devMode, adapters, releaseReceipt, releaseSha, sessiond } = opts;
  let currentWs: WsSocket | null = null;
  const slotConfigs = new Map<number, SlotSpawnConfig>();
  let draining = false;
  /**
   * #456: agent fd 2 was piped with no reader, which stalls the child once the
   * 64 KiB pipe buffer fills. Draining removes the stall; keeping a bounded
   * ring means an abnormal exit can report its cause the way the local path
   * already does.
   */
  const stderrRegistry = createStderrRegistry();
  /** #516: exact descendant ownership while the child is alive. Kernel OOM
   * evidence is useful only when its killed pid was observed in this tree. */
  const oomEvidence = createOomEvidenceRegistry();
  const slotInputRewriters = new Map<number, BridgeMcpInputRewriter>();
  /**
   * #443: absorbs the hang-probe response so it never becomes a turn error.
   * One probe per slot. The id is unique, so a late reply cannot swallow a
   * real stdout line.
   */
  const probes = createProbeGate();

  function wsSend(payload: Record<string, unknown>) {
    if (currentWs && currentWs.readyState === WebSocket.OPEN) {
      currentWs.send(JSON.stringify(payload));
    }
  }

  const sendSupervisedFrame = (frame: SupervisedBridgeFrame & { slot: number }): void => {
    if (frame.type === "data" && frame.data !== undefined) {
      if (!probes.absorb(frame.slot, frame.data)) {
        wsSend({ slot: frame.slot, type: "data", data: frame.data, seq: frame.seq });
      }
      return;
    }
    if (frame.type === "recovery" && frame.recovery) {
      wsSend({ slot: frame.slot, type: "recovery", recovery: frame.recovery, seq: frame.seq });
      return;
    }
    if (frame.type === "recovery_result" && frame.recoveryResult) {
      wsSend({ slot: frame.slot, type: "recovery_result", recoveryResult: frame.recoveryResult, seq: frame.seq });
      return;
    }
    if (frame.type !== "exit") return;
    slotInputRewriters.delete(frame.slot);
    probes.close(frame.slot);
    const payload = stderrRegistry.exitPayload(frame.slot, frame.code ?? null, frame.signal ?? null);
    const abnormal = (frame.code !== 0 && frame.code !== null) || frame.signal != null;
    void oomEvidence.exitPayload(frame.slot, payload, abnormal).then((exitPayload) => {
      wsSend({
        slot: frame.slot,
        type: "exit",
        ...exitPayload,
        ...(frame.spawnError ? { spawnError: frame.spawnError } : {}),
        seq: frame.seq,
      });
    });
  };

  const supervised = new SupervisedSlots({
    client: sessiond,
    copilotCmd,
    localCwd,
    onFrame: sendSupervisedFrame,
    onStderr: (slot, chunk) => stderrRegistry.observe(slot, chunk),
    onSpawn: (slot, pid) => oomEvidence.attach(slot, pid),
  });
  const retained = await supervised.rebind();
  for (const health of retained.health) {
    if (health.alive) oomEvidence.attach(health.slot, health.pid ?? undefined);
  }

  function setWs(ws: WsSocket | null) {
    currentWs = ws;
    if (ws) {
      // Announce our instance ID immediately. seam-acp uses this to detect a
      // bridge restart and evict its stale runtimes before sending new traffic.
      try {
        const agents = inventoryFromAdapters(adapters, copilotCmd).map((a) => ({
          ...a,
          ready: false,
        }));
        ws.send(
          JSON.stringify(bridgeHello({
            bridgeId,
            instanceId: BRIDGE_INSTANCE_ID,
            protocolVersion: PROTOCOL_VERSION,
            ...(releaseSha ? { releaseSha } : {}),
            host: {
              os: process.platform,
              arch: process.arch,
              workspaceRoot,
              home: homedir(),
            },
            agents,
            devMode,
            ...(releaseReceipt ? { release: releaseReceipt.helloMetadata() } : {}),
          }))
        );
      } catch { /* ws may not be open yet — best effort */ }
    }
  }


  async function handleCmd(msg: { cmdId: string; action: string; payload: any }) {
    const { cmdId, action } = msg;
    const payload = msg.payload;
    console.error(`[bridge] cmd: ${action} (cmdId=${cmdId})`);
    try {
      let result: unknown;
      let activateReplay: (() => void) | undefined;
      if (action === "listSessions") {
        try {
          await fsp.access(dbPath);
        } catch {
          console.error(`[bridge] listSessions: DB not found at ${dbPath}`);
          wsSend({ type: "cmd_reply", cmdId, payload: [] });
          return;
        }
        // Match sessions by cwd OR by sessions with no cwd (created before the
        // cwd-rewrite fix). The latter covers existing sessions on the remote
        // machine that the Copilot CLI stored without a cwd value.
        const sessions = execSql(
          dbPath,
          `SELECT * FROM sessions WHERE cwd = ${escapeSql(payload.cwd)} OR cwd IS NULL OR cwd = '' ORDER BY updated_at DESC LIMIT 50`
        );
        console.error(`[bridge] listSessions: found ${sessions.length} session(s) for cwd=${payload.cwd}`);
        const summaries = [];
        for (const sess of sessions) {
          const sessionId = sess.id;
          const createdAt = sess.created_at ? Date.parse(sess.created_at) : Date.now();
          const lastActivityAt = sess.updated_at ? Date.parse(sess.updated_at) : Date.now();
          const turns = execSql(
            dbPath,
            `SELECT * FROM turns WHERE session_id = ${escapeSql(sessionId)} ORDER BY turn_index ASC`
          );
          const allMessages: Array<{ sender: "human" | "agent"; text: string }> = [];
          for (const turn of turns) {
            if (turn.user_message) {
              allMessages.push({ sender: "human", text: turn.user_message });
            }
            if (turn.assistant_response) {
              allMessages.push({ sender: "agent", text: turn.assistant_response });
            }
          }
          let previewLines: typeof allMessages = [];
          if (allMessages.length <= 16) {
            previewLines = allMessages;
          } else {
            const firstSix = allMessages.slice(0, 6);
            const lastTen = allMessages.slice(-10);
            previewLines = [...firstSix, ...lastTen];
          }
          const transcriptLines = [];
          for (const turn of turns) {
            if (turn.user_message?.trim()) {
              transcriptLines.push(`### User\n${turn.user_message.trim()}`);
            }
            if (turn.assistant_response?.trim()) {
              transcriptLines.push(`### Assistant\n${turn.assistant_response.trim()}`);
            }
          }
          const estimatedTokens = Math.ceil(transcriptLines.join("\n\n").length / 4);

          summaries.push({
            sessionId,
            createdAt,
            lastActivityAt,
            previewLines,
            estimatedTokens,
          });
        }
        result = summaries;
      } else if (action === "cloneSession") {
        const sessions = execSql(
          dbPath,
          `SELECT * FROM sessions WHERE id = ${escapeSql(payload.oldSessionId)}`
        );
        const sessionRow = sessions[0];
        if (sessionRow) {
          const nowIso = new Date().toISOString();
          execSql(
            dbPath,
            `INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at)
             VALUES (
               ${escapeSql(payload.newSessionId)},
               ${escapeSql(payload.cwd)},
               ${escapeSql(sessionRow.repository)},
               ${escapeSql(sessionRow.host_type)},
               ${escapeSql(sessionRow.branch)},
               ${escapeSql(sessionRow.summary)},
               ${escapeSql(nowIso)},
               ${escapeSql(nowIso)}
             )`
          );
        }
        const turns = execSql(
          dbPath,
          `SELECT * FROM turns WHERE session_id = ${escapeSql(payload.oldSessionId)} ORDER BY turn_index ASC`
        );
        for (const turn of turns) {
          execSql(
            dbPath,
            `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
             VALUES (
               ${escapeSql(payload.newSessionId)},
               ${escapeSql(turn.turn_index)},
               ${escapeSql(turn.user_message)},
               ${escapeSql(turn.assistant_response)},
               ${escapeSql(turn.timestamp)}
             )`
          );
        }
        const oldSubDir = path.join(sessionStateDir, payload.oldSessionId);
        const newSubDir = path.join(sessionStateDir, payload.newSessionId);
        try {
          const stat = await fsp.stat(oldSubDir);
          if (stat.isDirectory()) {
            await fsp.mkdir(newSubDir, { recursive: true });
            await fsp.cp(oldSubDir, newSubDir, { recursive: true });
          }
        } catch {
          // ignore
        }
        result = null;
      } else if (action === "deleteSession") {
        execSql(dbPath, `DELETE FROM sessions WHERE id = ${escapeSql(payload.sessionId)}`);
        execSql(dbPath, `DELETE FROM turns WHERE session_id = ${escapeSql(payload.sessionId)}`);
        try {
          execSql(dbPath, `DELETE FROM search_index_content WHERE c1 = ${escapeSql(payload.sessionId)}`);
        } catch {
          // ignore
        }
        const subDir = path.join(sessionStateDir, payload.sessionId);
        try {
          await fsp.rm(subDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        result = null;
      } else if (action === "getTranscript") {
        const turns = execSql(
          dbPath,
          `SELECT * FROM turns WHERE session_id = ${escapeSql(payload.sessionId)} ORDER BY turn_index ASC`
        );
        const transcriptLines = [];
        for (const turn of turns) {
          if (turn.user_message?.trim()) {
            transcriptLines.push(`### User\n${turn.user_message.trim()}`);
          }
          if (turn.assistant_response?.trim()) {
            transcriptLines.push(`### Assistant\n${turn.assistant_response.trim()}`);
          }
        }
        result = transcriptLines.join("\n\n");
      } else if (action === "compactSession") {
        const nowIso = new Date().toISOString();
        execSql(
          dbPath,
          `INSERT INTO sessions (id, cwd, updated_at) 
           VALUES (${escapeSql(payload.sessionId)}, ${escapeSql(payload.cwd)}, ${escapeSql(nowIso)}) 
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
        );
        execSql(dbPath, `DELETE FROM turns WHERE session_id = ${escapeSql(payload.sessionId)}`);
        execSql(
          dbPath,
          `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
           VALUES (
             ${escapeSql(payload.sessionId)},
             0,
             ${escapeSql("[Session history compacted due to context limits]")},
             ${escapeSql(payload.summary)},
             ${escapeSql(nowIso)}
           )`
        );
        execSql(
          dbPath,
          `UPDATE sessions SET updated_at = ${escapeSql(nowIso)} WHERE id = ${escapeSql(payload.sessionId)}`
        );
        result = null;
      } else if (action === "probeHang") {
        // #443: seam-acp asks because it knows a prompt is outstanding. The
        // bridge answers because it holds the child. Refusing a slot we do
        // not have fails this command only — the turn is left running, and
        // every other slot is untouched.
        const slot = Number(payload?.slot);
        const listed = Number.isInteger(slot) ? await supervised.listSlots() : undefined;
        const health = listed?.health.find((entry) => entry.slot === slot);
        if (!health?.alive) {
          throw new Error("probeHang: slot has no live process");
        }
        const id = randomUUID();
        // Arm before writing. A late method-not-found stays absorbed until
        // the slot exits: the id is unique, so this cannot hide real output.
        const response = probes.arm(slot, id);
        result = await collectHangEvidence({
          id,
          writeLine: async (line) => {
            await supervised.writeInput(slot, line);
          },
          response,
          sockets: () => readLiveProviderSocket(health.pid ?? undefined),
        });
      } else if (action === "listSlots") {
        // #442/#574: sessiond holds the process. It is the only participant that
        // can answer "is it alive" and "when did it last speak" by OBSERVING
        // rather than inferring, so it answers exactly those and no more.
        //
        // `slots` stays first and unchanged: a new bridge must keep answering
        // an old seam-acp, and an old bridge answering a new seam-acp simply
        // omits `health` — which the caller treats as "no opinion" rather
        // than as "unhealthy". The frame is an array of objects so #456 can
        // hang a stderr tail off the same shape without another protocol turn.
        result = await supervised.listSlots();
      } else if (action === "armRung1Recovery") {
        const slot = Number(payload?.slot);
        if (!Number.isInteger(slot)) {
          throw new Error("armRung1Recovery: slot has no live process");
        }
        result = await supervised.armRecovery(slot, {
          submissionId: payload?.submissionId,
          acpSessionId: payload?.acpSessionId,
          continuation: payload?.continuation,
        });
      } else if (action === "disarmRung1Recovery") {
        const slot = Number(payload?.slot);
        result = Number.isInteger(slot)
          ? await supervised.disarmRecovery(slot, payload?.submissionId)
          : { disarmed: false };
      } else if (action === "replayOutput") {
        // #444: "read from where you were". The consumer's cursor is the only
        // state that matters, so a disconnect needs no special handling here —
        // it just asks again from the same place.
        //
        // An OLD bridge does not know this action and replies with an error,
        // which the mux treats as "no replay available" and falls back to
        // today's behaviour. That is why the fleet can be mixed-version.
        const slot = Number(payload.slot);
        const afterSeq = Number(payload.afterSeq ?? 0);
        const replay = await supervised.replay(slot, Number.isFinite(afterSeq) ? afterSeq : 0);
        result = replay.result;
        activateReplay = replay.activate;
      } else if (action === "ackOutput") {
        // Acks only ACCELERATE trimming. The age and byte bounds are what
        // guarantee memory comes back, because an old seam-acp never acks and
        // four of eight hosts cannot be updated to one that does.
        // sessiond retention is bounded independently of acknowledgements.
        // Keep accepting this old acceleration hint for wire compatibility.
        result = null;
      } else if (action === "writeAttachment") {
        result = await writeAttachment(payload.cwd, payload.filename, payload.base64);
      } else {
        throw new Error(`Unknown action: ${action}`);
      }
      wsSend({ type: "cmd_reply", cmdId, payload: result });
      activateReplay?.();
    } catch (err: any) {
      console.error(`[bridge] Error handling cmd ${action}:`, err);
      wsSend({ type: "cmd_reply", cmdId, error: err.message });
    }
  }

  function handleMessage(raw: RawData) {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "hello_ack") {
      if (msg.accepted === false) {
        console.error(`[bridge] hello rejected: ${msg.error ?? "protocol mismatch"}`);
      } else {
        console.error("[bridge] hello_ack accepted");
        void releaseReceipt?.recordHelloAccepted().catch((err) => {
          console.error("[bridge] could not write release ready receipt:", err instanceof Error ? err.message : String(err));
        });
      }
      return;
    }

    if (msg.type === "rpc") {
      const id = msg.id as string;
      const method = String(msg.method ?? "");
      void (async () => {
        try {
          const result = await dispatchBridgeRpc(method, msg.params, msg.agentId, {
            adapters,
            workspaceRoot,
            cwd: localCwd,
            devMode,
            configureSlot: (slot, cfg) => {
              slotConfigs.set(slot, cfg);
              supervised.configure(slot, cfg);
            },
          });
          await releaseReceipt?.recordCatalogRpc(method, msg.agentId);
          wsSend({ v: PROTOCOL_VERSION, type: "rpc_reply", id, ok: true, result });
        } catch (err: any) {
          console.error(`[bridge] rpc ${method} failed:`, err?.message ?? err);
          wsSend({
            v: PROTOCOL_VERSION,
            type: "rpc_reply",
            id,
            ok: false,
            error: err?.message ?? String(err),
          });
        }
      })();
      return;
    }

    if (msg.type === "event" && msg.name === "release_verified") {
      void releaseReceipt?.recordControllerVerification(msg.payload).catch((err) => {
        console.error("[bridge] could not write controller verification receipt:", err instanceof Error ? err.message : String(err));
      });
      return;
    }

    if (msg.type === "ping") {
      wsSend({ v: PROTOCOL_VERSION, type: "pong", ts: msg.ts });
      return;
    }

    if (msg.type === "data" && msg.data !== undefined) {
      if (draining) return;
      let rewriter = slotInputRewriters.get(msg.slot);
      if (!rewriter) {
        rewriter = new BridgeMcpInputRewriter(slotConfigs.get(msg.slot)?.mcpServers ?? []);
        slotInputRewriters.set(msg.slot, rewriter);
      }
      const rewritten = rewriter.push(msg.data);
      if (rewritten) void supervised.writeInput(msg.slot, rewritten).catch(() => {
        wsSend({ slot: msg.slot, type: "exit", code: 1, spawnError: "supervised slot unavailable" });
      });
    } else if (msg.type === "kill") {
      console.error(`[bridge] Slot ${msg.slot}: kill received — terminating supervised agent`);
      void supervised.kill(msg.slot).catch(() => undefined);
      // #456: a deliberate kill must not surface a stale diagnostic tail.
      stderrRegistry.drop(msg.slot);
      oomEvidence.drop(msg.slot);
      slotConfigs.delete(msg.slot);
      slotInputRewriters.delete(msg.slot);
      probes.close(msg.slot);
    } else if (msg.type === "cmd") {
      handleCmd(msg);
    }
  }

  function drain() {
    if (draining) return;
    draining = true;

    const IDLE_SILENCE_MS = 10_000;
    const POLL_INTERVAL_MS = 2_000;
    const HARD_TIMEOUT_MS = 5 * 60 * 1_000;
    const deadline = Date.now() + HARD_TIMEOUT_MS;

    let polling = false;
    const poll = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      const now = Date.now();
      if (now >= deadline) {
        clearInterval(timer);
        console.error("[bridge] Drain hard timeout reached — forcing exit for restart");
        process.exit(0);
      }
      const listed = await supervised.listSlots().catch(() => undefined);
      const live = listed?.health.filter((entry) => entry.alive) ?? [];
      if (live.length === 0) {
        clearInterval(timer);
        console.error("[bridge] Drain complete — exiting for restart");
        process.exit(0);
      }
      const allIdle = live.every((entry) => (entry.lastStdoutMsAgo ?? Number.POSITIVE_INFINITY) >= IDLE_SILENCE_MS);
      if (allIdle) {
        clearInterval(timer);
        console.error("[bridge] Drain complete — exiting for restart");
        process.exit(0);
      }
      const remaining = live.filter((entry) => (entry.lastStdoutMsAgo ?? Number.POSITIVE_INFINITY) < IDLE_SILENCE_MS);
      console.error(`[bridge] Draining — ${remaining.length} slot(s) still active`);
      polling = false;
    };
    const timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    void poll();
  }

  return { setWs, handleMessage, drain };
}

async function sweepAgyHomesAtBridgeStartup(): Promise<void> {
  // #493: sweep before adapters can admit a session. The sweep is bounded and
  // fail-open: residue may remain, but it cannot make this host unavailable.
  const result = await sweepAgyMcpHomes();
  if (result.removedHomes > 0) {
    console.error(`[bridge] Removed ${result.removedHomes} orphaned AGY session HOME(s)`);
  }
  if (result.bounded || result.failedHomes > 0) {
    console.error("[bridge] AGY session HOME sweep incomplete; residue retained for a later boot");
  }
}

async function runClientMode(
  wsUrl: string,
  token: string,
  copilotCmd: string,
  localCwd: string,
  bridgeOpts: { bridgeId: string; devMode: boolean; workspaceRoot: string }
) {
  const { WebSocket } = await loadWs();
  await sweepAgyHomesAtBridgeStartup();
  const { adapters, adapterRefusals } = loadHostAdapterInventory(copilotCmd, { cwd: localCwd });
  const releaseReceipt = await createReleaseReceiptWriter({ bridgeId: bridgeOpts.bridgeId, instanceId: BRIDGE_INSTANCE_ID, protocolVersion: PROTOCOL_VERSION, adapterRefusals });
  const releaseSha = await readRunningReleaseSha();
  const sessiond = await connectSessiond();
  const mgr = await makeSlotManager({
    copilotCmd,
    localCwd,
    workspaceRoot: bridgeOpts.workspaceRoot,
    WebSocket,
    bridgeId: bridgeOpts.bridgeId,
    devMode: bridgeOpts.devMode,
    adapters,
    releaseReceipt,
    releaseSha,
    sessiond,
  });
  activeMgr = mgr;

  function connect() {
    console.error(`[bridge] Connecting to ${wsUrl} ...`);
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // #427: the ping is no longer blind. Any inbound traffic counts as an
    // answer, not just a pong — a busy connection proves itself by carrying
    // messages, and demanding a pong specifically would terminate a socket that
    // is plainly working. Declared out here so the `message` handler below can
    // feed it too.
    let lastPeerAt = Date.now();
    const sawPeer = (): void => { lastPeerAt = Date.now(); };
    ws.on("pong", sawPeer);
    ws.on("ping", sawPeer);

    ws.on("open", () => {
      console.error("[bridge] Connected.");
      mgr.setWs(ws);
      sawPeer();

      const keepalive = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPeerAt >= KEEPALIVE_PONG_TIMEOUT_MS) {
          console.error(
            `[bridge] No response for ${KEEPALIVE_PONG_TIMEOUT_MS / 1000}s; terminating dead socket.`
          );
          // terminate(), not close(): a half-open peer never answers a close
          // handshake. This forces the local `close` event that the reconnect
          // below is already waiting for.
          ws.terminate();
          return;
        }
        ws.ping();
      }, KEEPALIVE_PING_MS);
      ws.once("close", () => clearInterval(keepalive));
    });

    ws.on("message", (raw) => {
      sawPeer();
      mgr.handleMessage(raw);
    });

    ws.on("close", (code, reason) => {
      mgr.setWs(null);
      console.error(`[bridge] Disconnected (code=${code}, reason=${reason || "(none)"})`);
      if (code !== 4001) {
        console.error(`[bridge] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
        setTimeout(connect, RECONNECT_DELAY_MS);
      } else {
        console.error("[bridge] Authentication failed — check your token.");
        process.exit(1);
      }
    });

    ws.on("error", (err) => {
      console.error(`[bridge] WebSocket error: ${err.message}`);
    });
  }

  connect();
}

async function runServerMode(
  port: number,
  token: string,
  copilotCmd: string,
  localCwd: string,
  bridgeOpts: { bridgeId: string; devMode: boolean; workspaceRoot: string }
) {
  const { WebSocket, WebSocketServer } = await loadWs();
  // Server mode is a separate bridge startup path and owns the same temp root.
  await sweepAgyHomesAtBridgeStartup();
  const { adapters, adapterRefusals } = loadHostAdapterInventory(copilotCmd, { cwd: localCwd });
  const releaseReceipt = await createReleaseReceiptWriter({ bridgeId: bridgeOpts.bridgeId, instanceId: BRIDGE_INSTANCE_ID, protocolVersion: PROTOCOL_VERSION, adapterRefusals });
  const releaseSha = await readRunningReleaseSha();
  const sessiond = await connectSessiond();
  const mgr = await makeSlotManager({
    copilotCmd,
    localCwd,
    workspaceRoot: bridgeOpts.workspaceRoot,
    WebSocket,
    bridgeId: bridgeOpts.bridgeId,
    devMode: bridgeOpts.devMode,
    adapters,
    releaseReceipt,
    releaseSha,
    sessiond,
  });
  activeMgr = mgr;

  const wss = new WebSocketServer({ port });

  wss.on("listening", () => {
    console.error(`[bridge] Listening on ws://localhost:${port}`);
    console.error(`[bridge] Expose with: cloudflared tunnel --url ws://localhost:${port}`);
  });

  wss.on("connection", (ws: WsSocket, req: IncomingMessage) => {
    const auth = req.headers["authorization"];
    if (!auth || auth !== `Bearer ${token}`) {
      console.error("[bridge] Rejected connection: bad token");
      ws.close(4001, "unauthorized");
      return;
    }
    console.error("[bridge] seam-acp connected.");
    mgr.setWs(ws);

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, KEEPALIVE_PING_MS);
    ws.once("close", () => clearInterval(keepalive));

    ws.on("message", (raw) => mgr.handleMessage(raw));

    ws.on("close", () => {
      mgr.setWs(null);
      console.error("[bridge] seam-acp disconnected.");
    });
  });

  wss.on("error", (err) => {
    console.error(`[bridge] Server error: ${err.message}`);
    process.exit(1);
  });
}

// ─── Argument parsing ────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

/** Extract a named flag + its value from rawArgs in-place. Returns value or null. */
function extractFlag(flag: string): string | null {
  const idx = rawArgs.indexOf(flag);
  if (idx === -1) return null;
  const val = rawArgs[idx + 1];
  if (!val || val.startsWith("-")) {
    console.error(`Error: ${flag} requires a value argument`);
    process.exit(1);
  }
  rawArgs.splice(idx, 2);
  return val;
}

function extractBoolFlag(flag: string): boolean {
  const idx = rawArgs.indexOf(flag);
  if (idx === -1) return false;
  rawArgs.splice(idx, 1);
  return true;
}

// Extract all named flags before touching positional args.
const cwdArg = extractFlag("--cwd");
const gistArg = extractFlag("--gist");
const idArg = extractFlag("--id") ?? extractFlag("--bridge-id");
const serverFlag = extractFlag("--server");
const tokenFlag = extractFlag("--token");
const tokenFileFlag = extractFlag("--token-file");
const singletonSocket = extractFlag("--singleton-socket");
const devFlag = extractBoolFlag("--dev") || process.env.SEAM_BRIDGE_DEV === "1";

const localCwd = cwdArg ? cwdArg.replace(/^~/, homedir()) : process.cwd();
const workspaceRoot = localCwd;
const bridgeId = idArg ?? "bridge";
const bridgeOpts = { bridgeId, devMode: devFlag, workspaceRoot };

console.error(`[bridge] Local cwd: ${localCwd}`);
if (devFlag) {
  console.error("[bridge] Dev mode ON — exec/shell/tailLog/writeFile RPC handlers registered");
}

/**
 * Resolve a WebSocket URL from a GitHub Gist.
 * Accepts "owner/gistId" and fetches the raw content directly from
 * gist.githubusercontent.com — no API call, no rate limits.
 */
async function resolveUrlFromGist(ownerAndId: string) {
  const parts = ownerAndId.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    console.error(`[bridge] --gist must be in "owner/gistId" format, got: ${ownerAndId}`);
    process.exit(1);
  }
  const [owner, gistId] = parts;
  const rawUrl = `https://gist.githubusercontent.com/${owner}/${gistId}/raw/tunnel-url.txt`;
  console.error(`[bridge] Fetching tunnel URL from gist …`);
  const res = await fetch(rawUrl, { headers: { "User-Agent": "seam-acp-bridge" } });
  if (!res.ok) {
    console.error(`[bridge] Failed to fetch gist content: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const url = (await res.text()).trim();
  if (!url.startsWith("wss://")) {
    console.error(`[bridge] Unexpected URL in gist: ${url}`);
    process.exit(1);
  }
  console.error(`[bridge] Resolved tunnel URL: ${url}`);
  return url;
}

// Set by runClientMode / runServerMode so the signal handler can reach the mgr.
let activeMgr: SlotManager | null = null;

process.on("SIGUSR2", () => {
  console.error("[bridge] SIGUSR2 received — entering drain mode");
  if (activeMgr) {
    activeMgr.drain();
  } else {
    console.error("[bridge] No active slot manager — exiting immediately");
    process.exit(0);
  }
});

function usageAndExit(): never {
  console.error("Usage: seam-bridge connect --server <wss-url> --id <bridgeId> (--token <token> | --token-file <path>) [--cwd <path>] [--dev]");
  console.error("       seam-bridge --server <port> --token <token> [--id <bridgeId>] [--cwd <path>] [--dev] [copilot-cmd]");
  console.error("       seam-bridge [--gist <owner/gistId>] <ws-url> <token> [--id <bridgeId>] [--cwd <path>] [--dev]");
  process.exit(1);
}

async function main(): Promise<void> {
  if (singletonSocket && !(await acquireProcessLease(singletonSocket))) {
    console.error("[bridge] Another bridge process owns this singleton; exiting.");
    return;
  }
  const tokenFromFile = tokenFileFlag ? (await fsp.readFile(tokenFileFlag, "utf8")).trim() : undefined;
  if (tokenFileFlag && !tokenFromFile) throw new Error("bridge token file is empty");
  if (rawArgs[0] === "connect") {
    rawArgs.shift();
    const wsUrl = serverFlag ?? rawArgs[0];
    const token = tokenFlag ?? tokenFromFile ?? process.env.SEAM_BRIDGE_TOKEN ?? rawArgs[1];
    const copilotCmd = process.env.COPILOT_CMD ?? "copilot";
    if (!wsUrl || !token) usageAndExit();
    runClientMode(wsUrl, token, copilotCmd, localCwd, bridgeOpts);
  } else if (rawArgs[0] === "--server" || serverFlag) {
    const port = Number(rawArgs[0] === "--server" ? rawArgs[1] : serverFlag);
    const token = tokenFlag ?? tokenFromFile ?? process.env.SEAM_BRIDGE_TOKEN ?? (rawArgs[0] === "--server" ? rawArgs[2] : rawArgs[0]);
    const copilotCmd = process.env.COPILOT_CMD ?? (rawArgs[0] === "--server" ? rawArgs[3] : rawArgs[1]) ?? "copilot";
    if (!port || !token) usageAndExit();
    runServerMode(port, token, copilotCmd, localCwd, bridgeOpts);
  } else {
    // wsUrl may come from --gist flag or as a positional arg.
    const wsUrlPositional = rawArgs[0];
    const token = tokenFlag ?? tokenFromFile ?? process.env.SEAM_BRIDGE_TOKEN ?? rawArgs[1];
    const copilotCmd = process.env.COPILOT_CMD ?? rawArgs[2] ?? "copilot";

    if (!token && !gistArg) usageAndExit();

    if (gistArg) {
      const tokenFromArg = tokenFlag ?? tokenFromFile ?? process.env.SEAM_BRIDGE_TOKEN ?? rawArgs[0];
      const copilotCmdFromArg = process.env.COPILOT_CMD ?? rawArgs[1] ?? "copilot";
      if (!tokenFromArg) usageAndExit();
      resolveUrlFromGist(gistArg).then((wsUrl) => {
        runClientMode(wsUrl, tokenFromArg, copilotCmdFromArg, localCwd, bridgeOpts);
      });
    } else {
      if (!wsUrlPositional || !token) usageAndExit();
      runClientMode(wsUrlPositional, token, copilotCmd, localCwd, bridgeOpts);
    }
  }
}

void main().catch((error) => {
  console.error(`[bridge] Startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
