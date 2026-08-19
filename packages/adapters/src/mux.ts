/**
 * Resilient multiplexed transport over a shared WebSocket.
 * Extracted into @seam/adapters (PR2); copilot-remote profiles were removed in PR0.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessByStdio } from "node:child_process";
import type {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from "node:stream";
import { WebSocket } from "ws";
import type { EventFrame, HelloFrame, RpcReplyFrame } from "./command-bus.js";
import { PROTOCOL_VERSION } from "./command-bus.js";

/**
 * How long spawn() will wait for a bridge connection before emitting an error
 * (just under AgentRuntime's 45 s START_TIMEOUT_MS so errors are actionable).
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** How often to ping the bridge WS to keep tunnels/proxies alive. */
const ACTIVE_PING_INTERVAL_MS = 25_000;

// ---------------------------------------------------------------------------
// Multiplexed message protocol
// ---------------------------------------------------------------------------
// Every WS message in both directions is a JSON object:
//   { slot: number, type: "data" | "kill" | "exit", data?: string, code?: number }
//
//   "data"  — ACP payload (UTF-8 text)
//   "kill"  — seam-acp → bridge: terminate the agent for this slot
//   "exit"  — bridge → seam-acp: agent exited (with exit code)
//
// This lets a single WS connection serve multiple concurrent sessions.

interface MuxMsg {
  slot?: number;
  type:
    | "data"
    | "kill"
    | "exit"
    | "cmd"
    | "cmd_reply"
    | "hello"
    | "hello_ack"
    | "rpc"
    | "rpc_reply"
    | "event"
    | "ping"
    | "pong"
    | "bridge_hello";
  data?: string;
  code?: number;
  cmdId?: string;
  action?: string;
  payload?: any;
  error?: string;
  v?: number;
  id?: string;
  agentId?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  ok?: boolean;
  instanceId?: string;
  bridgeId?: string;
  protocolVersion?: number;
  name?: string;
}

interface SlotEntry {
  stdout: PassThrough;
  fake: FakeProcess;
  /** ACP chunks buffered while the bridge is offline or waiting for rpc spawn. */
  stdinQueue: string[];
  killed: boolean;
  /** When true, queue stdin even if the WS is open (rpc spawn not yet acked). */
  holdStdin: boolean;
}

/** Optional mux.spawn() argument. Local `profile.spawn(model?, effort?)` is unchanged. */
export interface MuxSpawnOpts {
  /**
   * Queue stdin (even on an open WS) until `releaseStdin(slot)`. Used so
   * `rpc("spawn", …)` can fill `slotConfigs` before the first ACP `data` frame.
   */
  holdStdinUntilReady?: boolean;
}

/** Fake child returned by `mux.spawn()`. `slot` is the mux slot id. */
export type MuxChild = ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable> & {
  readonly slot: number;
};

type FakeProcess = EventEmitter & {
  stdin: NodeWritable;
  stdout: NodeReadable;
  stderr: NodeReadable;
  readonly killed: boolean;
  kill(): void;
};

// ---------------------------------------------------------------------------
// Shared mux logic
// ---------------------------------------------------------------------------

/**
 * Creates a multiplexed session manager over a shared WebSocket.
 *
 * - `attach(ws)` — called whenever a new bridge WS arrives; replaces the old one.
 * - `spawn(opts?)` — allocates a slot and returns a fake ChildProcess with
 *   `.slot`; stdin/stdout are routed through the shared WS. Pass
 *   `{ holdStdinUntilReady: true }` to queue stdin until `releaseStdin(slot)`
 *   so `rpc("spawn")` can configure the slot before the first `data` frame.
 *
 * When the bridge is offline, stdin data is queued and flushed on reconnect.
 * Fake processes survive bridge reconnects transparently.
 */
export function makeMux(opts: {
  id: string;
  onBridgeConnect?: () => void;
  onHello?: (hello: HelloFrame) => void;
  onEvent?: (event: EventFrame) => void;
  onDisconnect?: () => void;
}) {
  let bridgeWs: WebSocket | null = null;
  let lastBridgeInstanceId: string | undefined;
  let nextSlot = 0;
  const slots = new Map<number, SlotEntry>();
  /** Timeout handles for spawn() calls waiting for the bridge to come online. */
  const bridgeWaiters: Array<{ slot: number; timeout: ReturnType<typeof setTimeout> }> = [];
  const pendingCmds = new Map<string, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  const pendingRpcs = new Map<string, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();

  function send(msg: MuxMsg) {
    if (bridgeWs?.readyState === WebSocket.OPEN) {
      bridgeWs.send(JSON.stringify(msg));
    }
  }

  function flushQueues() {
    for (const [slot, entry] of slots) {
      if (!entry.killed && !entry.holdStdin && entry.stdinQueue.length > 0) {
        for (const text of entry.stdinQueue.splice(0)) {
          send({ slot, type: "data", data: text });
        }
      }
    }
  }

  function releaseStdin(slot: number): void {
    const entry = slots.get(slot);
    if (!entry) return;
    entry.holdStdin = false;
    if (entry.killed) return;
    if (bridgeWs?.readyState === WebSocket.OPEN && entry.stdinQueue.length > 0) {
      for (const text of entry.stdinQueue.splice(0)) {
        send({ slot, type: "data", data: text });
      }
    }
  }

  function attach(newWs: WebSocket) {
    // Replace the old bridge connection.
    if (bridgeWs && bridgeWs !== newWs && bridgeWs.readyState === WebSocket.OPEN) {
      bridgeWs.close(1001, "replaced by new bridge connection");
    }
    bridgeWs = newWs;

    // Notify listener that a fresh bridge connection arrived.
    opts.onBridgeConnect?.();

    // All pending spawn() calls can now proceed.
    for (const { timeout } of bridgeWaiters.splice(0)) {
      clearTimeout(timeout);
    }

    // Send any stdin that arrived while the bridge was offline.
    flushQueues();

    newWs.on("message", (raw) => {
      let msg: MuxMsg;
      try {
        msg = JSON.parse(raw.toString()) as MuxMsg;
      } catch {
        return;
      }

      // Bridge announces its instance ID on every connect (`hello` is the
      // typed bus frame; `bridge_hello` remains accepted for the slot-mux
      // eviction path). If it changed, the bridge process restarted and all
      // its agent slots are gone — emit exit events so runtimes are evicted.
      if (msg.type === "hello" || msg.type === "bridge_hello") {
        const newId = msg.instanceId;
        const isNewInstance = !!(newId && lastBridgeInstanceId && newId !== lastBridgeInstanceId);

        if (isNewInstance) {
          for (const [slot, entry] of slots) {
            if (!entry.killed) {
              // Tell the new bridge process to kill any agent it spawned for
              // this slot (flushQueues may have already sent stdin to it).
              send({ slot, type: "kill" });
              entry.killed = true;
              entry.stdout.push(null);
              entry.fake.emit("exit", 1, null);
            }
          }
          slots.clear();
        }
        lastBridgeInstanceId = newId;

        // For same-instance reconnects (WS drop/reconnect without bridge restart),
        // probe which slots are still live. Any seam-acp slot the bridge no longer
        // knows about had its turn complete (or was lost) while the WS was down —
        // evict it immediately so the turn fails fast rather than waiting for the
        // turn timeout.
        if (!isNewInstance && slots.size > 0) {
          void sendCmd("listSlots", {}).then((reply: { slots: number[] }) => {
            const liveOnBridge = new Set<number>(reply.slots);
            for (const [slot, entry] of [...slots]) {
              if (!entry.killed && !liveOnBridge.has(slot)) {
                send({ slot, type: "kill" });
                entry.killed = true;
                entry.stdout.push(null);
                entry.fake.emit("exit", 1, null);
                slots.delete(slot);
              }
            }
          }).catch(() => { /* bridge may not support listSlots — ignore */ });
        }

        if (msg.type === "hello") {
          opts.onHello?.(msg as unknown as HelloFrame);
        }
        return;
      }

      if (msg.type === "rpc_reply" && msg.id) {
        const handler = pendingRpcs.get(msg.id);
        if (handler) {
          pendingRpcs.delete(msg.id);
          const reply = msg as unknown as RpcReplyFrame;
          if (!reply.ok || reply.error) {
            handler.reject(new Error(reply.error ?? "rpc failed"));
          } else {
            handler.resolve(reply.result);
          }
        }
        return;
      }

      if (msg.type === "event") {
        opts.onEvent?.(msg as unknown as EventFrame);
        return;
      }

      if (msg.type === "pong" || msg.type === "ping") {
        if (msg.type === "ping") {
          send({ type: "pong", v: PROTOCOL_VERSION } as MuxMsg);
        }
        return;
      }

      if (msg.type === "cmd_reply" && msg.cmdId) {
        const handler = pendingCmds.get(msg.cmdId);
        if (handler) {
          pendingCmds.delete(msg.cmdId);
          if (msg.error) {
            handler.reject(new Error(msg.error));
          } else {
            handler.resolve(msg.payload);
          }
        }
        return;
      }

      if (msg.slot === undefined) return;
      const entry = slots.get(msg.slot);
      if (!entry || entry.killed) return;

      if (msg.type === "data" && msg.data !== undefined) {
        entry.stdout.push(msg.data);
      } else if (msg.type === "exit") {
        entry.killed = true;
        slots.delete(msg.slot);
        entry.stdout.push(null);
        entry.fake.emit("exit", msg.code ?? 1, null);
      }
    });

    newWs.on("close", () => {
      if (bridgeWs === newWs) {
        bridgeWs = null;
        opts.onDisconnect?.();
      }
    });

    newWs.on("error", () => {
      if (bridgeWs === newWs) {
        bridgeWs = null;
        opts.onDisconnect?.();
      }
    });
  }

  function spawn(spawnOpts?: MuxSpawnOpts): MuxChild {
    const slot = nextSlot++;
    const stdinPT = new PassThrough();
    const stdoutPT = new PassThrough();
    const stderrPT = new PassThrough();
    const emitter = new EventEmitter();
    const stdinQueue: string[] = [];
    let killed = false;

    const fake = Object.assign(emitter, {
      slot,
      stdin: stdinPT as NodeWritable,
      stdout: stdoutPT as NodeReadable,
      stderr: stderrPT as NodeReadable,
      get killed() {
        return killed;
      },
      kill() {
        if (killed) return;
        killed = true;
        const entry = slots.get(slot);
        if (entry) entry.killed = true;
        slots.delete(slot);
        send({ slot, type: "kill" });
        stdinPT.destroy();
        stdoutPT.push(null);
      },
    }) as FakeProcess & { slot: number };

    slots.set(slot, {
      stdout: stdoutPT,
      fake,
      stdinQueue,
      killed: false,
      holdStdin: spawnOpts?.holdStdinUntilReady === true,
    });

    stdinPT.on("data", (chunk: Buffer) => {
      const entry = slots.get(slot);
      if (!entry || entry.killed) return;
      const text = chunk.toString("utf8");
      if (bridgeWs?.readyState === WebSocket.OPEN && !entry.holdStdin) {
        // Flush any previously buffered data first.
        for (const queued of entry.stdinQueue.splice(0)) {
          send({ slot, type: "data", data: queued });
        }
        send({ slot, type: "data", data: text });
      } else {
        entry.stdinQueue.push(text);
      }
    });

    // If bridge isn't online yet, start a connect timeout.
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      const timeout = setTimeout(() => {
        const idx = bridgeWaiters.findIndex((w) => w.slot === slot);
        if (idx >= 0) bridgeWaiters.splice(idx, 1);
        if (!killed) {
          fake.emit(
            "error",
            new Error(
              `Remote agent '${opts.id}' did not connect within ${CONNECT_TIMEOUT_MS / 1000}s. ` +
                `Ensure the bridge script is running and pointed at this server.`
            )
          );
        }
      }, CONNECT_TIMEOUT_MS);
      if (typeof timeout.unref === "function") timeout.unref();
      bridgeWaiters.push({ slot, timeout });
    }

    return fake as unknown as MuxChild;
  }

  async function sendCmd(action: string, payload: any): Promise<any> {
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      throw new Error(`Remote bridge is offline. Make sure the bridge is running.`);
    }
    const cmdId = Math.random().toString(36).substring(2, 15);
    return new Promise((resolve, reject) => {
      pendingCmds.set(cmdId, { resolve, reject });
      const timeout = setTimeout(() => {
        if (pendingCmds.has(cmdId)) {
          pendingCmds.delete(cmdId);
          reject(new Error(`Command '${action}' timed out after 15s`));
        }
      }, 15000);
      if (typeof timeout.unref === "function") timeout.unref();

      send({ type: "cmd", cmdId, action, payload });
    });
  }

  function sendFrame(msg: Record<string, unknown>): void {
    send(msg as unknown as MuxMsg);
  }

  async function rpc(
    method: string,
    params: unknown,
    optsRpc: { agentId?: string; timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      throw new Error(`Remote bridge is offline. Make sure the bridge is running.`);
    }
    const id = Math.random().toString(36).substring(2, 15);
    const timeoutMs = optsRpc.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      pendingRpcs.set(id, { resolve, reject });
      const timeout = setTimeout(() => {
        if (pendingRpcs.has(id)) {
          pendingRpcs.delete(id);
          reject(new Error(`rpc '${method}' timed out after ${timeoutMs / 1000}s`));
        }
      }, timeoutMs);
      if (typeof timeout.unref === "function") timeout.unref();
      send({
        v: PROTOCOL_VERSION,
        type: "rpc",
        id,
        method,
        params,
        ...(optsRpc.agentId ? { agentId: optsRpc.agentId } : {}),
      } as MuxMsg);
    });
  }

  function helloAck(accepted: boolean, error?: string): void {
    send({
      v: PROTOCOL_VERSION,
      type: "hello_ack",
      protocolVersion: PROTOCOL_VERSION,
      accepted,
      ...(error ? { error } : {}),
    } as MuxMsg);
  }

  function connected(): boolean {
    return !!bridgeWs && bridgeWs.readyState === WebSocket.OPEN;
  }

  return { attach, spawn, sendCmd, rpc, sendFrame, helloAck, connected, releaseStdin };
}
