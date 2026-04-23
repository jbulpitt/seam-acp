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
 * Send a multiplexed message over a WebSocket.
 * Protocol: { slot, type, data?, code? }
 *   "data"  — ACP payload (UTF-8 text)
 *   "kill"  — seam-acp → bridge: terminate agent for this slot
 *   "exit"  — bridge → seam-acp: agent exited
 */
function muxSend(ws, WebSocket, slot, type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ slot, type, ...payload }));
}

/**
 * Create a slot manager that multiplexes multiple agent processes over one WS.
 * Each slot gets its own agent process, spawned lazily on first message.
 * Agents survive WS reconnects — stdout is routed to `currentWs`.
 */
function makeSlotManager(copilotCmd, localCwd, WebSocket) {
  let currentWs = null;
  const slots = new Map(); // slot -> ChildProcess

  function setWs(ws) {
    currentWs = ws;
  }

  function getOrSpawnSlot(slot) {
    if (slots.has(slot)) return slots.get(slot);

    console.error(`[bridge] Slot ${slot}: spawning agent`);
    const agent = spawnAgent(copilotCmd);
    slots.set(slot, agent);

    agent.stdout.on("data", (chunk) => {
      muxSend(currentWs, WebSocket, slot, "data", { data: chunk.toString("utf8") });
    });

    agent.on("error", (err) => {
      console.error(`[bridge] Slot ${slot} agent error: ${err.message}`);
      slots.delete(slot);
      muxSend(currentWs, WebSocket, slot, "exit", { code: 1 });
    });

    agent.on("exit", (code, signal) => {
      console.error(`[bridge] Slot ${slot} agent exited (code=${code}, signal=${signal})`);
      slots.delete(slot);
      muxSend(currentWs, WebSocket, slot, "exit", { code: code ?? 1 });
    });

    return agent;
  }

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "data" && msg.data !== undefined) {
      const agent = getOrSpawnSlot(msg.slot);
      if (agent && !agent.killed) {
        agent.stdin.write(rewriteCwdInChunk(msg.data, localCwd));
      }
    } else if (msg.type === "kill") {
      const agent = slots.get(msg.slot);
      if (agent) {
        console.error(`[bridge] Slot ${msg.slot}: kill received — terminating agent`);
        agent.kill();
        slots.delete(msg.slot);
      }
    }
  }

  return { setWs, handleMessage };
}

async function runClientMode(wsUrl, token, copilotCmd, localCwd) {
  const { WebSocket } = await loadWs();
  const mgr = makeSlotManager(copilotCmd, localCwd, WebSocket);

  function connect() {
    console.error(`[bridge] Connecting to ${wsUrl} ...`);
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    ws.on("open", () => {
      console.error("[bridge] Connected.");
      mgr.setWs(ws);

      const keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, KEEPALIVE_PING_MS);
      ws.once("close", () => clearInterval(keepalive));
    });

    ws.on("message", (raw) => mgr.handleMessage(raw));

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

async function runServerMode(port, token, copilotCmd, localCwd) {
  const { WebSocket, WebSocketServer } = await loadWs();
  const mgr = makeSlotManager(copilotCmd, localCwd, WebSocket);

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
