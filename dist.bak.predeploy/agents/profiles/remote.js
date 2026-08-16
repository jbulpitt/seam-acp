import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
/**
 * How long spawn() will wait for a bridge connection before emitting an error
 * (just under AgentRuntime's 45 s START_TIMEOUT_MS so errors are actionable).
 */
const CONNECT_TIMEOUT_MS = 10_000;
/** How often to ping the bridge WS to keep tunnels/proxies alive. */
const ACTIVE_PING_INTERVAL_MS = 25_000;
function remoteDisplayName(id) {
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
function makeMux(opts) {
    let bridgeWs = null;
    let lastBridgeInstanceId;
    let nextSlot = 0;
    const slots = new Map();
    /** Timeout handles for spawn() calls waiting for the bridge to come online. */
    const bridgeWaiters = [];
    const pendingCmds = new Map();
    function send(msg) {
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
    function attach(newWs) {
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
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            }
            catch {
                return;
            }
            // Bridge announces its instance ID on every connect. If it changed, the
            // bridge process restarted and all its agent slots are gone — emit exit
            // events so runtimes are evicted and re-initialized on next message.
            if (msg.type === "bridge_hello") {
                const newId = msg.instanceId;
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
                    void sendCmd("listSlots", {}).then((reply) => {
                        const liveOnBridge = new Set(reply.slots);
                        for (const [slot, entry] of [...slots]) {
                            if (!entry.killed && !liveOnBridge.has(slot)) {
                                send({ slot, type: "kill" });
                                entry.killed = true;
                                entry.stdout.push(null);
                                entry.fake.emit("exit", 1, null);
                                slots.delete(slot);
                            }
                        }
                    }).catch(() => { });
                }
                return;
            }
            if (msg.type === "cmd_reply" && msg.cmdId) {
                const handler = pendingCmds.get(msg.cmdId);
                if (handler) {
                    pendingCmds.delete(msg.cmdId);
                    if (msg.error) {
                        handler.reject(new Error(msg.error));
                    }
                    else {
                        handler.resolve(msg.payload);
                    }
                }
                return;
            }
            if (msg.slot === undefined)
                return;
            const entry = slots.get(msg.slot);
            if (!entry || entry.killed)
                return;
            if (msg.type === "data" && msg.data !== undefined) {
                entry.stdout.push(msg.data);
            }
            else if (msg.type === "exit") {
                entry.killed = true;
                slots.delete(msg.slot);
                entry.stdout.push(null);
                entry.fake.emit("exit", msg.code ?? 1, null);
            }
        });
        newWs.on("close", () => {
            if (bridgeWs === newWs)
                bridgeWs = null;
        });
        newWs.on("error", () => {
            if (bridgeWs === newWs)
                bridgeWs = null;
        });
    }
    function spawn() {
        const slot = nextSlot++;
        const stdinPT = new PassThrough();
        const stdoutPT = new PassThrough();
        const stderrPT = new PassThrough();
        const emitter = new EventEmitter();
        const stdinQueue = [];
        let killed = false;
        const fake = Object.assign(emitter, {
            stdin: stdinPT,
            stdout: stdoutPT,
            stderr: stderrPT,
            get killed() {
                return killed;
            },
            kill() {
                if (killed)
                    return;
                killed = true;
                const entry = slots.get(slot);
                if (entry)
                    entry.killed = true;
                slots.delete(slot);
                send({ slot, type: "kill" });
                stdinPT.destroy();
                stdoutPT.push(null);
            },
        });
        slots.set(slot, { stdout: stdoutPT, fake, stdinQueue, killed: false });
        stdinPT.on("data", (chunk) => {
            if (killed)
                return;
            const text = chunk.toString("utf8");
            if (bridgeWs?.readyState === WebSocket.OPEN) {
                // Flush any previously buffered data first.
                for (const queued of stdinQueue.splice(0)) {
                    send({ slot, type: "data", data: queued });
                }
                send({ slot, type: "data", data: text });
            }
            else {
                stdinQueue.push(text);
            }
        });
        // If bridge isn't online yet, start a connect timeout.
        if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
            const timeout = setTimeout(() => {
                const idx = bridgeWaiters.findIndex((w) => w.slot === slot);
                if (idx >= 0)
                    bridgeWaiters.splice(idx, 1);
                if (!killed) {
                    fake.emit("error", new Error(`Remote agent '${opts.id}' did not connect within ${CONNECT_TIMEOUT_MS / 1000}s. ` +
                        `Ensure the bridge script is running and pointed at this server.`));
                }
            }, CONNECT_TIMEOUT_MS);
            if (typeof timeout.unref === "function")
                timeout.unref();
            bridgeWaiters.push({ slot, timeout });
        }
        return fake;
    }
    async function sendCmd(action, payload) {
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
            if (typeof timeout.unref === "function")
                timeout.unref();
            send({ type: "cmd", cmdId, action, payload });
        });
    }
    return { attach, spawn, sendCmd };
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
export function makeRemoteCopilotServerProfile(opts) {
    const mux = makeMux({ id: opts.id, onBridgeConnect: opts.onBridgeConnect });
    const wss = new WebSocketServer({ port: opts.wsPort });
    wss.on("connection", (ws, req) => {
        const auth = req.headers["authorization"];
        if (!auth || auth !== `Bearer ${opts.token}`) {
            ws.close(4001, "unauthorized");
            return;
        }
        const keepalive = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN)
                ws.ping();
        }, ACTIVE_PING_INTERVAL_MS);
        ws.once("close", () => clearInterval(keepalive));
        mux.attach(ws);
    });
    return {
        id: opts.id,
        displayName: opts.displayName ?? remoteDisplayName(opts.id),
        defaultModel: opts.defaultModel,
        staticModels: opts.staticModels,
        threadAbbr: opts.threadAbbr,
        ...(opts.restrictDiscordAccess ? { restrictDiscordAccess: true } : {}),
        spawn: mux.spawn.bind(mux),
        whoami() {
            return Promise.resolve(null);
        },
        sessionManager: buildSessionManager(mux),
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
export function makeRemoteCopilotClientProfile(opts) {
    const mux = makeMux({ id: opts.id, onBridgeConnect: opts.onBridgeConnect });
    function connect() {
        const ws = new WebSocket(opts.wsUrl, {
            headers: { Authorization: `Bearer ${opts.token}` },
        });
        const keepalive = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN)
                ws.ping();
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
        staticModels: opts.staticModels,
        threadAbbr: opts.threadAbbr,
        ...(opts.restrictDiscordAccess ? { restrictDiscordAccess: true } : {}),
        spawn: mux.spawn.bind(mux),
        whoami() {
            return Promise.resolve(null);
        },
        sessionManager: buildSessionManager(mux),
    };
}
function buildSessionManager(mux) {
    return {
        async listSessions(cwd) {
            return mux.sendCmd("listSessions", { cwd });
        },
        async cloneSession(cwd, oldSessionId, newSessionId) {
            return mux.sendCmd("cloneSession", { cwd, oldSessionId, newSessionId });
        },
        async deleteSession(cwd, sessionId) {
            return mux.sendCmd("deleteSession", { cwd, sessionId });
        },
        async getTranscript(cwd, sessionId) {
            return mux.sendCmd("getTranscript", { cwd, sessionId });
        },
        async getUsage(cwd, sessionId, newerThanMs) {
            return mux.sendCmd("getUsage", {
                cwd,
                ...(sessionId ? { sessionId } : {}),
                ...(newerThanMs !== undefined ? { newerThanMs } : {}),
            });
        },
        async writeAttachment(cwd, filename, base64) {
            return mux.sendCmd("writeAttachment", { cwd, filename, base64 });
        },
    };
}
// ---------------------------------------------------------------------------
// Back-compat alias — existing code that calls makeRemoteCopilotProfile keeps
// working; it maps to the server mode.
// ---------------------------------------------------------------------------
export const makeRemoteCopilotProfile = makeRemoteCopilotServerProfile;
//# sourceMappingURL=remote.js.map