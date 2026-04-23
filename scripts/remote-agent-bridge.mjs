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

import { spawn, execSync } from "node:child_process";
import { homedir } from "node:os";

/** Milliseconds to wait before reconnecting after a disconnect (client mode). */
const RECONNECT_DELAY_MS = 5_000;

/** Interval for sending WS ping frames to keep the tunnel/proxy alive. */
const KEEPALIVE_PING_MS = 25_000;

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
 * Rewrites the `cwd` field in an ACP chunk when it contains an initialize or
 * create_session message. Uses simple text replacement — safe because cwd is
 * always a plain path string and the method check prevents false positives.
 */
function rewriteCwdInChunk(text, localCwd) {
  if (!text.includes('"initialize"') && !text.includes('"session/new"') && !text.includes('"session/resume"') && !text.includes('"session/load"')) {
    return text;
  }
  const escaped = localCwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const rewritten = text.replace(/"cwd"\s*:\s*"[^"]*"/g, `"cwd":"${escaped}"`);
  if (rewritten !== text) {
    console.error(`[bridge] Rewrote cwd to: ${localCwd}`);
  }
  return rewritten;
}

function spawnAgent(copilotCmd) {
  const ghToken = process.env.GH_TOKEN || (() => {
    try { return execSync("gh auth token", { stdio: ["pipe", "pipe", "ignore"] }).toString().trim(); }
    catch { return ""; }
  })();
  const cmdParts = copilotCmd.split(" ");
  const cmd = cmdParts[0];
  const extraArgs = process.env.COPILOT_ARGS !== undefined
    ? process.env.COPILOT_ARGS.split(" ").filter(Boolean)
    : ["--acp"];
  const cmdArgs = [...cmdParts.slice(1), ...extraArgs];
  console.error(`[bridge] Spawning agent: ${cmd} ${cmdArgs.join(" ")} (GH_TOKEN: ${ghToken ? ghToken.slice(0, 8) + "..." : "MISSING"})`);
  return spawn(cmd, cmdArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...(ghToken ? { GH_TOKEN: ghToken } : {}) },
  });
}

/**
 * Attach an existing agent process to a WebSocket.
 * Does NOT kill the agent when the WS closes — caller handles reconnect.
 * Returns a cleanup function to detach listeners.
 */
function attachAgentToWs(agent, ws, WebSocket, localCwd) {
  const onMessage = (data) => {
    if (!agent.killed) {
      const text = data instanceof Buffer ? data.toString("utf8") : String(data);
      agent.stdin.write(rewriteCwdInChunk(text, localCwd));
    }
  };
  const onStdout = (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  };
  ws.on("message", onMessage);
  agent.stdout.on("data", onStdout);
  return () => {
    ws.off("message", onMessage);
    agent.stdout.off("data", onStdout);
  };
}

async function runClientMode(wsUrl, token, copilotCmd, localCwd) {
  const { WebSocket } = await loadWs();

  // Spawn the agent once; keep it alive across WS reconnects.
  let agent = spawnAgent(copilotCmd);
  agent.on("error", (err) => {
    console.error(`[bridge] Agent error: ${err.message} — will respawn on next connect`);
    agent = null;
  });
  agent.on("exit", (code, signal) => {
    console.error(`[bridge] Agent exited (code=${code}, signal=${signal}) — will respawn on next connect`);
    agent = null;
  });

  function connect() {
    console.error(`[bridge] Connecting to ${wsUrl} ...`);
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    ws.on("open", () => {
      console.error("[bridge] Connected.");

      // Keep the tunnel alive with periodic pings.
      const keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, KEEPALIVE_PING_MS);
      ws.once("close", () => clearInterval(keepalive));

      // Respawn agent if it died while we were disconnected.
      if (!agent || agent.killed) {
        console.error("[bridge] Agent was not running — respawning...");
        agent = spawnAgent(copilotCmd);
        agent.on("error", (err) => {
          console.error(`[bridge] Agent error: ${err.message}`);
          ws.close(1011, "agent error");
          agent = null;
        });
        agent.on("exit", (code, signal) => {
          console.error(`[bridge] Agent exited (code=${code}, signal=${signal})`);
          ws.close(1000, "agent exited");
          agent = null;
        });
      }
      const detach = attachAgentToWs(agent, ws, WebSocket, localCwd);
      ws.once("close", detach);
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

  let agent = spawnAgent(copilotCmd);
  agent.on("error", (err) => { console.error(`[bridge] Agent error: ${err.message}`); agent = null; });
  agent.on("exit", (code, signal) => { console.error(`[bridge] Agent exited (code=${code}, signal=${signal})`); agent = null; });

  wss.on("connection", (ws, req) => {
    const auth = req.headers["authorization"];
    if (!auth || auth !== `Bearer ${token}`) {
      console.error("[bridge] Rejected connection: bad token");
      ws.close(4001, "unauthorized");
      return;
    }
    console.error("[bridge] seam-acp connected.");
    if (!agent || agent.killed) {
      console.error("[bridge] Agent was not running — respawning...");
      agent = spawnAgent(copilotCmd);
      agent.on("error", (err) => { console.error(`[bridge] Agent error: ${err.message}`); agent = null; });
      agent.on("exit", (code, signal) => { console.error(`[bridge] Agent exited (code=${code}, signal=${signal})`); agent = null; });
    }
    const detach = attachAgentToWs(agent, ws, WebSocket, localCwd);
    ws.once("close", detach);
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
