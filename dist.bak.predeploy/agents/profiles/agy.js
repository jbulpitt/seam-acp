/**
 * Antigravity (`agy`) CLI as an in-process ACP agent.
 *
 * `agy` doesn't speak ACP, so this profile fakes a `ChildProcessByStdio`
 * (`PassThrough` streams instead of a real subprocess) and runs an
 * `AgentSideConnection` against it directly inside seam-acp. Every ACP
 * `session/prompt` is fulfilled by spawning a real `agy -p` child,
 * discovering the language server it boots, and translating its
 * `StreamAgentStateUpdates` events into ACP `sessionUpdate` notifications.
 *
 * Streaming mapping:
 *   plannerResponse.thinking          → agent_thought_chunk (delta)
 *   plannerResponse.modifiedResponse  → agent_message_chunk (delta)
 *   tool-call step types              → tool_call + tool_call_update
 *   USER_INPUT / CONVERSATION_HISTORY / CHECKPOINT → suppressed (internal)
 *
 * Session continuity: the first prompt in an ACP session spawns a fresh
 * agy conversation; subsequent prompts pass `--conversation <id>` so the
 * agent picks up where it left off.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { PassThrough, Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError, } from "@agentclientprotocol/sdk";
import { discoverAgyLs, subscribeToAgyStream, } from "../agy-stream.js";
import { STAGING_ROOT } from "../attachment-staging.js";
const AGY_HOME = path.join(process.env.HOME ?? "/root", ".gemini/antigravity-cli");
const CONVERSATION_DIR = path.join(AGY_HOME, "conversations");
const SETTINGS_FILE = path.join(AGY_HOME, "settings.json");
/** Legacy mapping file from before we moved this state out of agy's home dir. */
const LEGACY_MAPPING_FILE = path.join(AGY_HOME, "seam_sessions.json");
async function loadPersistedSession(file, sessionId) {
    for (const candidate of [file, LEGACY_MAPPING_FILE]) {
        try {
            const data = await fs.readFile(candidate, "utf8");
            const mapping = JSON.parse(data);
            const entry = mapping[sessionId];
            if (!entry)
                continue;
            // Old format stored just the cascadeId as a string. Anything in the
            // legacy file pre-dates step-index tracking, so the cascade was already
            // fully delivered to the user by the previous turn — pin maxStepIndex
            // high so the next turn skips the LS's history replay entirely.
            if (typeof entry === "string") {
                return { cascadeId: entry, maxStepIndex: Number.MAX_SAFE_INTEGER };
            }
            return entry;
        }
        catch { /* try next */ }
    }
    return undefined;
}
async function savePersistedSession(file, sessionId, entry) {
    try {
        let mapping = {};
        try {
            mapping = JSON.parse(await fs.readFile(file, "utf8"));
        }
        catch { /* fresh file */ }
        mapping[sessionId] = entry;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(mapping, null, 2) + "\n");
    }
    catch (err) {
        if (process.env.AGY_PROFILE_DEBUG) {
            // eslint-disable-next-line no-console
            console.error("[agy] failed to save session mapping:", err);
        }
    }
}
async function clearPersistedSession(file, sessionId) {
    try {
        let mapping;
        try {
            mapping = JSON.parse(await fs.readFile(file, "utf8"));
        }
        catch {
            return; /* nothing on disk */
        }
        if (!(sessionId in mapping))
            return;
        delete mapping[sessionId];
        await fs.writeFile(file, JSON.stringify(mapping, null, 2) + "\n");
    }
    catch (err) {
        if (process.env.AGY_PROFILE_DEBUG) {
            // eslint-disable-next-line no-console
            console.error("[agy] failed to clear session mapping:", err);
        }
    }
}
export function makeAgyProfile(opts = {}) {
    const cli = opts.cliPath?.trim() || resolveAgyBinary();
    const defaultModel = opts.defaultModel ?? "antigravity";
    const mappingFile = opts.dataDir
        ? path.join(opts.dataDir, "agy-sessions.json")
        : LEGACY_MAPPING_FILE;
    // Warm the model catalog cache in the background — first /seam model call
    // will read the cached promise instead of paying the ~5s spawn cost inline.
    void getCatalog(cli);
    return {
        id: "agy",
        displayName: "Antigravity",
        defaultModel,
        staticModels: opts.staticModels,
        threadAbbr: opts.threadAbbr,
        // agy bakes effort into the model choice (high/med/low model variants) —
        // there is no separate reasoning-effort knob, so the picker is suppressed.
        effort: { mechanism: "modelBaked", levels: [] },
        spawn() {
            return makeFakeAgyProcess(cli, mappingFile, opts.printTimeoutSeconds);
        },
        sessionManager: {
            async listSessions(cwd) {
                try {
                    const fileExists = await fs.access(mappingFile).then(() => true).catch(() => false);
                    if (!fileExists)
                        return [];
                    const data = await fs.readFile(mappingFile, "utf8");
                    const mapping = JSON.parse(data);
                    const summaries = [];
                    // Query seam.db as a fallback/source of truth for session directories
                    const seamDbSessions = new Set();
                    try {
                        const dataDir = process.env.DATA_DIR ?? "./data";
                        const seamDbPath = path.resolve(dataDir, "seam.db");
                        const db = new Database(seamDbPath);
                        try {
                            const rows = db.prepare("SELECT acp_session_id FROM sessions WHERE repo_path = ? AND agent_id = ?").all(cwd, 'agy');
                            for (const row of rows) {
                                if (row.acp_session_id) {
                                    seamDbSessions.add(row.acp_session_id);
                                }
                            }
                        }
                        finally {
                            db.close();
                        }
                    }
                    catch {
                        // ignore database lookup errors
                    }
                    for (const sessionId of Object.keys(mapping)) {
                        const entry = mapping[sessionId];
                        let cascadeId;
                        let entryCwd;
                        if (typeof entry === "string") {
                            cascadeId = entry;
                        }
                        else if (entry && typeof entry === "object") {
                            cascadeId = entry.cascadeId;
                            entryCwd = entry.cwd;
                        }
                        if (!cascadeId)
                            continue;
                        // Check if it belongs to this cwd
                        const matchesCwd = entryCwd
                            ? (entryCwd === cwd)
                            : seamDbSessions.has(sessionId);
                        if (!matchesCwd)
                            continue;
                        const transcriptFile = path.join(AGY_HOME, "brain", cascadeId, ".system_generated", "logs", "transcript.jsonl");
                        try {
                            const stat = await fs.stat(transcriptFile);
                            let createdAt = stat.birthtimeMs;
                            let lastActivityAt = stat.mtimeMs;
                            const content = await fs.readFile(transcriptFile, "utf8");
                            const lines = content.split("\n").filter(l => l.trim().length > 0);
                            const allMessages = [];
                            for (const line of lines) {
                                try {
                                    const entryObj = JSON.parse(line);
                                    const ts = entryObj.created_at ? Date.parse(entryObj.created_at) : undefined;
                                    if (entryObj.type === "USER_INPUT") {
                                        let text = entryObj.content || "";
                                        const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                                        if (match) {
                                            text = match[1].trim();
                                        }
                                        if (text.trim()) {
                                            allMessages.push({ sender: "human", text: text.trim(), timestamp: ts });
                                        }
                                    }
                                    else if (entryObj.type === "PLANNER_RESPONSE") {
                                        const text = entryObj.content || "";
                                        if (text.trim()) {
                                            allMessages.push({ sender: "agent", text: text.trim(), timestamp: ts });
                                        }
                                    }
                                }
                                catch {
                                    // ignore
                                }
                            }
                            const validTimestamps = allMessages
                                .map(m => m.timestamp)
                                .filter((t) => t !== undefined && !isNaN(t));
                            if (validTimestamps.length > 0) {
                                createdAt = validTimestamps[0];
                                lastActivityAt = validTimestamps[validTimestamps.length - 1];
                            }
                            let previewLines = [];
                            if (allMessages.length <= 16) {
                                previewLines = allMessages.map(m => ({ sender: m.sender, text: m.text }));
                            }
                            else {
                                const firstSix = allMessages.slice(0, 6);
                                const lastTen = allMessages.slice(-10);
                                previewLines = [...firstSix, ...lastTen].map(m => ({ sender: m.sender, text: m.text }));
                            }
                            const transcriptLines = [];
                            for (const m of allMessages) {
                                if (m.text.trim()) {
                                    const prefix = m.sender === "human" ? "### User\n" : "### Assistant\n";
                                    transcriptLines.push(`${prefix}${m.text.trim()}`);
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
                        catch {
                            // ignore if transcript file doesn't exist/can't be parsed
                        }
                    }
                    return summaries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
                }
                catch {
                    return [];
                }
            },
            async cloneSession(cwd, oldSessionId, newSessionId) {
                const fileExists = await fs.access(mappingFile).then(() => true).catch(() => false);
                if (!fileExists)
                    throw new Error("No sessions found to clone");
                const data = await fs.readFile(mappingFile, "utf8");
                const mapping = JSON.parse(data);
                const oldEntry = mapping[oldSessionId];
                if (!oldEntry)
                    throw new Error(`Old session ${oldSessionId} not found in mapping`);
                let oldCascadeId;
                let oldMaxStepIndex = -1;
                if (typeof oldEntry === "string") {
                    oldCascadeId = oldEntry;
                }
                else {
                    oldCascadeId = oldEntry.cascadeId;
                    oldMaxStepIndex = oldEntry.maxStepIndex;
                }
                const newCascadeId = randomUUID();
                // 1. Copy the conversation file (.db current format; .pb legacy).
                for (const ext of [".db", ".pb"]) {
                    try {
                        await fs.copyFile(path.join(CONVERSATION_DIR, `${oldCascadeId}${ext}`), path.join(CONVERSATION_DIR, `${newCascadeId}${ext}`));
                        break; // copied whichever exists
                    }
                    catch {
                        // try next extension / ignore if neither exists
                    }
                }
                // 2. Copy brain folder recursively
                const oldBrain = path.join(AGY_HOME, "brain", oldCascadeId);
                const newBrain = path.join(AGY_HOME, "brain", newCascadeId);
                try {
                    await fs.mkdir(newBrain, { recursive: true });
                    await fs.cp(oldBrain, newBrain, { recursive: true });
                }
                catch {
                    // ignore if brain folder doesn't exist
                }
                // 3. Update mapping
                mapping[newSessionId] = {
                    cascadeId: newCascadeId,
                    maxStepIndex: oldMaxStepIndex,
                    cwd,
                };
                await fs.writeFile(mappingFile, JSON.stringify(mapping, null, 2) + "\n");
            },
            async deleteSession(cwd, sessionId) {
                const fileExists = await fs.access(mappingFile).then(() => true).catch(() => false);
                if (!fileExists)
                    return;
                const data = await fs.readFile(mappingFile, "utf8");
                const mapping = JSON.parse(data);
                const entry = mapping[sessionId];
                if (!entry)
                    return;
                let cascadeId;
                if (typeof entry === "string") {
                    cascadeId = entry;
                }
                else {
                    cascadeId = entry.cascadeId;
                }
                // 1. Delete the conversation file(s) (.db current, .pb legacy).
                for (const ext of [".db", ".pb"]) {
                    try {
                        await fs.unlink(path.join(CONVERSATION_DIR, `${cascadeId}${ext}`));
                    }
                    catch {
                        // ignore
                    }
                }
                // 2. Delete brain folder
                const brainFolder = path.join(AGY_HOME, "brain", cascadeId);
                try {
                    await fs.rm(brainFolder, { recursive: true, force: true });
                }
                catch {
                    // ignore
                }
                // 3. Delete from mapping
                delete mapping[sessionId];
                await fs.writeFile(mappingFile, JSON.stringify(mapping, null, 2) + "\n");
            },
            async getTranscript(cwd, sessionId) {
                const fileExists = await fs.access(mappingFile).then(() => true).catch(() => false);
                if (!fileExists)
                    return "";
                const data = await fs.readFile(mappingFile, "utf8");
                const mapping = JSON.parse(data);
                const entry = mapping[sessionId];
                if (!entry)
                    return "";
                let cascadeId;
                if (typeof entry === "string") {
                    cascadeId = entry;
                }
                else {
                    cascadeId = entry.cascadeId;
                }
                const transcriptFile = path.join(AGY_HOME, "brain", cascadeId, ".system_generated", "logs", "transcript.jsonl");
                const content = await fs.readFile(transcriptFile, "utf8");
                const lines = content.split("\n").filter(l => l.trim().length > 0);
                const transcriptLines = [];
                for (const line of lines) {
                    try {
                        const entryObj = JSON.parse(line);
                        if (entryObj.type === "USER_INPUT") {
                            let text = entryObj.content || "";
                            const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                            if (match) {
                                text = match[1].trim();
                            }
                            if (text.trim()) {
                                transcriptLines.push(`### User\n${text.trim()}`);
                            }
                        }
                        else if (entryObj.type === "PLANNER_RESPONSE") {
                            const text = entryObj.content || "";
                            if (text.trim()) {
                                transcriptLines.push(`### Assistant\n${text.trim()}`);
                            }
                        }
                    }
                    catch {
                        // ignore
                    }
                }
                return transcriptLines.join("\n\n");
            },
        }
    };
}
function makeFakeAgyProcess(cli, mappingFile, printTimeoutSeconds) {
    const fakeStdin = new PassThrough(); // client writes here; we read from it
    const fakeStdout = new PassThrough(); // we write here; client reads from it
    const fakeStderr = new PassThrough();
    const emitter = new EventEmitter();
    let killed = false;
    const agent = new AgyAgent(cli, mappingFile, printTimeoutSeconds);
    const stream = ndJsonStream(Writable.toWeb(fakeStdout), Readable.toWeb(fakeStdin));
    // The constructor wires `conn` into the agent via the factory callback.
    new AgentSideConnection((conn) => {
        agent.bind(conn);
        return agent;
    }, stream);
    const fake = Object.assign(emitter, {
        stdin: fakeStdin,
        stdout: fakeStdout,
        stderr: fakeStderr,
        get killed() {
            return killed;
        },
        kill() {
            if (killed)
                return false;
            killed = true;
            agent.shutdown();
            fakeStdin.destroy();
            fakeStdout.push(null);
            fakeStderr.push(null);
            emitter.emit("exit", 0, null);
            return true;
        },
        pid: undefined,
    });
    return fake;
}
class AgyAgent {
    cli;
    mappingFile;
    printTimeoutSeconds;
    conn;
    sessions = new Map();
    active;
    constructor(cli, mappingFile, printTimeoutSeconds) {
        this.cli = cli;
        this.mappingFile = mappingFile;
        this.printTimeoutSeconds = printTimeoutSeconds;
    }
    bind(conn) {
        this.conn = conn;
    }
    async initialize(_params) {
        return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: {
                // agy takes a single text prompt, but we DO forward attachments: the
                // mapper inlines text files as `resource` blocks (advertise
                // embeddedContext so it inlines rather than emitting an un-fetchable
                // resource_link), and flattenPrompt folds their text into the prompt.
                // Binary files are staged to a path (orchestrator) that agy reads via
                // the staging --add-dir below. No image capability (agy CLI is text-in).
                promptCapabilities: { embeddedContext: true },
                loadSession: true,
            },
            authMethods: [],
        };
    }
    async authenticate(_params) {
        return {};
    }
    async newSession(params) {
        const id = randomUUID();
        this.sessions.set(id, { cwd: params.cwd, maxStepIndex: -1 });
        const catalog = await getCatalog(this.cli).catch(() => []);
        if (catalog.length === 0) {
            return { sessionId: id };
        }
        return {
            sessionId: id,
            models: {
                availableModels: catalog.map((e) => ({
                    modelId: e.modelId,
                    name: pickerLabel(e),
                })),
                currentModelId: readCurrentModelId(catalog),
            },
        };
    }
    async loadSession(params) {
        const persisted = await loadPersistedSession(this.mappingFile, params.sessionId);
        this.sessions.set(params.sessionId, {
            cwd: params.cwd,
            cascadeId: persisted?.cascadeId,
            maxStepIndex: persisted?.maxStepIndex ?? -1,
        });
        const catalog = await getCatalog(this.cli).catch(() => []);
        if (catalog.length === 0) {
            return {};
        }
        return {
            models: {
                availableModels: catalog.map((e) => ({
                    modelId: e.modelId,
                    name: pickerLabel(e),
                })),
                currentModelId: readCurrentModelId(catalog),
            },
        };
    }
    async setSessionMode(_params) {
        return {};
    }
    async unstable_setSessionModel(params) {
        // agy reads its active model from ~/.gemini/antigravity-cli/settings.json
        // at every CLI invocation. Since we spawn a fresh `agy -p` per prompt,
        // editing that file takes effect on the next turn.
        const catalog = await getCatalog(this.cli).catch(() => []);
        const entry = catalog.find((e) => e.modelId === params.modelId);
        if (!entry)
            return {};
        try {
            let json = {};
            try {
                json = JSON.parse(fsSync.readFileSync(SETTINGS_FILE, "utf8"));
            }
            catch { /* fresh settings */ }
            json["model"] = entry.rawDisplayName;
            fsSync.writeFileSync(SETTINGS_FILE, JSON.stringify(json, null, 2) + "\n");
        }
        catch (err) {
            if (process.env.AGY_PROFILE_DEBUG) {
                // eslint-disable-next-line no-console
                console.error("[agy] setSessionModel failed:", err);
            }
        }
        return {};
    }
    async prompt(params) {
        if (!this.conn)
            throw new Error("ACP connection not bound");
        const sess = this.sessions.get(params.sessionId);
        if (!sess) {
            throw RequestError.invalidParams({
                details: `unknown session ${params.sessionId}`,
            });
        }
        const promptText = flattenPrompt(params.prompt);
        if (!promptText.trim()) {
            return { stopReason: "end_turn" };
        }
        // Cancel any prior run for this session before starting a new one.
        if (this.active?.sessionId === params.sessionId) {
            this.active.userCancelled = true;
            try {
                this.active.proc.kill();
            }
            catch { }
            this.active.abort.abort();
            this.active = undefined;
        }
        const before = await listConversations();
        const agyStart = Date.now();
        const args = [
            "-p",
            promptText,
            "--print-timeout",
            `${this.printTimeoutSeconds ?? 600}s`,
            "--dangerously-skip-permissions",
            // agy ignores the process cwd for its "workspace" — that's controlled
            // separately via --add-dir. Without this, file tools default to $HOME
            // and report "no active workspace set".
            "--add-dir",
            sess.cwd,
            // Also expose the attachment staging dir so agy can read files we staged
            // there (PDFs/binaries we reference by path in the prompt text).
            "--add-dir",
            STAGING_ROOT,
        ];
        if (sess.cascadeId) {
            args.push("--conversation", sess.cascadeId);
        }
        if (process.env.AGY_PROFILE_DEBUG) {
            // eslint-disable-next-line no-console
            console.error(`[agy] spawn ${this.cli} cwd=${sess.cwd} args=${JSON.stringify(args)}`);
        }
        const proc = spawn(this.cli, args, {
            cwd: sess.cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stderrChunks = [];
        proc.stdout?.on("data", () => { }); // drain; we get the real output via gRPC
        proc.stderr?.on("data", (c) => stderrChunks.push(c));
        // Two independent signals:
        //   `cancelAbort` — external cancel from the ACP client (session/cancel).
        //   `procExited` — agy itself finished; the LS will close the stream
        //     naturally afterward, so we don't need to abort fetch on its own.
        const cancelAbort = new AbortController();
        let procExited = false;
        let exitCode = null;
        this.active = { proc, abort: cancelAbort, sessionId: params.sessionId };
        const runRef = this.active;
        proc.once("exit", (code, signal) => {
            if (process.env.AGY_PROFILE_DEBUG) {
                // eslint-disable-next-line no-console
                console.error(`[agy] child exit code=${code} signal=${signal}`);
            }
            procExited = true;
            exitCode = code;
            cancelAbort.abort();
            if (this.active === runRef)
                this.active = undefined;
        });
        proc.once("error", (e) => {
            if (process.env.AGY_PROFILE_DEBUG) {
                // eslint-disable-next-line no-console
                console.error(`[agy] child error`, e);
            }
            cancelAbort.abort();
            if (this.active === runRef)
                this.active = undefined;
        });
        try {
            const ls = await discoverAgyLs({
                timeoutMs: 30_000,
                newerThanMs: agyStart - 1_000,
                signal: cancelAbort.signal,
            });
            const cid = sess.cascadeId ?? (await waitForNewCascade(before, cancelAbort.signal));
            if (!sess.cascadeId) {
                sess.cascadeId = cid;
                await savePersistedSession(this.mappingFile, params.sessionId, {
                    cascadeId: cid,
                    maxStepIndex: sess.maxStepIndex,
                    cwd: sess.cwd,
                });
            }
            const lastText = new Map();
            const lastThinking = new Map();
            const heldText = new Map();
            const heldThinking = new Map();
            const toolCallIds = new Map();
            // High-water mark from prior turns. The LS replays every step at or
            // below this on subscribe — skip them so the user doesn't see the entire
            // previous conversation repeated. Anything strictly above is new.
            const skipUpTo = sess.maxStepIndex;
            const catalog = await getCatalog(this.cli).catch(() => []);
            const currentModelId = readCurrentModelId(catalog);
            const currentModel = catalog.find((m) => m.modelId === currentModelId);
            const maxTokens = currentModel?.maxTokens ?? 1_000_000;
            const usageTracker = { maxUsed: 0 };
            try {
                let hasBeenActive = false;
                for await (const update of subscribeToAgyStream({
                    port: ls.port,
                    conversationId: cid,
                    signal: cancelAbort.signal,
                })) {
                    if (cancelAbort.signal.aborted)
                        break;
                    const isRunning = update.status === "CASCADE_RUN_STATUS_RUNNING";
                    const sup = update.mainTrajectoryUpdate?.stepsUpdate;
                    let hasNewSteps = false;
                    if (sup?.indices && sup.steps) {
                        for (let i = 0; i < sup.indices.length; i++) {
                            const idx = sup.indices[i];
                            const step = sup.steps[i];
                            if (idx !== undefined && step !== undefined && idx > skipUpTo) {
                                if (step.type &&
                                    step.type !== "CORTEX_STEP_TYPE_USER_INPUT" &&
                                    step.type !== "CORTEX_STEP_TYPE_CONVERSATION_HISTORY") {
                                    hasNewSteps = true;
                                }
                            }
                        }
                    }
                    if (isRunning || hasNewSteps) {
                        hasBeenActive = true;
                    }
                    if (sup?.indices && sup.steps) {
                        for (let i = 0; i < sup.indices.length; i++) {
                            const idx = sup.indices[i];
                            const step = sup.steps[i];
                            if (idx === undefined || step === undefined)
                                continue;
                            if (idx <= skipUpTo)
                                continue;
                            await this.emitStep(params.sessionId, idx, step, lastText, lastThinking, toolCallIds, heldText, heldThinking, sess.cwd, maxTokens, usageTracker);
                            if (idx > sess.maxStepIndex)
                                sess.maxStepIndex = idx;
                        }
                    }
                    const isIdle = update.status === "CASCADE_RUN_STATUS_IDLE" || update.fullyIdle === true;
                    if (isIdle && hasBeenActive) {
                        if (process.env.AGY_PROFILE_DEBUG) {
                            // eslint-disable-next-line no-console
                            console.error(`[agy] cascade run completed and idle. Breaking stream loop.`);
                        }
                        break;
                    }
                }
            }
            catch (streamErr) {
                // The LS closes the socket after the cascade reaches IDLE; undici
                // surfaces that as `TypeError: terminated` (incomplete chunked
                // read) since Connect doesn't always send a final HTTP trailer.
                // Treat any post-subscribe stream error as natural EOF — except
                // for an explicit user cancel.
                if (cancelAbort.signal.aborted && runRef.userCancelled) {
                    return { stopReason: "cancelled" };
                }
                if (process.env.AGY_PROFILE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.error(`[agy] stream ended:`, streamErr instanceof Error ? streamErr.message : streamErr);
                }
                // Fall through to end_turn — agy completed and the LS closed.
            }
            // Flush any text held back as a potentially-partial pattern.
            await this.flushHeld(params.sessionId, heldText, "agent_message_chunk", sess.cwd);
            await this.flushHeld(params.sessionId, heldThinking, "agent_thought_chunk", sess.cwd);
            // Persist the new high-water mark so the next turn (or a restart) can
            // skip everything we've already emitted.
            if (sess.cascadeId && sess.maxStepIndex > skipUpTo) {
                await savePersistedSession(this.mappingFile, params.sessionId, {
                    cascadeId: sess.cascadeId,
                    maxStepIndex: sess.maxStepIndex,
                    cwd: sess.cwd,
                });
            }
        }
        catch (err) {
            if (cancelAbort.signal.aborted && runRef.userCancelled)
                return { stopReason: "cancelled" };
            if (cancelAbort.signal.aborted && !runRef.userCancelled) {
                // Swallowed because the child process exited normally or abnormally,
                // and we aborted the stream/discovery deliberately.
                if (process.env.AGY_PROFILE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.error(`[agy] run aborted due to process exit:`, err);
                }
            }
            else {
                const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
                if (stderr) {
                    await this.conn.sessionUpdate({
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: `\n[agy error]\n${stderr.slice(0, 2000)}` },
                        },
                    }).catch(() => { });
                }
                throw err;
            }
        }
        finally {
            if (!procExited) {
                if (process.env.AGY_PROFILE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.error(`[agy] killing active child process on prompt completion`);
                }
                try {
                    proc.kill();
                }
                catch {
                    // ignore
                }
            }
            if (this.active === runRef)
                this.active = undefined;
        }
        if (exitCode !== null && exitCode !== 0) {
            const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
            if (stderr) {
                await this.conn.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: `\n[agy exit ${exitCode}]\n${stderr.slice(0, 2000)}` },
                    },
                }).catch(() => { });
            }
        }
        return { stopReason: "end_turn" };
    }
    async cancel(params) {
        const wasActive = this.active?.sessionId === params.sessionId;
        if (wasActive && this.active) {
            this.active.userCancelled = true;
            this.active.abort.abort();
            try {
                this.active.proc.kill();
            }
            catch { }
        }
        if (!wasActive)
            return;
        // The aborted cascade gets parked in a "done" state in agy's LS, so
        // rejoining it on the next prompt yields an immediate empty stream
        // (chars:0, ~4s turns). Clear the cascadeId + step high-water so the
        // next prompt allocates a fresh cascade via waitForNewCascade.
        const sess = this.sessions.get(params.sessionId);
        if (sess) {
            sess.cascadeId = undefined;
            sess.maxStepIndex = -1;
        }
        await clearPersistedSession(this.mappingFile, params.sessionId);
    }
    shutdown() {
        if (this.active) {
            this.active.userCancelled = true;
            try {
                this.active.proc.kill();
            }
            catch { }
            this.active.abort.abort();
            this.active = undefined;
        }
    }
    // -----------------------------------------------------------------------
    // Step → ACP translation
    // -----------------------------------------------------------------------
    async emitStep(sessionId, idx, step, lastText, lastThinking, toolCallIds, heldText, heldThinking, cwd, maxTokens, usageTracker) {
        if (!this.conn)
            return;
        if (step.metadata?.modelUsage) {
            const u = step.metadata.modelUsage;
            const input = parseInt(u.inputTokens ?? "0", 10) || 0;
            const output = parseInt(u.outputTokens ?? "0", 10) || 0;
            const used = input + output;
            if (used > usageTracker.maxUsed) {
                usageTracker.maxUsed = used;
                if (maxTokens > 0) {
                    await this.conn.sessionUpdate({
                        sessionId,
                        update: {
                            sessionUpdate: "usage_update",
                            used,
                            size: maxTokens,
                        }
                    }).catch(() => { });
                }
            }
        }
        const type = step.type ?? "";
        if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
            // Stream thinking deltas before visible text — agy fills them in that
            // order, so consumers see "thinking…" before the answer arrives.
            const thinking = step.plannerResponse?.thinking ?? "";
            const prevTh = lastThinking.get(idx) ?? "";
            if (thinking.length > prevTh.length) {
                const delta = thinking.slice(prevTh.length);
                lastThinking.set(idx, thinking);
                await this.emitTextChunk(sessionId, idx, delta, heldThinking, "agent_thought_chunk", cwd);
            }
            const text = step.plannerResponse?.modifiedResponse ?? "";
            const prevTx = lastText.get(idx) ?? "";
            if (text.length > prevTx.length) {
                const delta = text.slice(prevTx.length);
                lastText.set(idx, text);
                await this.emitTextChunk(sessionId, idx, delta, heldText, "agent_message_chunk", cwd);
            }
            return;
        }
        // Skip internal trajectory steps — they're noise to a chat consumer.
        if (type === "CORTEX_STEP_TYPE_USER_INPUT" ||
            type === "CORTEX_STEP_TYPE_CONVERSATION_HISTORY" ||
            type === "CORTEX_STEP_TYPE_CHECKPOINT") {
            return;
        }
        // Generated images: agy writes the file to its brain dir and assumes the
        // host UI (the Antigravity IDE) can read it from there. Our chat pipeline
        // can't — we need to read the file and surface it as an ACP `image`
        // content block so agent-runtime can route it through to Discord.
        if (type === "CORTEX_STEP_TYPE_GENERATE_IMAGE") {
            await this.emitGeneratedImageBlock(sessionId, step);
            return;
        }
        // Anything else (VIEW_FILE, RUN_COMMAND, …) becomes a tool call.
        const status = mapToolStatus(step.status);
        const title = toolTitle(step);
        let toolCallId = toolCallIds.get(idx);
        if (!toolCallId) {
            toolCallId = `agy-step-${idx}`;
            toolCallIds.set(idx, toolCallId);
            await this.conn.sessionUpdate({
                sessionId,
                update: {
                    sessionUpdate: "tool_call",
                    toolCallId,
                    title,
                    status,
                    kind: "other",
                },
            });
        }
        else {
            await this.conn.sessionUpdate({
                sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId,
                    ...(title ? { title } : {}),
                    status,
                },
            });
        }
    }
    /**
     * Pull the generated image path out of a GENERATE_IMAGE step's content
     * text, read the bytes off disk, and emit them as an ACP `image` content
     * block on `agent_message_chunk`. The content text follows the shape:
     *     "Generated image is saved at <absolute-path>."
     */
    async emitGeneratedImageBlock(sessionId, step) {
        if (!this.conn)
            return;
        const content = typeof step.content === "string" ? step.content : "";
        const m = content.match(/saved at\s+(\S+\.(?:png|jpe?g|gif|webp|svg))/i);
        const imagePath = m?.[1];
        if (!imagePath) {
            if (process.env.AGY_PROFILE_DEBUG) {
                // eslint-disable-next-line no-console
                console.error("[agy] GENERATE_IMAGE step had no parseable file path");
            }
            return;
        }
        let data;
        try {
            const buf = await fs.readFile(imagePath);
            data = buf.toString("base64");
        }
        catch (err) {
            if (process.env.AGY_PROFILE_DEBUG) {
                // eslint-disable-next-line no-console
                console.error("[agy] failed to read generated image:", imagePath, err);
            }
            return;
        }
        const ext = imagePath.toLowerCase().split(".").pop() ?? "";
        const mimeType = ext === "png" ? "image/png" :
            ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
                ext === "gif" ? "image/gif" :
                    ext === "webp" ? "image/webp" :
                        ext === "svg" ? "image/svg+xml" :
                            "application/octet-stream";
        await this.conn.sessionUpdate({
            sessionId,
            update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "image", data, mimeType, uri: `file://${imagePath}` },
            },
        });
    }
    /**
     * Append `delta` to any previously-held tail for `idx`, emit the safe
     * portion (transformed for Discord), and re-hold whatever might still be
     * mid-pattern (unclosed markdown link or partial cwd prefix).
     */
    async emitTextChunk(sessionId, idx, delta, held, updateType, cwd) {
        if (!this.conn)
            return;
        const combined = (held.get(idx) ?? "") + delta;
        const safeLen = findSafeBoundary(combined, cwd);
        const safe = combined.slice(0, safeLen);
        held.set(idx, combined.slice(safeLen));
        if (!safe)
            return;
        // Visible agent text may embed local images via markdown (e.g. agy
        // emitting `![alt](/abs/path.png)` to reference a file it wrote to its
        // brain dir). Pull each such reference out, emit the bytes as a separate
        // image content block, and strip the markdown so the surviving text
        // isn't littered with broken path-only links in Discord.
        const { textWithoutImages, imagesToEmit } = updateType === "agent_message_chunk"
            ? await extractInlineImagePaths(safe)
            : { textWithoutImages: safe, imagesToEmit: [] };
        for (const img of imagesToEmit) {
            await this.conn.sessionUpdate({
                sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                        type: "image",
                        data: img.data,
                        mimeType: img.mimeType,
                        uri: `file://${img.path}`,
                    },
                },
            });
        }
        const transformed = transformAgyText(textWithoutImages, cwd);
        if (!transformed)
            return;
        await this.conn.sessionUpdate({
            sessionId,
            update: { sessionUpdate: updateType, content: { type: "text", text: transformed } },
        });
    }
    /** Emit any text held back as a potentially-partial pattern. */
    async flushHeld(sessionId, held, updateType, cwd) {
        if (!this.conn)
            return;
        for (const tail of held.values()) {
            if (!tail)
                continue;
            const { textWithoutImages, imagesToEmit } = updateType === "agent_message_chunk"
                ? await extractInlineImagePaths(tail)
                : { textWithoutImages: tail, imagesToEmit: [] };
            for (const img of imagesToEmit) {
                await this.conn.sessionUpdate({
                    sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: {
                            type: "image",
                            data: img.data,
                            mimeType: img.mimeType,
                            uri: `file://${img.path}`,
                        },
                    },
                });
            }
            const transformed = transformAgyText(textWithoutImages, cwd);
            if (!transformed)
                continue;
            await this.conn.sessionUpdate({
                sessionId,
                update: { sessionUpdate: updateType, content: { type: "text", text: transformed } },
            });
        }
        held.clear();
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function flattenPrompt(blocks) {
    const parts = [];
    for (const b of blocks) {
        if (b.type === "text") {
            if (b.text)
                parts.push(b.text);
        }
        else if (b.type === "resource") {
            // Text attachments arrive inlined as a resource with `.text` — fold the
            // file content into the prompt so agy actually sees it (previously these
            // were dropped, so an attached text file was invisible to agy).
            const r = b.resource;
            const name = r.uri ? r.uri.replace(/^attachment:\/\//, "") : "file";
            if ("text" in r && typeof r.text === "string") {
                parts.push(`[Attached file: ${name}]\n${r.text}`);
            }
            else {
                parts.push(`[Attached file: ${name} — binary content not inlined]`);
            }
        }
        else if (b.type === "resource_link") {
            const name = b.name ?? b.uri;
            parts.push(`[Attached file referenced: ${name}]`);
        }
        // image/audio: agy CLI is text-only (no vision) — skip.
    }
    return parts.join("\n");
}
function mapToolStatus(s) {
    switch (s) {
        case "CORTEX_STEP_STATUS_DONE":
            return "completed";
        case "CORTEX_STEP_STATUS_WAITING":
            return "pending";
        case "CORTEX_STEP_STATUS_FAILED":
        case "CORTEX_STEP_STATUS_ERROR":
            return "failed";
        default:
            return "in_progress";
    }
}
function toolTitle(step) {
    const t = step.type ?? "";
    return t.replace(/^CORTEX_STEP_TYPE_/, "").replace(/_/g, " ").toLowerCase();
}
/** Scan an agent message for `![label](path)` markdown image references.
 *  For each match whose path resolves to an existing local image file,
 *  read+base64-encode the bytes and remove the markdown from the text.
 *  Other matches (broken paths, non-images) are left intact so the user
 *  still sees the agent's intended formatting. */
async function extractInlineImagePaths(text) {
    const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        matches.push({ full: m[0], pathRef: m[2] });
    }
    if (matches.length === 0) {
        return { textWithoutImages: text, imagesToEmit: [] };
    }
    const imagesToEmit = [];
    let textWithoutImages = text;
    for (const { full, pathRef } of matches) {
        const cleanPath = pathRef.startsWith("file://")
            ? decodeURIComponent(pathRef.slice("file://".length))
            : pathRef;
        if (!path.isAbsolute(cleanPath))
            continue;
        const ext = cleanPath.toLowerCase().split(".").pop() ?? "";
        const mimeType = ext === "png" ? "image/png" :
            ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
                ext === "gif" ? "image/gif" :
                    ext === "webp" ? "image/webp" :
                        ext === "svg" ? "image/svg+xml" :
                            "";
        if (!mimeType)
            continue;
        try {
            const buf = await fs.readFile(cleanPath);
            imagesToEmit.push({
                path: cleanPath,
                data: buf.toString("base64"),
                mimeType,
            });
            textWithoutImages = textWithoutImages.replace(full, "").replace(/\n{3,}/g, "\n\n");
        }
        catch {
            // Path doesn't resolve — leave the markdown intact for the user to see.
        }
    }
    return { textWithoutImages, imagesToEmit };
}
function findSafeBoundary(text, cwd) {
    let safe = text.length;
    const lastOpenBracket = text.lastIndexOf("[");
    if (lastOpenBracket !== -1) {
        const after = text.slice(lastOpenBracket);
        if (!/\]\([^)]*\)/.test(after)) {
            // If the bracket is preceded by `!`, hold back from the `!` so the
            // full `![label](path)` image markdown stays atomic across delta
            // boundaries — otherwise the `!` ships in an earlier safe chunk and
            // image extraction can't recognise the resulting `[…](…)` as an
            // image (it looks like a normal link).
            const start = lastOpenBracket > 0 && text[lastOpenBracket - 1] === "!"
                ? lastOpenBracket - 1
                : lastOpenBracket;
            safe = Math.min(safe, start);
        }
    }
    const minStart = Math.max(0, text.length - cwd.length);
    for (let i = minStart; i < text.length; i++) {
        if (cwd.startsWith(text.slice(i))) {
            safe = Math.min(safe, i);
            break;
        }
    }
    return safe;
}
/**
 * Discord-friendly rewrites of agy output:
 *   `[label](file:///abs/path)` →
 *     - inside cwd  → `` `label` (`relative/path`) ``
 *     - outside cwd → `` `label` `` (the absolute path is noise — usually agy's
 *                     internal brain dir — and Discord can't render file:// anyway)
 *   bare absolute paths under cwd → relative paths
 *   bare cwd alone                → basename of cwd (reads naturally in prose)
 */
function transformAgyText(text, cwd) {
    const cwdNorm = cwd.replace(/\/+$/, "");
    text = text.replace(/\[([^\]]+)\]\(file:\/\/([^)]+)\)/g, (_match, label, urlPath) => {
        let p;
        try {
            p = decodeURIComponent(urlPath);
        }
        catch {
            p = urlPath;
        }
        if (p === cwdNorm)
            return `\`${label}\``;
        if (p.startsWith(cwdNorm + "/")) {
            const rel = p.slice(cwdNorm.length + 1);
            // When the label is just the file's basename it adds no new info;
            // collapse to the relative path to avoid awkward `name` (`path/to/name`).
            if (label === path.basename(rel))
                return `\`${rel}\``;
            return `\`${label}\` (\`${rel}\`)`;
        }
        return `\`${label}\``;
    });
    const cwdEsc = cwdNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const base = path.basename(cwdNorm);
    text = text.replace(new RegExp(`${cwdEsc}(/[\\w./\\-]*)?`, "g"), (_match, sub) => (sub ? sub.slice(1) : base));
    return text;
}
/**
 * Locate the agy binary. The official installer (`agy install`) puts it at
 * `~/.local/bin/agy` and updates the user's shell rc, but the bot often runs
 * under a daemon (systemd / pm2) where that PATH isn't loaded. Fall back to
 * the known install path so the profile works out of the box; let the user
 * override via `cliPath` if their install is elsewhere.
 */
function resolveAgyBinary() {
    const home = process.env.HOME ?? os.homedir();
    const candidate = path.join(home, ".local/bin/agy");
    try {
        if (fsSync.statSync(candidate).isFile())
            return candidate;
    }
    catch {
        /* fall through */
    }
    return "agy";
}
async function listConversations() {
    try {
        const names = await fs.readdir(CONVERSATION_DIR);
        return new Set(names);
    }
    catch {
        return new Set();
    }
}
async function waitForNewCascade(before, signal) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (signal.aborted)
            throw new Error("aborted waiting for new cascade");
        const now = await listConversations();
        for (const name of now) {
            // agy switched conversation files from `.pb` to `.db` (CLI update ~2026-06);
            // match both so a fresh turn detects its new cascade and persists the id.
            // Both extensions are 3 chars. (Sqlite sidecars end in `.db-wal`/`.db-shm`,
            // not `.db`, so they're correctly ignored.)
            if (!before.has(name) && (name.endsWith(".db") || name.endsWith(".pb"))) {
                return name.slice(0, -3);
            }
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("no new agy conversation appeared within 30s — is `agy` installed and logged in?");
}
let catalogPromise = null;
function getCatalog(cli) {
    if (catalogPromise)
        return catalogPromise;
    const p = fetchAgyCatalog(cli)
        .then((rows) => {
        // Don't PIN an empty result. A cold-start LS (or any transient empty
        // response) would otherwise poison this module-level cache for the whole
        // process lifetime, leaving the model picker permanently empty for every
        // agy session — direct /seam model AND the new-thread wizard both read it.
        // Only memoize a real catalog; reset so the next caller retries.
        if (rows.length === 0) {
            catalogPromise = null;
            console.error("[agy] catalog fetch returned no usable models — not caching; will retry");
        }
        return rows;
    })
        .catch((err) => {
        // Don't pin the cache to an error — let the next caller retry.
        catalogPromise = null;
        console.error("[agy] catalog fetch failed:", err);
        return [];
    });
    catalogPromise = p;
    return catalogPromise;
}
// Cache the usage snapshot briefly so repeated `/seam usage` calls don't pay
// the ~5s LS spawn cost. 60s strikes a balance between freshness and snappiness.
const USAGE_CACHE_TTL_MS = 60_000;
let usageCache = null;
/**
 * Fetch the current user's Antigravity usage snapshot. Spawns a transient
 * `agy -p` to bring the local LS up, hits `GetUserStatus`, and parses the
 * response. Cached for {@link USAGE_CACHE_TTL_MS} after a successful call.
 */
export async function fetchAgyUserStatus(cliPath) {
    if (usageCache && Date.now() - usageCache.at < USAGE_CACHE_TTL_MS) {
        return usageCache.data;
    }
    const cli = cliPath?.trim() || resolveAgyBinary();
    const start = Date.now();
    const proc = spawn(cli, ["-p", "ok", "--print-timeout", "30s", "--dangerously-skip-permissions"], {
        cwd: "/tmp",
        stdio: ["ignore", "ignore", "ignore"],
    });
    try {
        const ls = await discoverAgyLs({
            timeoutMs: 15_000,
            newerThanMs: start - 1_000,
        });
        // /healthz comes up before the LS finishes silent-auth, so GetUserStatus
        // initially 500s with "GetCascadeModelConfigData() is nil". Retry briefly
        // until auth lands (usually 1–2s).
        const url = `http://localhost:${ls.port}/exa.language_server_pb.LanguageServerService/GetUserStatus`;
        const deadline = Date.now() + 10_000;
        let lastStatus = 0;
        while (Date.now() < deadline) {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            if (res.ok) {
                const json = (await res.json());
                const data = parseAgyUserStatus(json);
                usageCache = { at: Date.now(), data };
                return data;
            }
            lastStatus = res.status;
            if (res.status !== 500)
                break;
            await new Promise((r) => setTimeout(r, 400));
        }
        throw new Error(`GetUserStatus HTTP ${lastStatus}`);
    }
    finally {
        try {
            proc.kill();
        }
        catch { /* already gone */ }
    }
}
function parseAgyUserStatus(json) {
    const us = json.userStatus ?? {};
    const ps = us.planStatus ?? {};
    const pi = ps.planInfo ?? {};
    const num = (v) => typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : undefined;
    const models = (us.cascadeModelConfigData?.clientModelConfigs ?? [])
        .filter((m) => m.label)
        .map((m) => ({
        label: m.label,
        ...(typeof m.quotaInfo?.remainingFraction === "number"
            ? { remainingFraction: m.quotaInfo.remainingFraction }
            : {}),
        ...(m.quotaInfo?.resetTime ? { resetTime: m.quotaInfo.resetTime } : {}),
    }));
    return {
        ...(us.name ? { name: us.name } : {}),
        ...(us.email ? { email: us.email } : {}),
        ...(pi.planName ? { planName: pi.planName } : {}),
        ...(pi.teamsTier ? { teamsTier: pi.teamsTier } : {}),
        ...(num(pi.monthlyPromptCredits) !== undefined
            ? { monthlyPromptCredits: num(pi.monthlyPromptCredits) }
            : {}),
        ...(num(ps.availablePromptCredits) !== undefined
            ? { availablePromptCredits: num(ps.availablePromptCredits) }
            : {}),
        ...(num(pi.monthlyFlowCredits) !== undefined
            ? { monthlyFlowCredits: num(pi.monthlyFlowCredits) }
            : {}),
        ...(num(ps.availableFlowCredits) !== undefined
            ? { availableFlowCredits: num(ps.availableFlowCredits) }
            : {}),
        models,
    };
}
async function fetchAgyCatalog(cli) {
    // Spawn a tiny agy turn just to bring the LS up. The "ok" prompt produces
    // a few tokens of throwaway output; the cost is acceptable given the result
    // is cached for the process lifetime.
    const start = Date.now();
    const proc = spawn(cli, ["-p", "ok", "--print-timeout", "30s", "--dangerously-skip-permissions"], {
        cwd: "/tmp",
        stdio: ["ignore", "ignore", "ignore"],
    });
    try {
        const ls = await discoverAgyLs({
            timeoutMs: 15_000,
            newerThanMs: start - 1_000,
        });
        const url = `http://localhost:${ls.port}/exa.language_server_pb.LanguageServerService/GetAvailableModels`;
        // The LS answers as soon as it's discovered, but its model catalog finishes
        // loading a beat later (~1-2s): query too early and `response.models` is
        // empty/internal-only, so parseAgyCatalog yields nothing — which the caller
        // then refuses to cache, leaving the picker permanently empty. Poll until
        // the catalog has usable models. Returns whatever we last parsed if warmup
        // never completes within the deadline (caller treats [] as "retry later").
        const deadline = Date.now() + 12_000;
        let last = [];
        for (;;) {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            if (res.ok) {
                const json = (await res.json());
                last = parseAgyCatalog(json);
                if (last.length > 0)
                    return last;
            }
            if (Date.now() >= deadline)
                return last;
            await new Promise((r) => setTimeout(r, 400));
        }
    }
    finally {
        try {
            proc.kill();
        }
        catch { /* already gone */ }
    }
}
function parseAgyCatalog(json) {
    const models = json.response?.models ?? {};
    const rows = [];
    for (const [id, m] of Object.entries(models)) {
        if (m.isInternal || !m.displayName)
            continue;
        rows.push({
            modelId: id,
            rawDisplayName: m.displayName,
            displayName: cleanAgyDisplayName(m.displayName),
            ctx: formatTokens(m.maxTokens ?? 0),
            recommended: !!m.recommended,
            supportsThinking: !!m.supportsThinking,
            supportsImages: !!m.supportsImages,
            maxTokens: m.maxTokens ?? 0,
        });
    }
    // Antigravity ships multiple ids with the same displayName (rebrand aliases
    // and stale labels). Pick the id whose slug best matches the displayName so
    // the picker doesn't show literal duplicates.
    const byName = new Map();
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const score = (r) => {
        const a = slug(r.rawDisplayName);
        const b = slug(r.modelId);
        let s = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++)
            if (a[i] === b[i])
                s++;
        return s;
    };
    for (const r of rows) {
        const prev = byName.get(r.rawDisplayName);
        if (!prev || score(r) > score(prev))
            byName.set(r.rawDisplayName, r);
    }
    return [...byName.values()].sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.displayName.localeCompare(b.displayName));
}
const TIER_ICON = { high: "🔼", medium: "▶️", low: "🔽" };
function cleanAgyDisplayName(s) {
    // "(Thinking)" is redundant — we already show 🧠 in the label suffix.
    let out = s.replace(/\s*\(Thinking\)\s*$/i, "");
    out = out.replace(/\s*\((High|Medium|Low)\)\s*$/i, (_m, t) => ` ${TIER_ICON[t.toLowerCase()] ?? ""}`);
    return out.trim();
}
function formatTokens(n) {
    if (!n)
        return "—";
    if (n >= 1_000_000)
        return (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0).replace(/\.0$/, "") + "M";
    if (n >= 1_000)
        return Math.round(n / 1_000) + "K";
    return String(n);
}
function pickerLabel(e) {
    const caps = [e.supportsThinking ? "🧠" : "", e.supportsImages ? "🖼️" : ""].filter(Boolean).join("");
    return `${e.recommended ? "★ " : ""}${e.displayName} — 🪟${e.ctx}${caps ? " " + caps : ""}`;
}
function readCurrentModelId(catalog) {
    try {
        const raw = fsSync.readFileSync(SETTINGS_FILE, "utf8");
        const dn = JSON.parse(raw).model;
        if (typeof dn === "string") {
            const match = catalog.find((e) => e.rawDisplayName === dn);
            if (match)
                return match.modelId;
        }
    }
    catch { /* fall through to default */ }
    return catalog.find((e) => e.recommended)?.modelId ?? catalog[0]?.modelId ?? "";
}
//# sourceMappingURL=agy.js.map