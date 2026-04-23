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
 * How long spawn() will wait for a Mac bridge connection before emitting an
 * error (just under AgentRuntime's 45 s START_TIMEOUT_MS so the error message
 * is actionable rather than a generic "initialize timed out").
 */
const CONNECT_TIMEOUT_MS = 44_000;

/**
 * How often to ping idle pending connections to detect stale ones.
 */
const PENDING_PING_INTERVAL_MS = 30_000;

type Connector = (ws: WebSocket) => void;

/**
 * Creates an AgentProfile whose transport is a remote WebSocket connection
 * rather than a locally spawned process. Intended for cases where the agent
 * CLI (e.g. Copilot) runs on a separate machine that cannot accept inbound
 * connections but CAN make outbound WebSocket connections (e.g. via a
 * Cloudflare Tunnel).
 *
 * One profile = one WebSocket server port. The remote machine runs the
 * bridge script (`scripts/remote-agent-bridge.mjs`) which:
 *   1. Connects outbound to this server.
 *   2. Spawns `copilot --acp` locally.
 *   3. Pipes stdio ↔ WebSocket.
 *
 * Because ACP allows multiple sessions per process, a single bridge
 * connection can serve multiple concurrent Discord sessions. If a second
 * spawn() is requested while a bridge connection is already claimed, it
 * will wait up to CONNECT_TIMEOUT_MS for another bridge connection.
 */
export function makeRemoteCopilotProfile(opts: {
  /** Unique profile id; will be prefixed `copilot-remote-` in the router. */
  id: string;
  displayName?: string;
  /** Local TCP port for the WebSocket server. */
  wsPort: number;
  /** Shared secret — bridge must send `Authorization: Bearer <token>`. */
  token: string;
  defaultModel: string;
}): AgentProfile {
  const pendingConnections: WebSocket[] = [];
  const waiters: Connector[] = [];

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

    if (waiters.length > 0) {
      // A runtime is already waiting — hand off immediately.
      const waiter = waiters.shift()!;
      waiter(ws);
    } else {
      // Park the connection until a runtime needs it.
      pendingConnections.push(ws);
      ws.once("close", () => {
        const i = pendingConnections.indexOf(ws);
        if (i >= 0) pendingConnections.splice(i, 1);
      });
    }
  });

  return {
    id: opts.id,
    displayName:
      opts.displayName ?? `GitHub Copilot (Remote: ${opts.id.replace(/^copilot-remote-/, "")})`,
    defaultModel: opts.defaultModel,

    spawn(): ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable> {
      const stdinPT = new PassThrough();
      const stdoutPT = new PassThrough();
      const stderrPT = new PassThrough();
      const emitter = new EventEmitter();

      let killed = false;
      let attachedWs: WebSocket | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

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
          // Dequeue from waiters if we haven't connected yet.
          const idx = waiters.indexOf(connect);
          if (idx >= 0) waiters.splice(idx, 1);
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
          }
          if (attachedWs && attachedWs.readyState === WebSocket.OPEN) {
            attachedWs.close(1000, "disposed");
          }
          stdinPT.destroy();
          stdoutPT.push(null);
        },
      });

      const connect: Connector = (ws: WebSocket) => {
        if (killed) {
          // Runtime was disposed before we got a connection.
          ws.close(1000, "runtime already disposed");
          return;
        }
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        attachedWs = ws;

        // stdin PassThrough → WebSocket
        stdinPT.on("data", (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
        });
        stdinPT.on("end", () => {
          // Propagate graceful shutdown to remote side.
          if (ws.readyState === WebSocket.OPEN) ws.close(1000, "stdin ended");
        });

        // WebSocket → stdout PassThrough
        ws.on("message", (data) => {
          if (!killed) {
            const buf = data instanceof Buffer ? data : Buffer.from(data as unknown as ArrayBuffer);
            stdoutPT.push(buf);
          }
        });

        // Post-connect WS errors: do NOT emit "error" (would be unhandled
        // after AgentRuntime's once("error") fires). Translate to exit.
        ws.on("error", () => {
          if (!killed) {
            stdoutPT.push(null);
            fake.emit("exit", 1, null);
          }
        });

        ws.on("close", (code) => {
          if (!killed) {
            stdoutPT.push(null);
            fake.emit("exit", code === 1000 ? 0 : 1, null);
          }
        });
      };

      const available = pendingConnections.shift();
      if (available) {
        connect(available);
      } else {
        waiters.push(connect);
        timeoutHandle = setTimeout(() => {
          const idx = waiters.indexOf(connect);
          if (idx >= 0) waiters.splice(idx, 1);
          if (!killed) {
            // Emit "error" here — this fires before init completes, so the
            // AgentRuntime's errorWaiter (once("error")) will handle it.
            fake.emit(
              "error",
              new Error(
                `Remote agent '${opts.id}' did not connect within ` +
                  `${CONNECT_TIMEOUT_MS / 1000}s. ` +
                  `Ensure the bridge script is running and can reach this server.`
              )
            );
          }
        }, CONNECT_TIMEOUT_MS);
        if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
      }

      return fake as unknown as ChildProcessByStdio<
        NodeWritable,
        NodeReadable,
        NodeReadable
      >;
    },

    whoami(): Promise<AgentIdentity | null> {
      // Cannot read remote CLI config from this host.
      return Promise.resolve(null);
    },
  };
}
