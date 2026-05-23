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

import { spawn, execSync, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";

const copilotDir = path.join(homedir(), ".copilot");
const dbPath = path.join(copilotDir, "session-store.db");
const sessionStateDir = path.join(copilotDir, "session-state");

function escapeSql(val) {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return String(val);
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function parseSqliteLineFormat(stdout) {
  const lines = stdout.split("\n");
  const results = [];
  let currentRow = null;
  for (const line of lines) {
    if (!line.trim()) {
      if (currentRow) {
        results.push(currentRow);
        currentRow = null;
      }
      continue;
    }
    const match = line.match(/^\s*([^=\s]+)\s*=\s*(.*)$/);
    if (match) {
      if (!currentRow) currentRow = {};
      currentRow[match[1]] = match[2];
    }
  }
  if (currentRow) {
    results.push(currentRow);
  }
  return results;
}

function execSql(dbPath, sql) {
  try {
    const stdout = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" });
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch (err) {
    try {
      const stdout = execFileSync("sqlite3", ["-line", dbPath, sql], { encoding: "utf8" });
      return parseSqliteLineFormat(stdout);
    } catch (fallbackErr) {
      console.error("[bridge] SQL execution error:", err.message, fallbackErr.message);
      throw err;
    }
  }
}


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

function spawnAgent(copilotCmd, localCwd) {
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
    cwd: localCwd,
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
    const agent = spawnAgent(copilotCmd, localCwd);
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

  function wsSend(payload) {
    if (currentWs && currentWs.readyState === WebSocket.OPEN) {
      currentWs.send(JSON.stringify(payload));
    }
  }

  async function handleCmd(msg) {
    const { cmdId, action, payload } = msg;
    try {
      let result;
      if (action === "listSessions") {
        try {
          await fsp.access(dbPath);
        } catch {
          wsSend({ type: "cmd_reply", cmdId, payload: [] });
          return;
        }
        const sessions = execSql(
          dbPath,
          `SELECT * FROM sessions WHERE cwd = ${escapeSql(payload.cwd)} ORDER BY updated_at DESC`
        );
        const summaries = [];
        for (const sess of sessions) {
          const sessionId = sess.id;
          const createdAt = sess.created_at ? Date.parse(sess.created_at) : Date.now();
          const lastActivityAt = sess.updated_at ? Date.parse(sess.updated_at) : Date.now();
          const turns = execSql(
            dbPath,
            `SELECT * FROM turns WHERE session_id = ${escapeSql(sessionId)} ORDER BY turn_index ASC`
          );
          const allMessages = [];
          for (const turn of turns) {
            if (turn.user_message) {
              allMessages.push({ sender: "human", text: turn.user_message });
            }
            if (turn.assistant_response) {
              allMessages.push({ sender: "agent", text: turn.assistant_response });
            }
          }
          let previewLines = [];
          if (allMessages.length <= 16) {
            previewLines = allMessages;
          } else {
            const firstSix = allMessages.slice(0, 6);
            const lastTen = allMessages.slice(-10);
            previewLines = [...firstSix, ...lastTen];
          }
          const transcriptLines = [];
          for (const turn of turns) {
            if (turn.user_message?.trim()) {
              transcriptLines.push(`### User\n${turn.user_message.trim()}`);
            }
            if (turn.assistant_response?.trim()) {
              transcriptLines.push(`### Assistant\n${turn.assistant_response.trim()}`);
            }
          }
          const estimatedTokens = Math.ceil(transcriptLines.join("\n\n").length / 4);

          summaries.push({
            sessionId,
            createdAt,
            lastActivityAt,
            previewLines,
            estimatedTokens,
          });
        }
        result = summaries;
      } else if (action === "cloneSession") {
        const sessions = execSql(
          dbPath,
          `SELECT * FROM sessions WHERE id = ${escapeSql(payload.oldSessionId)}`
        );
        const sessionRow = sessions[0];
        if (sessionRow) {
          const nowIso = new Date().toISOString();
          execSql(
            dbPath,
            `INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at)
             VALUES (
               ${escapeSql(payload.newSessionId)},
               ${escapeSql(payload.cwd)},
               ${escapeSql(sessionRow.repository)},
               ${escapeSql(sessionRow.host_type)},
               ${escapeSql(sessionRow.branch)},
               ${escapeSql(sessionRow.summary)},
               ${escapeSql(nowIso)},
               ${escapeSql(nowIso)}
             )`
          );
        }
        const turns = execSql(
          dbPath,
          `SELECT * FROM turns WHERE session_id = ${escapeSql(payload.oldSessionId)} ORDER BY turn_index ASC`
        );
        for (const turn of turns) {
          execSql(
            dbPath,
            `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
             VALUES (
               ${escapeSql(payload.newSessionId)},
               ${escapeSql(turn.turn_index)},
               ${escapeSql(turn.user_message)},
               ${escapeSql(turn.assistant_response)},
               ${escapeSql(turn.timestamp)}
             )`
          );
        }
        const oldSubDir = path.join(sessionStateDir, payload.oldSessionId);
        const newSubDir = path.join(sessionStateDir, payload.newSessionId);
        try {
          const stat = await fsp.stat(oldSubDir);
          if (stat.isDirectory()) {
            await fsp.mkdir(newSubDir, { recursive: true });
            await fsp.cp(oldSubDir, newSubDir, { recursive: true });
          }
        } catch {
          // ignore
        }
        result = null;
      } else if (action === "deleteSession") {
        execSql(dbPath, `DELETE FROM sessions WHERE id = ${escapeSql(payload.sessionId)}`);
        execSql(dbPath, `DELETE FROM turns WHERE session_id = ${escapeSql(payload.sessionId)}`);
        try {
          execSql(dbPath, `DELETE FROM search_index_content WHERE c1 = ${escapeSql(payload.sessionId)}`);
        } catch {
          // ignore
        }
        const subDir = path.join(sessionStateDir, payload.sessionId);
        try {
          await fsp.rm(subDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        result = null;
      } else if (action === "getTranscript") {
        const turns = execSql(
          dbPath,
          `SELECT * FROM turns WHERE session_id = ${escapeSql(payload.sessionId)} ORDER BY turn_index ASC`
        );
        const transcriptLines = [];
        for (const turn of turns) {
          if (turn.user_message?.trim()) {
            transcriptLines.push(`### User\n${turn.user_message.trim()}`);
          }
          if (turn.assistant_response?.trim()) {
            transcriptLines.push(`### Assistant\n${turn.assistant_response.trim()}`);
          }
        }
        result = transcriptLines.join("\n\n");
      } else if (action === "compactSession") {
        const nowIso = new Date().toISOString();
        execSql(
          dbPath,
          `INSERT INTO sessions (id, cwd, updated_at) 
           VALUES (${escapeSql(payload.sessionId)}, ${escapeSql(payload.cwd)}, ${escapeSql(nowIso)}) 
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
        );
        execSql(dbPath, `DELETE FROM turns WHERE session_id = ${escapeSql(payload.sessionId)}`);
        execSql(
          dbPath,
          `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
           VALUES (
             ${escapeSql(payload.sessionId)},
             0,
             ${escapeSql("[Session history compacted due to context limits]")},
             ${escapeSql(payload.summary)},
             ${escapeSql(nowIso)}
           )`
        );
        execSql(
          dbPath,
          `UPDATE sessions SET updated_at = ${escapeSql(nowIso)} WHERE id = ${escapeSql(payload.sessionId)}`
        );
        result = null;
      } else {
        throw new Error(`Unknown action: ${action}`);
      }
      wsSend({ type: "cmd_reply", cmdId, payload: result });
    } catch (err) {
      console.error(`[bridge] Error handling cmd ${action}:`, err);
      wsSend({ type: "cmd_reply", cmdId, error: err.message });
    }
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
    } else if (msg.type === "cmd") {
      handleCmd(msg);
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

/** Extract a named flag + its value from rawArgs in-place. Returns value or null. */
function extractFlag(flag) {
  const idx = rawArgs.indexOf(flag);
  if (idx === -1) return null;
  const val = rawArgs[idx + 1];
  if (!val || val.startsWith("-")) {
    console.error(`Error: ${flag} requires a value argument`);
    process.exit(1);
  }
  rawArgs.splice(idx, 2);
  return val;
}

// Extract all named flags before touching positional args.
const cwdArg = extractFlag("--cwd");
const gistArg = extractFlag("--gist");

let localCwd = cwdArg ? cwdArg.replace(/^~/, homedir()) : process.cwd();

console.error(`[bridge] Local cwd: ${localCwd}`);

/**
 * Resolve a WebSocket URL from a GitHub Gist.
 * Accepts "owner/gistId" and fetches the raw content directly from
 * gist.githubusercontent.com — no API call, no rate limits.
 */
async function resolveUrlFromGist(ownerAndId) {
  const parts = ownerAndId.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    console.error(`[bridge] --gist must be in "owner/gistId" format, got: ${ownerAndId}`);
    process.exit(1);
  }
  const [owner, gistId] = parts;
  const rawUrl = `https://gist.githubusercontent.com/${owner}/${gistId}/raw/tunnel-url.txt`;
  console.error(`[bridge] Fetching tunnel URL from gist …`);
  const res = await fetch(rawUrl, { headers: { "User-Agent": "seam-acp-bridge" } });
  if (!res.ok) {
    console.error(`[bridge] Failed to fetch gist content: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const url = (await res.text()).trim();
  if (!url.startsWith("wss://")) {
    console.error(`[bridge] Unexpected URL in gist: ${url}`);
    process.exit(1);
  }
  console.error(`[bridge] Resolved tunnel URL: ${url}`);
  return url;
}

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
  // wsUrl may come from --gist flag or as a positional arg.
  const wsUrlPositional = rawArgs[0];
  const token = rawArgs[1];
  const copilotCmd = process.env.COPILOT_CMD ?? rawArgs[2] ?? "copilot";

  if (!token && !gistArg) {
    console.error("Usage: node remote-agent-bridge.mjs [--gist <owner/gistId>] <ws-url> <token> [--cwd <path>] [copilot-cmd]");
    console.error("       node remote-agent-bridge.mjs --server <port> <token> [--cwd <path>] [copilot-cmd]");
    process.exit(1);
  }

  if (gistArg) {
    // When --gist is provided the positional arg order shifts: token is first.
    const tokenFromArg = rawArgs[0];
    const copilotCmdFromArg = process.env.COPILOT_CMD ?? rawArgs[1] ?? "copilot";
    if (!tokenFromArg) {
      console.error("Usage: node remote-agent-bridge.mjs --gist <owner/gistId> <token> [--cwd <path>] [copilot-cmd]");
      process.exit(1);
    }
    resolveUrlFromGist(gistArg).then((wsUrl) => {
      runClientMode(wsUrl, tokenFromArg, copilotCmdFromArg, localCwd);
    });
  } else {
    if (!wsUrlPositional || !token) {
      console.error("Usage: node remote-agent-bridge.mjs <ws-url> <token> [--cwd <path>] [copilot-cmd]");
      console.error("       node remote-agent-bridge.mjs --server <port> <token> [--cwd <path>] [copilot-cmd]");
      process.exit(1);
    }
    runClientMode(wsUrlPositional, token, copilotCmd, localCwd);
  }
}
