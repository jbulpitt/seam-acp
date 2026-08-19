/**
 * Resilient multiplexed transport over a shared WebSocket.
 * Kept for PR2 extraction; copilot-remote profiles were removed in PR0.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessByStdio } from "node:child_process";
import type {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from "node:stream";
import { WebSocket } from "ws";

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
  type: "data" | "kill" | "exit" | "cmd" | "cmd_reply";
  data?: string;
  code?: number;
  cmdId?: string;
  action?: string;
  payload?: any;
  error?: string;
}

interface SlotEntry {
  stdout: PassThrough;
  fake: FakeProcess;
  /** ACP chunks buffered while the bridge is offline. */
  stdinQueue: string[];
  killed: boolean;
}

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
 * - `spawn()` — allocates a slot and returns a fake ChildProcess; stdin/stdout
 *   are routed through the shared WS with slot-tagged envelopes.
 *
 * When the bridge is offline, stdin data is queued and flushed on reconnect.
 * Fake processes survive bridge reconnects transparently.
 */
export function makeMux(opts: { id: string; onBridgeConnect?: () => void }) {
  let bridgeWs: WebSocket | null = null;
  let lastBridgeInstanceId: string | undefined;
  let nextSlot = 0;
  const slots = new Map<number, SlotEntry>();
  /** Timeout handles for spawn() calls waiting for the bridge to come online. */
  const bridgeWaiters: Array<{ slot: number; timeout: ReturnType<typeof setTimeout> }> = [];
  const pendingCmds = new Map<string, { resolve: (val: any) => void; reject: (err: Error) => void }>();

  function send(msg: MuxMsg) {
    if (bridgeWs?.readyState === WebSocket.OPEN) {
      bridgeWs.send(JSON.stringify(msg));
    }
  }

  function flushQueues() {
    for (const [slot, entry] of slots) {
      if (!entry.killed && entry.stdinQueue.length > 0) {
        for (const text of entry.stdinQueue.splice(0)) {
          send({ slot, type: "data", data: text });
        }
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

      // Bridge announces its instance ID on every connect. If it changed, the
      // bridge process restarted and all its agent slots are gone — emit exit
      // events so runtimes are evicted and re-initialized on next message.
      if ((msg as any).type === "bridge_hello") {
        const newId = (msg as any).instanceId as string | undefined;
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
      if (bridgeWs === newWs) bridgeWs = null;
    });

    newWs.on("error", () => {
      if (bridgeWs === newWs) bridgeWs = null;
    });
  }

  function spawn(): ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable> {
    const slot = nextSlot++;
    const stdinPT = new PassThrough();
    const stdoutPT = new PassThrough();
    const stderrPT = new PassThrough();
    const emitter = new EventEmitter();
    const stdinQueue: string[] = [];
    let killed = false;

    const fake = Object.assign(emitter, {
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
    }) as FakeProcess;

    slots.set(slot, { stdout: stdoutPT, fake, stdinQueue, killed: false });

    stdinPT.on("data", (chunk: Buffer) => {
      if (killed) return;
      const text = chunk.toString("utf8");
      if (bridgeWs?.readyState === WebSocket.OPEN) {
        // Flush any previously buffered data first.
        for (const queued of stdinQueue.splice(0)) {
          send({ slot, type: "data", data: queued });
        }
        send({ slot, type: "data", data: text });
      } else {
        stdinQueue.push(text);
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

    return fake as unknown as ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable>;
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

  return { attach, spawn, sendCmd };
}
