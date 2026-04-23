#!/usr/bin/env node
/**
 * remote-agent-bridge.mjs
 *
 * Run this on the machine where the agent CLI (e.g. Copilot) is installed.
 * Bridges the ACP stdio protocol between a local agent CLI and seam-acp over
 * a WebSocket connection. Supports two modes:
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CLIENT MODE (default): bridge dials out to seam-acp's WS server.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Usage:
 *     node remote-agent-bridge.mjs <ws-url> <token> [copilot-cmd]
 *
 *   Arguments:
 *     ws-url      seam-acp WebSocket URL, e.g. wss://tunnel.trycloudflare.com
 *                 (or ws://localhost:9999 for local testing)
 *     token       Shared secret matching REMOTE_COPILOT_PROFILES token in .env
 *     copilot-cmd Optional path to the copilot binary (default: "copilot")
 *                 Override with COPILOT_CMD env var.
 *
 *   seam-acp .env:
 *     REMOTE_COPILOT_PROFILES=mac:9999:mysecrettoken
 *     (seam-acp runs the WS server on port 9999; tunnel exposes it on the server side)
 *
 *   Example:
 *     node remote-agent-bridge.mjs wss://your-tunnel.trycloudflare.com mysecret
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SERVER MODE: bridge hosts a WS server; seam-acp dials in.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Usage:
 *     node remote-agent-bridge.mjs --server <port> <token> [copilot-cmd]
 *
 *   Arguments:
 *     port        Local TCP port to listen on
 *     token       Shared secret — seam-acp sends Authorization: Bearer <token>
 *     copilot-cmd Optional path to the copilot binary (default: "copilot")
 *                 Override with COPILOT_CMD env var.
 *
 *   seam-acp .env:
 *     REMOTE_COPILOT_PROFILES=mac:wss://random.trycloudflare.com:mysecrettoken
 *     (seam-acp connects to the tunnel URL; Cloudflare forwards to this port)
 *
 *   Example:
 *     node remote-agent-bridge.mjs --server 9999 mysecret
 *     cloudflared tunnel --url ws://localhost:9999
 *     # → prints wss://random-name.trycloudflare.com
 *     # Paste that URL into REMOTE_COPILOT_PROFILES on the seam-acp server
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Dependencies:
 *   npm install ws   (or run from within the cloned seam-acp repo directory)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn } from "node:child_process";

/** Milliseconds to wait before reconnecting after a disconnect (client mode). */
const RECONNECT_DELAY_MS = 5_000;

async function loadWs() {
  try {
    const mod = await import("ws");
    return { WebSocket: mod.WebSocket, WebSocketServer: mod.WebSocketServer };
  } catch {
    console.error("Error: 'ws' package not found. Install it with: npm install ws");
    process.exit(1);
  }
}

/**
 * Pipe a single WebSocket ↔ copilot --acp process.
 * Used by both modes once a WS connection is established.
 */
function bridgeConnection(ws, copilotCmd, WebSocket) {
  console.error("[bridge] Spawning agent...");

  const agent = spawn(copilotCmd, ["--acp"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  agent.on("error", (err) => {
    console.error(`[bridge] Failed to spawn agent: ${err.message}`);
    ws.close(1011, "agent spawn failed");
  });

  agent.on("exit", (code, signal) => {
    console.error(`[bridge] Agent exited (code=${code}, signal=${signal})`);
    ws.close(1000, "agent exited");
  });

  ws.on("message", (data) => {
    if (!agent.killed) {
      agent.stdin.write(data instanceof Buffer ? data : Buffer.from(data));
    }
  });

  agent.stdout.on("data", (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });

  ws.on("close", () => {
    if (!agent.killed) agent.kill();
  });

  ws.on("error", (err) => {
    console.error(`[bridge] WebSocket error: ${err.message}`);
    if (!agent.killed) agent.kill();
  });
}

async function runClientMode(wsUrl, token, copilotCmd) {
  const { WebSocket } = await loadWs();

  function connect() {
    console.error(`[bridge] Connecting to ${wsUrl} ...`);

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    ws.on("open", () => {
      console.error("[bridge] Connected.");
      bridgeConnection(ws, copilotCmd, WebSocket);
    });

    ws.on("close", (code, reason) => {
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
      // 'close' will fire after this; reconnect logic is there.
    });
  }

  connect();
}

async function runServerMode(port, token, copilotCmd) {
  const { WebSocket, WebSocketServer } = await loadWs();

  const wss = new WebSocketServer({ port });

  wss.on("listening", () => {
    console.error(`[bridge] Listening on ws://localhost:${port}`);
    console.error(`[bridge] Expose with: cloudflared tunnel --url ws://localhost:${port}`);
  });

  wss.on("connection", (ws, req) => {
    const auth = req.headers["authorization"];
    if (!auth || auth !== `Bearer ${token}`) {
      console.error("[bridge] Rejected connection: bad token");
      ws.close(4001, "unauthorized");
      return;
    }
    console.error("[bridge] seam-acp connected.");
    bridgeConnection(ws, copilotCmd, WebSocket);
  });

  wss.on("error", (err) => {
    console.error(`[bridge] Server error: ${err.message}`);
    process.exit(1);
  });
}

// ─── Argument parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args[0] === "--server") {
  const port = Number(args[1]);
  const token = args[2];
  const copilotCmd = process.env.COPILOT_CMD ?? args[3] ?? "copilot";

  if (!port || !token) {
    console.error("Usage: node remote-agent-bridge.mjs --server <port> <token> [copilot-cmd]");
    process.exit(1);
  }

  runServerMode(port, token, copilotCmd);
} else {
  const wsUrl = args[0];
  const token = args[1];
  const copilotCmd = process.env.COPILOT_CMD ?? args[2] ?? "copilot";

  if (!wsUrl || !token) {
    console.error("Usage: node remote-agent-bridge.mjs <ws-url> <token> [copilot-cmd]");
    console.error("       node remote-agent-bridge.mjs --server <port> <token> [copilot-cmd]");
    process.exit(1);
  }

  runClientMode(wsUrl, token, copilotCmd);
}

 *
 * Run this on the machine where the agent CLI (e.g. Copilot) is installed.
 * It connects outbound to the seam-acp WebSocket server and pipes the ACP
 * stdio protocol over the WebSocket, making the local CLI available as a
 * remote agent profile.
 *
 * Usage:
 *   node remote-agent-bridge.mjs <ws-url> <token> [copilot-cmd]
 *
 * Arguments:
 *   ws-url      WebSocket URL of seam-acp, e.g. wss://agent.example.com:9999
 *               or ws://localhost:9999 for local testing.
 *   token       Shared secret matching REMOTE_COPILOT_PROFILES token in .env.
 *   copilot-cmd Optional path to the copilot CLI binary (default: "copilot").
 *               Override with COPILOT_CMD env var.
 *
 * Dependencies:
 *   npm install ws   (or run from within the cloned seam-acp repo directory)
 *
 * The bridge will automatically reconnect on disconnect.
 *
 * Example with Cloudflare Tunnel (recommended for corporate networks):
 *   # On the seam-acp server: cloudflared tunnel --url ws://localhost:9999
 *   # On the Mac:
 *   node remote-agent-bridge.mjs wss://your-tunnel.trycloudflare.com mysecret
 */

import { spawn } from "node:child_process";

const wsUrl = process.argv[2];
const token = process.argv[3];
const copilotCmd = process.env.COPILOT_CMD ?? process.argv[4] ?? "copilot";

if (!wsUrl || !token) {
  console.error("Usage: node remote-agent-bridge.mjs <ws-url> <token> [copilot-cmd]");
  process.exit(1);
}

/** Milliseconds to wait before reconnecting after a disconnect. */
const RECONNECT_DELAY_MS = 5_000;

async function loadWs() {
  try {
    const { WebSocket } = await import("ws");
    return WebSocket;
  } catch {
    // Node 22+ has a built-in WebSocket, but it doesn't support custom headers
    // easily. Prefer the 'ws' package.
    console.error(
      "Error: 'ws' package not found. Install it with: npm install ws"
    );
    process.exit(1);
  }
}

async function run() {
  const WebSocket = await loadWs();

  function connect() {
    console.error(`[bridge] Connecting to ${wsUrl} ...`);

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    let agent = null;

    ws.on("open", () => {
      console.error("[bridge] Connected. Spawning agent...");

      agent = spawn(copilotCmd, ["--acp"], {
        stdio: ["pipe", "pipe", "inherit"],
      });

      agent.on("error", (err) => {
        console.error(`[bridge] Failed to spawn agent: ${err.message}`);
        ws.close(1011, "agent spawn failed");
      });

      agent.on("exit", (code, signal) => {
        console.error(`[bridge] Agent exited (code=${code}, signal=${signal})`);
        ws.close(1000, "agent exited");
      });

      // WebSocket → agent stdin
      ws.on("message", (data) => {
        if (agent && !agent.killed) {
          agent.stdin.write(data instanceof Buffer ? data : Buffer.from(data));
        }
      });

      // Agent stdout → WebSocket
      agent.stdout.on("data", (chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });
    });

    ws.on("close", (code, reason) => {
      console.error(
        `[bridge] WebSocket closed (code=${code}, reason=${reason || "(none)"})`
      );
      if (agent && !agent.killed) {
        agent.kill();
      }
      agent = null;
      // Reconnect unless this was a deliberate auth failure.
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
      // 'close' will fire after this; reconnect logic is there.
    });
  }

  connect();
}

run();
