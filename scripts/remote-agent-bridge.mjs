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
 *     node remote-agent-bridge.mjs <ws-url> <token> [--cwd <path>] [copilot-cmd]
 *
 *   Arguments:
 *     ws-url      seam-acp WebSocket URL, e.g. wss://tunnel.trycloudflare.com
 *                 (or ws://localhost:9999 for local testing)
 *     token       Shared secret matching REMOTE_COPILOT_PROFILES token in .env
 *     --cwd path  Local working directory to use (default: process.cwd())
 *     copilot-cmd Optional path to the copilot binary (default: "copilot")
 *                 Override with COPILOT_CMD env var.
 *
 *   seam-acp .env:
 *     REMOTE_COPILOT_PROFILES=mac:9999:mysecrettoken
 *
 *   Example:
 *     node remote-agent-bridge.mjs wss://your-tunnel.trycloudflare.com mysecret --cwd /Users/you/Projects
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SERVER MODE: bridge hosts a WS server; seam-acp dials in.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Usage:
 *     node remote-agent-bridge.mjs --server <port> <token> [--cwd <path>] [copilot-cmd]
 *
 *   seam-acp .env:
 *     REMOTE_COPILOT_PROFILES=mac:wss://random.trycloudflare.com:mysecrettoken
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Dependencies:
 *   npm install ws   (or run from within the cloned seam-acp repo directory)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";

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
 * Rewrites the `cwd` field in ACP `initialize` and `create_session` messages
 * so the agent uses a valid local path instead of the server's path.
 */
function rewriteCwd(line, localCwd) {
  try {
    const msg = JSON.parse(line);
    if (
      msg &&
      (msg.method === "initialize" || msg.method === "create_session") &&
      msg.params &&
      msg.params.cwd
    ) {
      msg.params.cwd = localCwd;
      // Clear server-side additional directories — they won't exist locally.
      if (Array.isArray(msg.params.additionalDirectories)) {
        msg.params.additionalDirectories = [];
      }
      console.error(`[bridge] Rewrote cwd in '${msg.method}' to: ${localCwd}`);
      return JSON.stringify(msg);
    }
  } catch {
    // Not valid JSON or not an ACP message — pass through as-is.
  }
  return line;
}

/**
 * Pipe a single WebSocket ↔ copilot --acp process.
 * Intercepts ACP initialize/create_session to rewrite the cwd to localCwd.
 */
function bridgeConnection(ws, copilotCmd, WebSocket, localCwd) {
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

  // Buffer partial ndjson lines and rewrite cwd before forwarding to the agent.
  let lineBuffer = "";
  ws.on("message", (data) => {
    if (!agent.killed) {
      lineBuffer += data instanceof Buffer ? data.toString("utf8") : String(data);
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          agent.stdin.write(rewriteCwd(line, localCwd) + "\n");
        }
      }
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

async function runClientMode(wsUrl, token, copilotCmd, localCwd) {
  const { WebSocket } = await loadWs();

  function connect() {
    console.error(`[bridge] Connecting to ${wsUrl} ...`);

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    ws.on("open", () => {
      console.error("[bridge] Connected.");
      bridgeConnection(ws, copilotCmd, WebSocket, localCwd);
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
    });
  }

  connect();
}

async function runServerMode(port, token, copilotCmd, localCwd) {
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
    bridgeConnection(ws, copilotCmd, WebSocket, localCwd);
  });

  wss.on("error", (err) => {
    console.error(`[bridge] Server error: ${err.message}`);
    process.exit(1);
  });
}

// ─── Argument parsing ────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

// Extract --cwd <path> from args
let localCwd = process.cwd();
const cwdIdx = rawArgs.indexOf("--cwd");
if (cwdIdx !== -1) {
  const cwdVal = rawArgs[cwdIdx + 1];
  if (!cwdVal || cwdVal.startsWith("-")) {
    console.error("Error: --cwd requires a path argument");
    process.exit(1);
  }
  localCwd = cwdVal.replace(/^~/, homedir());
  rawArgs.splice(cwdIdx, 2);
}

console.error(`[bridge] Local cwd: ${localCwd}`);

if (rawArgs[0] === "--server") {
  const port = Number(rawArgs[1]);
  const token = rawArgs[2];
  const copilotCmd = process.env.COPILOT_CMD ?? rawArgs[3] ?? "copilot";

  if (!port || !token) {
    console.error("Usage: node remote-agent-bridge.mjs --server <port> <token> [--cwd <path>] [copilot-cmd]");
    process.exit(1);
  }

  runServerMode(port, token, copilotCmd, localCwd);
} else {
  const wsUrl = rawArgs[0];
  const token = rawArgs[1];
  const copilotCmd = process.env.COPILOT_CMD ?? rawArgs[2] ?? "copilot";

  if (!wsUrl || !token) {
    console.error("Usage: node remote-agent-bridge.mjs <ws-url> <token> [--cwd <path>] [copilot-cmd]");
    console.error("       node remote-agent-bridge.mjs --server <port> <token> [--cwd <path>] [copilot-cmd]");
    process.exit(1);
  }

  runClientMode(wsUrl, token, copilotCmd, localCwd);
}
