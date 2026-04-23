#!/usr/bin/env node
/**
 * remote-agent-bridge.mjs
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
