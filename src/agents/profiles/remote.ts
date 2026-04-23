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
 * How long spawn() will wait for a connection before emitting an error (just
 * under AgentRuntime's 45 s START_TIMEOUT_MS so errors are actionable).
 */
const CONNECT_TIMEOUT_MS = 44_000;

/** How often to ping idle pending connections to detect stale ones. */
const PENDING_PING_INTERVAL_MS = 30_000;

/** How often to ping active (attached) connections to keep tunnels alive. */
const ACTIVE_PING_INTERVAL_MS = 25_000;

type Connector = (ws: WebSocket) => void;

type FakeProcess = EventEmitter & {
  stdin: NodeWritable;
  stdout: NodeReadable;
  stderr: NodeReadable;
  readonly killed: boolean;
  kill(): void;
};

/**
 * Builds and returns a fake ChildProcess object backed by PassThrough streams.
 * The caller provides an `attach` function that will be called once a WebSocket
 * connection is available. Returns both the fake process and the attach callback
 * so callers can store the callback for deferred use (server mode) or call it
 * immediately (client mode).
 */
/** Grace period to wait for a bridge reconnect before declaring the process dead. */
const RECONNECT_GRACE_MS = 20_000;

function makeFakeProcess(opts: {
  id: string;
  onKill?: () => void;
  /** Called when the WS closes abnormally — caller decides whether to re-attach or let the process die. */
  onWsSuspended?: (reattach: Connector) => void;
}): { fake: FakeProcess; attach: Connector } {
  const stdinPT = new PassThrough();
  const stdoutPT = new PassThrough();
  const stderrPT = new PassThrough();
  const emitter = new EventEmitter();

  let killed = false;
  let attachedWs: WebSocket | undefined;

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
      opts.onKill?.();
      if (attachedWs && attachedWs.readyState === WebSocket.OPEN) {
        attachedWs.close(1000, "disposed");
      }
      stdinPT.destroy();
      stdoutPT.push(null);
    },
  }) as FakeProcess;

  const attach: Connector = (ws: WebSocket) => {
    if (killed) {
      ws.close(1000, "runtime already disposed");
      return;
    }
    attachedWs = ws;

    // Keep the active connection alive through tunnels/proxies.
    const keepalive = setInterval(() => {
      if (attachedWs === ws && ws.readyState === WebSocket.OPEN) ws.ping();
    }, ACTIVE_PING_INTERVAL_MS);

    // Guard stdin forwarder to only send to the currently attached WS.
    const stdinForwarder = (chunk: Buffer) => {
      if (attachedWs === ws && ws.readyState === WebSocket.OPEN) ws.send(chunk);
    };
    stdinPT.on("data", stdinForwarder);
    stdinPT.once("end", () => {
      if (attachedWs === ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "stdin ended");
    });

    ws.on("message", (data) => {
      if (!killed && attachedWs === ws) {
        const buf =
          data instanceof Buffer
            ? data
            : Buffer.from(data as unknown as ArrayBuffer);
        stdoutPT.push(buf);
      }
    });

    ws.on("error", () => {
      if (!killed && attachedWs === ws) {
        clearInterval(keepalive);
        stdinPT.off("data", stdinForwarder);
        if (opts.onWsSuspended) {
          opts.onWsSuspended(attach);
        } else {
          stdoutPT.push(null);
          fake.emit("exit", 1, null);
        }
      }
    });

    ws.on("close", (code) => {
      if (!killed && attachedWs === ws) {
        clearInterval(keepalive);
        stdinPT.off("data", stdinForwarder);
        if (code === 1000) {
          // Clean close — terminate normally.
          stdoutPT.push(null);
          fake.emit("exit", 0, null);
        } else if (opts.onWsSuspended) {
          // Abnormal close — give the bridge a chance to reconnect.
          opts.onWsSuspended(attach);
        } else {
          stdoutPT.push(null);
          fake.emit("exit", 1, null);
        }
      }
    });
  };

  return { fake, attach };
}

function remoteDisplayName(id: string): string {
  return `GitHub Copilot (Remote: ${id.replace(/^copilot-remote-/, "")})`;
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
  const pendingConnections: WebSocket[] = [];
  const waiters: Array<{ connect: Connector; timeout: ReturnType<typeof setTimeout> }> = [];

  // Suspended sessions: bridge disconnected abnormally, waiting to reconnect.
  const suspendedSessions: Array<{
    reattach: Connector;
    expireTimeout: ReturnType<typeof setTimeout>;
    fake: FakeProcess;
  }> = [];

  const wss = new WebSocketServer({ port: opts.wsPort });

  // Heartbeat: prune stale idle connections from the pending pool.
  const pingInterval = setInterval(() => {
    for (let i = pendingConnections.length - 1; i >= 0; i--) {
      const ws = pendingConnections[i];
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        pendingConnections.splice(i, 1);
      } else {
        ws.ping();
      }
    }
  }, PENDING_PING_INTERVAL_MS);
  pingInterval.unref();

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const auth = req.headers["authorization"];
    if (!auth || auth !== `Bearer ${opts.token}`) {
      ws.close(4001, "unauthorized");
      return;
    }

    // Prefer re-attaching to a suspended session over creating a new one.
    if (suspendedSessions.length > 0) {
      const session = suspendedSessions.shift()!;
      clearTimeout(session.expireTimeout);
      session.reattach(ws);
      return;
    }

    if (waiters.length > 0) {
      const { connect, timeout } = waiters.shift()!;
      clearTimeout(timeout);
      connect(ws);
    } else {
      pendingConnections.push(ws);
      ws.once("close", () => {
        const i = pendingConnections.indexOf(ws);
        if (i >= 0) pendingConnections.splice(i, 1);
      });
    }
  });

  return {
    id: opts.id,
    displayName: opts.displayName ?? remoteDisplayName(opts.id),
    defaultModel: opts.defaultModel,

    spawn(): ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable> {
      let suspendedEntry: typeof suspendedSessions[number] | undefined;

      const { fake, attach } = makeFakeProcess({
        id: opts.id,
        onKill() {
          // Remove from waiters if still waiting for a connection.
          const idx = waiters.findIndex((w) => w.connect === attach);
          if (idx >= 0) {
            const entry = waiters[idx];
            if (entry) clearTimeout(entry.timeout);
            waiters.splice(idx, 1);
          }
          // Remove from suspended sessions if suspended.
          if (suspendedEntry) {
            const si = suspendedSessions.indexOf(suspendedEntry);
            if (si >= 0) {
              clearTimeout(suspendedEntry.expireTimeout);
              suspendedSessions.splice(si, 1);
            }
          }
        },
        onWsSuspended(reattach) {
          // Abnormal disconnect — hold the fake process alive briefly.
          const expireTimeout = setTimeout(() => {
            const si = suspendedSessions.indexOf(suspendedEntry!);
            if (si >= 0) suspendedSessions.splice(si, 1);
            if (!fake.killed) {
              fake.emit("exit", 1, null);
            }
          }, RECONNECT_GRACE_MS);
          if (typeof expireTimeout.unref === "function") expireTimeout.unref();
          suspendedEntry = { reattach, expireTimeout, fake };
          suspendedSessions.push(suspendedEntry);
        },
      });

      const available = pendingConnections.shift();
      if (available) {
        attach(available);
      } else {
        const timeout = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.connect === attach);
          if (idx >= 0) waiters.splice(idx, 1);
          if (!fake.killed) {
            fake.emit(
              "error",
              new Error(
                `Remote agent '${opts.id}' did not connect within ` +
                  `${CONNECT_TIMEOUT_MS / 1000}s. ` +
                  `Ensure the bridge script is running and pointed at this server.`
              )
            );
          }
        }, CONNECT_TIMEOUT_MS);
        if (typeof timeout.unref === "function") timeout.unref();
        waiters.push({ connect: attach, timeout });
      }

      return fake as unknown as ChildProcessByStdio<
        NodeWritable,
        NodeReadable,
        NodeReadable
      >;
    },

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
  return {
    id: opts.id,
    displayName: opts.displayName ?? remoteDisplayName(opts.id),
    defaultModel: opts.defaultModel,

    spawn(): ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable> {
      let connected = false;

      const { fake, attach } = makeFakeProcess({
        id: opts.id,
        onKill() {
          ws.terminate();
        },
      });

      const ws = new WebSocket(opts.wsUrl, {
        headers: { Authorization: `Bearer ${opts.token}` },
      });

      ws.on("open", () => {
        connected = true;
        attach(ws);
      });

      ws.on("error", (err) => {
        if (!fake.killed) {
          if (!connected) {
            // Pre-connect failure: surface as spawn error so AgentRuntime's
            // errorWaiter catches it.
            fake.emit(
              "error",
              new Error(
                `Remote agent '${opts.id}' connection failed: ${err.message}`
              )
            );
          }
          // Post-connect errors are handled by the attach() ws.on("error")
          // listener which translates them to "exit".
        }
      });

      return fake as unknown as ChildProcessByStdio<
        NodeWritable,
        NodeReadable,
        NodeReadable
      >;
    },

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
