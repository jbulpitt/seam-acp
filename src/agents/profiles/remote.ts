import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessByStdio } from "node:child_process";
import type {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { AgentIdentity, AgentProfile } from "../agent-profile.js";

/**
 * How long spawn() will wait for a bridge connection before emitting an error
 * (just under AgentRuntime's 45 s START_TIMEOUT_MS so errors are actionable).
 */
const CONNECT_TIMEOUT_MS = 44_000;

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
  slot: number;
  type: "data" | "kill" | "exit";
  data?: string;
  code?: number;
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

function remoteDisplayName(id: string): string {
  return `GitHub Copilot (Remote: ${id.replace(/^copilot-remote-/, "")})`;
}

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
function makeMux(opts: { id: string }) {
  let bridgeWs: WebSocket | null = null;
  let nextSlot = 0;
  const slots = new Map<number, SlotEntry>();
  /** Timeout handles for spawn() calls waiting for the bridge to come online. */
  const bridgeWaiters: Array<{ slot: number; timeout: ReturnType<typeof setTimeout> }> = [];

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

  return { attach, spawn };
}

// ---------------------------------------------------------------------------
// Server mode: seam-acp hosts the WebSocket server; bridge dials in.
// ---------------------------------------------------------------------------

/**
 * Creates an AgentProfile that listens for inbound WebSocket connections from a
 * bridge script running on the remote machine. The remote machine runs
 * `scripts/remote-agent-bridge.mjs <ws-url> <token>` — where `ws-url` points
 * at this server — and pipes `copilot --acp` stdio over the socket.
 *
 * A single WebSocket connection from the bridge carries all concurrent sessions
 * via slot-tagged message envelopes, so multiple Discord threads work in
 * parallel without needing multiple bridge connections.
 *
 * Use this mode when you can expose a port on the seam-acp server (directly or
 * via a Cloudflare Tunnel on the seam-acp side).
 */
export function makeRemoteCopilotServerProfile(opts: {
  id: string;
  displayName?: string;
  /** Local TCP port for the WebSocket server. */
  wsPort: number;
  /** Shared secret — bridge must send `Authorization: Bearer <token>`. */
  token: string;
  defaultModel: string;
}): AgentProfile {
  const mux = makeMux({ id: opts.id });
  const wss = new WebSocketServer({ port: opts.wsPort });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const auth = req.headers["authorization"];
    if (!auth || auth !== `Bearer ${opts.token}`) {
      ws.close(4001, "unauthorized");
      return;
    }

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, ACTIVE_PING_INTERVAL_MS);
    ws.once("close", () => clearInterval(keepalive));

    mux.attach(ws);
  });

  return {
    id: opts.id,
    displayName: opts.displayName ?? remoteDisplayName(opts.id),
    defaultModel: opts.defaultModel,
    spawn: mux.spawn.bind(mux),
    whoami(): Promise<AgentIdentity | null> {
      return Promise.resolve(null);
    },
  };
}

// ---------------------------------------------------------------------------
// Client mode: seam-acp dials out; bridge hosts the WebSocket server.
// ---------------------------------------------------------------------------

/**
 * Creates an AgentProfile that connects outbound as a WebSocket client to a
 * bridge script running on the remote machine. The remote machine runs
 * `scripts/remote-agent-bridge.mjs --server <port> <token>` and exposes it via
 * a Cloudflare Tunnel (or any other means) so seam-acp can reach it.
 *
 * A single outbound WS connection carries all concurrent sessions via
 * slot-tagged message envelopes. Reconnects automatically on disconnect.
 *
 * Use this mode when you prefer to run `cloudflared` on the remote machine
 * rather than on the seam-acp server, and seam-acp has no open inbound ports.
 */
export function makeRemoteCopilotClientProfile(opts: {
  id: string;
  displayName?: string;
  /** WebSocket URL to connect to, e.g. `wss://random.trycloudflare.com`. */
  wsUrl: string;
  /** Shared secret — sent as `Authorization: Bearer <token>`. */
  token: string;
  defaultModel: string;
}): AgentProfile {
  const mux = makeMux({ id: opts.id });

  function connect() {
    const ws = new WebSocket(opts.wsUrl, {
      headers: { Authorization: `Bearer ${opts.token}` },
    });

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, ACTIVE_PING_INTERVAL_MS);
    ws.once("close", () => clearInterval(keepalive));

    ws.on("open", () => {
      mux.attach(ws);
    });

    ws.on("close", (code) => {
      if (code !== 4001) {
        setTimeout(connect, 5_000);
      }
    });

    ws.on("error", () => {
      // close event will fire after error and handle reconnect.
    });
  }

  connect();

  return {
    id: opts.id,
    displayName: opts.displayName ?? remoteDisplayName(opts.id),
    defaultModel: opts.defaultModel,
    spawn: mux.spawn.bind(mux),
    whoami(): Promise<AgentIdentity | null> {
      return Promise.resolve(null);
    },
  };
}

// ---------------------------------------------------------------------------
// Back-compat alias — existing code that calls makeRemoteCopilotProfile keeps
// working; it maps to the server mode.
// ---------------------------------------------------------------------------
export const makeRemoteCopilotProfile = makeRemoteCopilotServerProfile;
