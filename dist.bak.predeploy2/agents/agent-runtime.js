import { Readable, Writable } from "node:stream";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, RequestError, } from "@agentclientprotocol/sdk";
import { mapAttachmentsToBlocks, } from "./attachments.js";
import { blockToFile } from "./agent-content.js";
import { SerialQueue } from "../core/serial-queue.js";
/** ACP select options may be a flat list of options or a list of groups; this
 *  flattens either shape to the leaf options. */
function flattenConfigSelectOptions(options) {
    return options.flatMap((o) => ("options" in o ? o.options : [o]));
}
/**
 * Owns one ACP child process and (optionally) one ACP session.
 *
 * Lifecycle:
 *   start() → newSession()/loadSession() → prompt()… → cancel()/dispose()
 *
 * One AgentRuntime per chat thread. The chat layer fans events to the user via
 * a single onEvent handler (set with `onEvent`).
 */
/**
 * How long to wait for ACP `initialize` and `session/new` to complete
 * before treating the agent as wedged. Generous (45s) to allow for
 * slow npm-installed adapters to bootstrap on first run, but bounded
 * enough that a wedge surfaces an actionable error instead of a
 * 15-minute Discord deferred-reply timeout.
 */
const START_TIMEOUT_MS = 45_000;
const NEW_SESSION_TIMEOUT_MS = 45_000;
function withTimeout(ms, message) {
    return new Promise((_resolve, reject) => {
        const t = setTimeout(() => reject(new Error(message)), ms);
        if (typeof t.unref === "function")
            t.unref();
    });
}
export class AgentRuntime {
    profile;
    logger;
    permissionPolicy;
    mcpServers;
    onDead;
    child;
    connection;
    sessionId;
    sessionInfo;
    /** True while a `session/prompt` is awaiting a response — lets the abort path
     *  tell whether a graceful cancel actually ended the turn before escalating. */
    promptInFlight = false;
    /** Reject fn for the in-flight `conn.prompt()` promise while a turn runs. Lets
     *  us force that await to settle the instant the child exits or the runtime is
     *  disposed — the SDK does not reliably reject pending RPCs on an abnormal
     *  child exit, which otherwise wedges the turn (and the channel queue) forever. */
    rejectInFlightPrompt;
    promptCapabilities;
    sessionCwd;
    /** Model override applied at spawn time for non-Anthropic backends where
     *  `setModel()` (ACP config option) is rejected by the adapter. Set by the
     *  session-router before calling `start()`. */
    modelOverride;
    /** Effort override applied at spawn time for agents that accept reasoning
     *  effort via CLI flags (e.g. Grok `--reasoning-effort`). Set by the
     *  session-router before calling `start()`. */
    effortOverride;
    eventHandler;
    /**
     * Serializes session-update processing. The ACP SDK's read loop dispatches
     * notifications concurrently (it calls processMessage without awaiting it),
     * so a later chunk's handler can run while an earlier one is parked on an
     * await and mutate shared state (e.g. the orchestrator's streamed-text
     * buffer) out of order. Funnelling every update through this queue restores
     * strict arrival order end-to-end.
     */
    sessionUpdates = new SerialQueue();
    constructor(opts) {
        this.profile = opts.profile;
        this.logger = opts.logger.child({ agent: opts.profile.id });
        this.mcpServers = opts.mcpServers ?? [];
        this.onDead = opts.onDead;
        this.permissionPolicy =
            opts.permissionPolicy ??
                (async (req) => {
                    // Default: pick the first "allow_..." option, or the first option.
                    const allow = req.options.find((o) => o.kind?.startsWith("allow_")) ??
                        req.options[0];
                    if (!allow) {
                        return {
                            outcome: { outcome: "cancelled" },
                        };
                    }
                    return {
                        outcome: { outcome: "selected", optionId: allow.optionId },
                    };
                });
    }
    onEvent(handler) {
        this.eventHandler = handler;
    }
    /** Start the agent process and complete ACP `initialize`. */
    async start() {
        if (this.connection)
            return;
        const child = this.profile.spawn(this.modelOverride, this.effortOverride);
        this.child = child;
        // Capture spawn errors (ENOENT, EACCES, etc.) so they surface as a
        // rejected start() promise instead of letting the ACP handshake hang
        // indefinitely on a stdout that will never produce data.
        // Ring buffer of the agent's recent stderr so an abnormal exit can report
        // WHY it died (agent stderr is otherwise debug-only, dropped at info level).
        // Bounded to the last ~100 lines.
        const stderrRing = [];
        let spawnError;
        const errorWaiter = new Promise((_resolve, reject) => {
            child.once("error", (err) => {
                spawnError = err;
                const hint = err.code === "ENOENT"
                    ? ` (binary not found on PATH; did you 'npm i -g' the agent's CLI?)`
                    : "";
                reject(new Error(`agent spawn failed: ${err.message}${hint}`));
            });
            child.once("exit", (code, signal) => {
                if (!spawnError && this.connection === undefined) {
                    // Process died before initialize completed.
                    reject(new Error(`agent process exited before initialize (code=${code}, signal=${signal})`));
                }
            });
        });
        child.on("exit", (code, signal) => {
            // 130 = SIGINT, 143 = SIGTERM, etc. Surface the agent's own stderr tail on
            // any abnormal exit so we can tell a self-interrupt/timeout from a crash.
            const abnormal = (code !== 0 && code !== null) || signal != null;
            const stderrTail = stderrRing.slice(-40).join("\n").slice(-4000);
            this.logger.warn({ code, signal, ...(abnormal && stderrTail ? { stderrTail } : {}) }, abnormal ? "agent process exited abnormally" : "agent process exited");
            // Reject any in-flight prompt FIRST so a turn awaiting it unblocks
            // immediately. Without this, an abnormal child exit leaves the
            // orchestrator's `await prompt()` pending forever (the SDK doesn't
            // reliably reject pending RPCs on a hard exit): the runtime gets evicted
            // but the channel queue wedges — card stuck "working", activeTurns never
            // decrements, no new turn starts, and `/seam abort` reports "no active
            // turn" (the runtime is already gone). Previously only a restart cleared it.
            this.rejectInFlightPrompt?.(new Error(`agent process exited mid-turn (code=${code}, signal=${signal})`));
            // If initialize already completed, notify the router so it can evict
            // this runtime and attempt session/load on the next incoming message.
            if (this.connection !== undefined) {
                this.onDead?.();
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            const line = chunk.trimEnd();
            if (line) {
                this.logger.debug({ stderr: line }, "agent stderr");
                stderrRing.push(line);
                if (stderrRing.length > 100)
                    stderrRing.splice(0, stderrRing.length - 100);
            }
        });
        const writable = Writable.toWeb(child.stdin);
        const readable = Readable.toWeb(child.stdout);
        const stream = ndJsonStream(writable, readable);
        const client = this.makeClient();
        this.connection = new ClientSideConnection(() => client, stream);
        const initResult = await Promise.race([
            this.connection.initialize({
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                },
            }),
            errorWaiter,
            withTimeout(START_TIMEOUT_MS, `ACP initialize timed out after ${START_TIMEOUT_MS / 1000}s ` +
                `(agent never responded; check that '${this.profile.id}' is installed and authenticated)`),
        ]);
        this.promptCapabilities =
            initResult.agentCapabilities?.promptCapabilities ?? undefined;
        this.logger.debug({ promptCapabilities: this.promptCapabilities }, "acp initialized");
    }
    /** Capabilities advertised by the agent during `initialize`. */
    getPromptCapabilities() {
        return this.promptCapabilities;
    }
    /** Create a new ACP session in `cwd`. */
    async newSession(opts) {
        const conn = this.requireConnection();
        const meta = {
            ...(this.profile.newSessionMeta?.(opts.model, opts.effort) ?? {}),
            ...(opts.meta ?? {}),
        };
        const result = await Promise.race([
            conn.newSession({
                cwd: opts.cwd,
                mcpServers: this.mcpServers,
                ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
            }),
            withTimeout(NEW_SESSION_TIMEOUT_MS, `ACP session/new timed out after ${NEW_SESSION_TIMEOUT_MS / 1000}s ` +
                `(agent '${this.profile.id}' did not create a session — check auth and cwd)`),
        ]);
        this.sessionCwd = opts.cwd;
        this.sessionId = result.sessionId;
        this.sessionInfo = this.buildSessionInfo(result);
        // Apply model override after session creation if requested and supported.
        const wantedModel = opts.model ?? this.profile.defaultModel;
        // Do NOT require `currentModelId` here: opencode's session/new (and loadSession)
        // returns no `models`, so currentModelId is undefined — gating on it skipped
        // set_model entirely and left opencode on its built-in default (`big-pickle`,
        // no vision). `wantedModel !== undefined` is true, so we (re)apply; if it
        // already matches the reported current model we still skip the redundant call.
        if (wantedModel && wantedModel !== this.sessionInfo.currentModelId) {
            const isExplicit = opts.model !== undefined;
            const isAvailable = this.sessionInfo.availableModels.some((m) => m.modelId === wantedModel);
            if (isExplicit || isAvailable) {
                try {
                    await this.setModel(wantedModel);
                    this.sessionInfo = { ...this.sessionInfo, currentModelId: wantedModel };
                }
                catch (err) {
                    this.logger.warn({ err, wantedModel }, "failed to set initial model");
                }
            }
        }
        // Apply reasoning effort for agents that take it as a config option (Copilot).
        await this.applyConfigOptionEffort(opts.effort);
        return this.sessionInfo;
    }
    /** Resume an existing ACP session. */
    async loadSession(opts) {
        const conn = this.requireConnection();
        const meta = {
            ...(this.profile.newSessionMeta?.(opts.model, opts.effort) ?? {}),
        };
        const result = await conn.loadSession({
            sessionId: opts.sessionId,
            cwd: opts.cwd,
            mcpServers: this.mcpServers,
            ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
        });
        this.sessionCwd = opts.cwd;
        this.sessionId = opts.sessionId;
        this.sessionInfo = {
            sessionId: opts.sessionId,
            availableModels: this.toAvailableModels(result.configOptions),
            currentModelId: this.toCurrentModelId(result.configOptions),
            availableModes: this.toAvailableModes(result.modes),
            currentModeId: this.toCurrentModeId(result.modes),
        };
        // Re-apply model preference on resume — Claude Code sessions don't persist
        // the model choice across subprocess restarts, so it would otherwise revert
        // to whatever is in settings.json (typically the default model, not the
        // per-session override the user selected).
        const wantedModel = opts.model ?? this.profile.defaultModel;
        // Do NOT require `currentModelId` here: opencode's session/new (and loadSession)
        // returns no `models`, so currentModelId is undefined — gating on it skipped
        // set_model entirely and left opencode on its built-in default (`big-pickle`,
        // no vision). `wantedModel !== undefined` is true, so we (re)apply; if it
        // already matches the reported current model we still skip the redundant call.
        if (wantedModel && wantedModel !== this.sessionInfo.currentModelId) {
            const isExplicit = opts.model !== undefined;
            const isAvailable = this.sessionInfo.availableModels.some((m) => m.modelId === wantedModel);
            if (isExplicit || isAvailable) {
                try {
                    await this.setModel(wantedModel);
                    this.sessionInfo = { ...this.sessionInfo, currentModelId: wantedModel };
                }
                catch (err) {
                    this.logger.warn({ err, wantedModel }, "failed to re-apply model on session load");
                }
            }
        }
        // Re-apply reasoning effort on resume (config options don't persist across
        // a subprocess restart any more than the model does).
        await this.applyConfigOptionEffort(opts.effort);
        return this.sessionInfo;
    }
    getSessionInfo() {
        return this.sessionInfo;
    }
    async prompt(text, attachments) {
        const conn = this.requireConnection();
        const sid = this.requireSessionId();
        const prompt = [];
        if (text)
            prompt.push({ type: "text", text });
        let rejected;
        if (attachments && attachments.length > 0) {
            const mapped = await mapAttachmentsToBlocks(attachments, {
                capabilities: this.promptCapabilities,
                logger: this.logger,
            });
            prompt.push(...mapped.blocks);
            if (mapped.rejected.length > 0)
                rejected = mapped.rejected;
        }
        if (prompt.length === 0) {
            // Caller passed empty text and no usable attachments.
            return {
                stopReason: "end_turn",
                cancelled: false,
                ...(rejected ? { rejectedAttachments: rejected } : {}),
            };
        }
        this.promptInFlight = true;
        try {
            // Race the ACP prompt RPC against a death/dispose rejection. Storing the
            // reject lets the child-exit handler (and dispose) force this await to
            // settle instead of hanging when the connection dies without a clean
            // close. On normal completion the RPC resolves first.
            const res = await new Promise((resolve, reject) => {
                this.rejectInFlightPrompt = reject;
                conn.prompt({ sessionId: sid, prompt }).then(resolve, reject);
            });
            return {
                stopReason: res.stopReason,
                cancelled: res.stopReason === "cancelled",
                ...(rejected ? { rejectedAttachments: rejected } : {}),
            };
        }
        finally {
            this.promptInFlight = false;
            this.rejectInFlightPrompt = undefined;
        }
    }
    /** Whether a prompt is currently in flight (turn running). */
    get busy() {
        return this.promptInFlight;
    }
    /** Wait for all asynchronous session updates to be processed. */
    async idle() {
        await this.sessionUpdates.idle();
    }
    async setModel(modelId) {
        // ACP 1.x: model selection is a session config option (configId "model");
        // the old `unstable_setSessionModel` RPC is gone. Full canonical IDs
        // exact-match the agent's advertised option values and bypass the fuzzy
        // resolver; aliases (e.g. "default") fall through to it agent-side.
        await this.setConfigOption("model", modelId);
        if (this.sessionInfo) {
            this.sessionInfo = { ...this.sessionInfo, currentModelId: modelId };
        }
    }
    async setMode(modeId) {
        const conn = this.requireConnection();
        const sid = this.requireSessionId();
        await conn.setSessionMode({ sessionId: sid, modeId });
        if (this.sessionInfo) {
            this.sessionInfo = { ...this.sessionInfo, currentModeId: modeId };
        }
    }
    async setConfigOption(configId, value) {
        const conn = this.requireConnection();
        const sid = this.requireSessionId();
        if (typeof value === "boolean") {
            await conn.setSessionConfigOption({
                sessionId: sid,
                configId,
                type: "boolean",
                value,
            });
        }
        else {
            await conn.setSessionConfigOption({
                sessionId: sid,
                configId,
                value,
            });
        }
    }
    /** Apply reasoning effort for agents that take it as an ACP config option
     *  (e.g. Copilot's "reasoning_effort"). Claude folds effort into `_meta` via
     *  newSessionMeta instead; modelBaked/none agents have nothing to set. Must
     *  run after the session exists — config options require a live session. */
    async applyConfigOptionEffort(effort) {
        const eff = this.profile.effort;
        if (!eff || eff.mechanism !== "configOption" || !eff.configId)
            return;
        if (!effort || effort === "default" || !eff.levels.includes(effort))
            return;
        try {
            await this.setConfigOption(eff.configId, effort);
        }
        catch (err) {
            this.logger.warn({ err, effort, configId: eff.configId }, "failed to apply reasoning-effort config option");
        }
    }
    async cancel() {
        if (!this.connection || !this.sessionId)
            return;
        try {
            await this.connection.cancel({ sessionId: this.sessionId });
        }
        catch (err) {
            this.logger.warn({ err }, "cancel failed");
        }
    }
    async dispose() {
        if (this.sessionId) {
            try {
                await Promise.race([
                    this.cancel(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timeout")), 2000))
                ]);
            }
            catch (err) {
                this.logger.warn({ err }, "cancel during dispose timed out or failed");
            }
        }
        const child = this.child;
        if (child && !child.killed) {
            try {
                child.stdin.end();
            }
            catch {
                /* ignore */
            }
            const exitPromise = new Promise((resolve) => {
                child.once("exit", resolve);
                child.once("error", resolve);
            });
            if (child.pid && child.detached) {
                try {
                    process.kill(-child.pid, "SIGTERM");
                }
                catch {
                    try {
                        child.kill("SIGTERM");
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
            else {
                try {
                    child.kill("SIGTERM");
                }
                catch {
                    /* ignore */
                }
            }
            // Wait up to 3 seconds for graceful exit
            await Promise.race([
                exitPromise,
                new Promise((resolve) => setTimeout(resolve, 3000))
            ]);
            // Force kill if still alive
            if (child.exitCode === null && child.signalCode === null) {
                if (child.pid && child.detached) {
                    try {
                        process.kill(-child.pid, "SIGKILL");
                    }
                    catch { /* ignore */ }
                }
                else {
                    try {
                        child.kill("SIGKILL");
                    }
                    catch { /* ignore */ }
                }
            }
        }
        this.connection = undefined;
        this.sessionId = undefined;
        this.sessionInfo = undefined;
        this.child = undefined;
    }
    // --- internals ---
    requireConnection() {
        if (!this.connection)
            throw new Error("AgentRuntime not started");
        return this.connection;
    }
    requireSessionId() {
        if (!this.sessionId)
            throw new Error("No active session");
        return this.sessionId;
    }
    async emit(event) {
        if (!this.eventHandler)
            return;
        try {
            await this.eventHandler(event);
        }
        catch (err) {
            this.logger.error({ err, event }, "event handler failed");
        }
    }
    makeClient() {
        const runtime = this;
        return {
            async requestPermission(params) {
                return runtime.permissionPolicy(params);
            },
            async sessionUpdate(params) {
                await runtime.handleSessionUpdate(params.update);
            },
        };
    }
    handleSessionUpdate(update) {
        // Process updates one at a time, in arrival order. See `sessionUpdates`.
        return this.sessionUpdates.run(() => this.handleSessionUpdateInner(update));
    }
    async handleSessionUpdateInner(update) {
        switch (update.sessionUpdate) {
            case "agent_message_chunk": {
                await this.handleContentBlock(update.content, "message", {
                    messageId: update.messageId ?? undefined,
                });
                return;
            }
            case "agent_thought_chunk": {
                const text = textFromContent(update.content);
                if (text)
                    await this.emit({ kind: "agent-thought", text });
                return;
            }
            case "tool_call": {
                await this.emit({
                    kind: "tool-start",
                    toolCallId: update.toolCallId,
                    title: update.title,
                    kindLabel: update.kind,
                });
                if (Array.isArray(update.content)) {
                    for (const tc of update.content)
                        await this.handleToolCallContent(tc);
                }
                return;
            }
            case "tool_call_update": {
                await this.emit({
                    kind: "tool-update",
                    toolCallId: update.toolCallId,
                    status: update.status ?? undefined,
                    title: update.title ?? undefined,
                });
                if (Array.isArray(update.content)) {
                    for (const tc of update.content)
                        await this.handleToolCallContent(tc);
                }
                return;
            }
            case "current_mode_update": {
                await this.emit({ kind: "mode-changed", modeId: update.currentModeId });
                return;
            }
            case "config_option_update": {
                // Track current model if present in the new options.
                const opts = update
                    .configOptions;
                const currentModel = extractCurrentModel(opts);
                if (currentModel && this.sessionInfo) {
                    this.sessionInfo = {
                        ...this.sessionInfo,
                        currentModelId: currentModel,
                    };
                    await this.emit({ kind: "model-changed", modelId: currentModel });
                }
                await this.emit({ kind: "config-options", options: opts });
                return;
            }
            case "usage_update": {
                const u = update;
                if (typeof u.used === "number" && typeof u.size === "number" && u.size > 0) {
                    await this.emit({ kind: "usage-update", used: u.used, size: u.size });
                }
                return;
            }
            default:
                // user_message_chunk, plan, available_commands_update,
                // session_info_update — currently ignored.
                return;
        }
    }
    /**
     * Inspect a single ContentBlock from an `agent_message_chunk` and emit the
     * right downstream event (text or file). Logs every non-text block at debug
     * level so we can observe what real agents actually send.
     */
    async handleContentBlock(content, source, extra = {}) {
        if (!content || typeof content !== "object")
            return;
        const block = content;
        if (block.type === "text") {
            const text = block.text;
            if (typeof text === "string" && text.length > 0) {
                if (text === "Compacting...") {
                    await this.emit({ kind: "agent-state", state: "Compacting memory…" });
                    return;
                }
                if (source === "tool") {
                    // Tool stdout/stderr (curl progress, file dumps, exit codes) is
                    // NOT a model reply — never post it to chat, and don't scan it
                    // for file paths either: that would upload every doc the agent
                    // reads. Files the agent *produces* are caught by scanning the
                    // assistant's message text below.
                    return;
                }
                await this.emit({
                    kind: "agent-text",
                    text,
                    ...(extra.messageId ? { messageId: extra.messageId } : {}),
                });
            }
            return;
        }
        this.logger.info({ source, blockType: block.type }, "non-text content block from agent");
        const file = blockToFile(block);
        if (file) {
            await this.emit({ kind: "agent-file", source, ...file });
            return;
        }
        if (block.type === "resource_link") {
            // Surface as inline text so users see it in the chat. Easier than
            // building a separate UI for it.
            const link = block;
            const label = link.name ?? link.uri ?? "resource";
            await this.emit({
                kind: "agent-text",
                text: `🔗 [${label}](${link.uri ?? ""})`,
                ...(extra.messageId ? { messageId: extra.messageId } : {}),
            });
        }
    }
    /** Inspect a ToolCallContent entry; only the "content" variant interests us. */
    async handleToolCallContent(tc) {
        if (!tc || typeof tc !== "object")
            return;
        const t = tc;
        // Trace what shape arrives from each tool — invaluable for figuring out
        // why an MCP server's image / file output isn't surfacing as an upload.
        const inner = t.content?.type;
        this.logger.debug({ tcType: t.type, contentType: inner }, "tool_call content entry");
        if (t.type !== "content") {
            // diff / terminal — handled elsewhere or ignored for now.
            return;
        }
        await this.handleContentBlock(t.content, "tool");
    }
    buildSessionInfo(result) {
        return {
            sessionId: result.sessionId,
            availableModels: this.toAvailableModels(result.configOptions),
            currentModelId: this.toCurrentModelId(result.configOptions),
            availableModes: this.toAvailableModes(result.modes),
            currentModeId: this.toCurrentModeId(result.modes),
        };
    }
    /** Locate the model selector among the agent's session config options
     *  (ACP 1.x: models moved from a dedicated `models` field into
     *  `configOptions` with category/id "model"). */
    findModelOption(configOptions) {
        if (!configOptions)
            return undefined;
        return configOptions.find((o) => o.category === "model" || o.id === "model");
    }
    toAvailableModels(configOptions) {
        // Profile-declared static models win: they carry the picker labels and
        // contextLimit the agent doesn't advertise (Claude/Copilot pickers,
        // opencode discovery).
        if (this.profile.staticModels && this.profile.staticModels.length > 0) {
            return this.profile.staticModels;
        }
        const opt = this.findModelOption(configOptions);
        if (!opt || opt.type !== "select")
            return [];
        return flattenConfigSelectOptions(opt.options).map((o) => ({
            modelId: o.value,
            name: o.name,
        }));
    }
    toCurrentModelId(configOptions) {
        const opt = this.findModelOption(configOptions);
        if (!opt || opt.type !== "select")
            return undefined;
        return typeof opt.currentValue === "string" ? opt.currentValue : undefined;
    }
    toAvailableModes(modes) {
        if (!modes)
            return [];
        const list = modes
            .availableModes;
        return Array.isArray(list) ? list : [];
    }
    toCurrentModeId(modes) {
        if (!modes)
            return undefined;
        return modes.currentModeId;
    }
}
function textFromContent(content) {
    if (!content || typeof content !== "object")
        return undefined;
    const c = content;
    if (c.type === "text" && typeof c.text === "string")
        return c.text;
    return undefined;
}
function extractCurrentModel(options) {
    if (!Array.isArray(options))
        return undefined;
    const modelOpt = options.find((o) => typeof o === "object" &&
        o !== null &&
        o.id === "model");
    return modelOpt?.currentValue;
}
export { RequestError };
//# sourceMappingURL=agent-runtime.js.map