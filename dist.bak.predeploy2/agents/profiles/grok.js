import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
/**
 * Known context windows for xAI text models (from docs.x.ai/developers/models).
 * Used to enrich models returned by the /v1/models discovery endpoint, which
 * doesn't include context-window fields.
 */
const KNOWN_CONTEXT_WINDOWS = {
    "grok-build-0.1": 256_000,
    "grok-4.5": 500_000,
    "grok-4.3": 1_000_000,
    "grok-4.20-0309-reasoning": 1_000_000,
    "grok-4.20-0309-non-reasoning": 1_000_000,
    "grok-4.20-multi-agent-0309": 1_000_000,
};
/** Friendly display label: strip date suffixes and capitalize. */
function modelLabel(id) {
    // "grok-build-0.1" → "Grok Build 0.1"
    // "grok-4.3" → "Grok 4.3"
    return id
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}
/** One fetch with a 10s abort timeout. */
async function fetchJson(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        if (!res.ok)
            throw new Error(`${url} HTTP ${res.status}`);
        return (await res.json());
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Discover the live model list from xAI's OpenAI-compatible `/v1/models`
 * endpoint (`https://api.x.ai/v1/models`).  Returns only text models (filters
 * out image/video/audio/embedding models).
 *
 * Context windows are looked up from KNOWN_CONTEXT_WINDOWS since the
 * `/v1/models` response doesn't include them.
 *
 * Requires `XAI_API_KEY`.  Returns [] on failure (agent still registers;
 * picker falls back to GROK_STATIC_MODELS).
 */
export async function fetchXaiModels(apiKey, baseUrl = "https://api.x.ai") {
    const root = baseUrl.replace(/\/+$/, "");
    const headers = {
        authorization: `Bearer ${apiKey}`,
    };
    let body;
    try {
        body = await fetchJson(`${root}/v1/models`, { headers });
    }
    catch {
        return [];
    }
    const out = [];
    // Prefixes to skip — these are non-text models.
    const skipPrefixes = [
        "grok-imagine",
        "grok-voice",
        "grok-audio",
        "grok-stt",
        "grok-tts",
        "embedding",
    ];
    for (const m of body.data ?? []) {
        if (typeof m.id !== "string" || m.id.length === 0)
            continue;
        // Filter out non-text models.
        if (skipPrefixes.some((p) => m.id.startsWith(p)))
            continue;
        const contextLimit = KNOWN_CONTEXT_WINDOWS[m.id] ?? undefined;
        out.push({
            modelId: m.id,
            name: modelLabel(m.id),
            ...(contextLimit ? { contextLimit } : {}),
        });
    }
    return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
}
/**
 * xAI Grok Build as an ACP server.  The CLI speaks ACP natively via
 * `grok agent stdio` — no separate adapter package is needed.
 *
 * Setup on the host (one-time):
 *   curl -fsSL https://x.ai/cli/install.sh | bash
 *   grok login              # or set XAI_API_KEY in the environment
 *
 * The `grok agent stdio` command starts a JSON-RPC / ACP server on stdio,
 * identical in shape to claude-agent-acp and codex-acp.  Auth method IDs
 * exposed by `initialize` are `xai.api_key` (uses $XAI_API_KEY) and
 * `cached_token` (from `grok login`).
 *
 * Reasoning effort: as of grok CLI 0.2.93+, the `grok agent` command
 * supports `--reasoning-effort <low|medium|high>` (alias `--effort`).
 * Grok 4.5 supports reasoning_effort via the API; the CLI flag maps to
 * the same parameter.  We pass effort via CLI args at spawn time.
 */
export function makeGrokProfile(opts) {
    const cli = opts.cliPath?.trim() || "grok";
    return {
        id: opts.id ?? "grok",
        displayName: opts.displayName ?? "Grok Build",
        defaultModel: opts.defaultModel,
        staticModels: opts.staticModels,
        threadAbbr: opts.threadAbbr,
        // Reasoning effort: grok CLI 0.2.93+ supports --reasoning-effort on
        // `grok agent`.  Grok 4.5 supports low/medium/high; Grok 4.20 multi-agent
        // also supports xhigh.  We pass effort via CLI flag at spawn time and
        // expose it through the spawn-args effort mechanism.
        effort: opts.effort ?? {
            mechanism: "none",
            levels: ["low", "medium", "high"],
        },
        spawn(modelOverride, effortOverride) {
            const env = { ...process.env };
            if (opts.extraEnv) {
                for (const [k, v] of Object.entries(opts.extraEnv)) {
                    if (v !== undefined)
                        env[k] = v;
                }
            }
            // Build CLI args: `grok agent [--model X] [--reasoning-effort Y] stdio`
            const args = ["agent"];
            const model = modelOverride ?? opts.defaultModel;
            if (model)
                args.push("--model", model);
            if (effortOverride && effortOverride !== "default") {
                args.push("--reasoning-effort", effortOverride);
            }
            args.push("stdio");
            return spawn(cli, args, {
                stdio: ["pipe", "pipe", "pipe"],
                env,
                detached: true,
            });
        },
        sessionManager: new GrokSessionManager(),
    };
}
// ---------------------------------------------------------------------------
// Grok session manager — minimal implementation for context-window display.
// Reads chat_history.jsonl from ~/.grok/sessions/<encodedCwd>/<sessionId>/
// and estimates token usage by character count (~4 chars/token).
// ---------------------------------------------------------------------------
/** URL-encode a cwd path the same way grok does for its session directories. */
function encodeCwd(cwd) {
    return encodeURIComponent(cwd).replace(/%2F/gi, "%2F");
}
class GrokSessionManager {
    grokHome() {
        return process.env.GROK_HOME ?? path.join(process.env.HOME ?? "", ".grok");
    }
    sessionsDir(cwd) {
        // Strip trailing slash — Grok encodes cwd without it.
        const normalized = cwd.replace(/\/+$/, "");
        return path.join(this.grokHome(), "sessions", encodeCwd(normalized));
    }
    async listSessions(cwd) {
        const dir = this.sessionsDir(cwd);
        let entries;
        try {
            entries = await readdir(dir);
        }
        catch {
            return [];
        }
        const summaries = [];
        for (const entry of entries) {
            // Session dirs are UUIDs; skip non-dir entries like prompt_history.jsonl.
            if (!entry.match(/^[0-9a-f]{8}-/))
                continue;
            const sessionDir = path.join(dir, entry);
            try {
                const summaryPath = path.join(sessionDir, "summary.json");
                const raw = await readFile(summaryPath, "utf-8");
                const data = JSON.parse(raw);
                summaries.push({
                    sessionId: entry,
                    createdAt: data.created_at ? new Date(data.created_at).getTime() : undefined,
                    lastActivityAt: data.updated_at ? new Date(data.updated_at).getTime() : undefined,
                    previewLines: [{ sender: "agent", text: data.session_summary ?? "" }],
                });
            }
            catch {
                // Damaged or incomplete session — skip.
            }
        }
        return summaries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    }
    async cloneSession(_cwd, _oldId, _newId) {
        // Not implemented for Grok.
    }
    async deleteSession(_cwd, _sessionId) {
        // Not implemented for Grok.
    }
    async getTranscript(cwd, sessionId) {
        const chatPath = path.join(this.sessionsDir(cwd), sessionId, "chat_history.jsonl");
        const lines = [];
        try {
            const rl = readline.createInterface({ input: createReadStream(chatPath) });
            for await (const line of rl) {
                try {
                    const d = JSON.parse(line);
                    if (d.type === "user" || d.type === "assistant") {
                        const sender = d.type === "user" ? "Human" : "Assistant";
                        const text = typeof d.content === "string" ? d.content : "";
                        lines.push(`${sender}: ${text.slice(0, 500)}`);
                    }
                }
                catch { /* skip bad lines */ }
            }
        }
        catch { /* file missing */ }
        return lines.join("\n\n");
    }
    async getUsage(cwd, sessionId) {
        const dir = this.sessionsDir(cwd);
        let targetId = sessionId;
        if (!targetId) {
            // Find the most recently modified session.
            try {
                const entries = await readdir(dir);
                let latest = { id: "", mtime: 0 };
                for (const entry of entries) {
                    if (!entry.match(/^[0-9a-f]{8}-/))
                        continue;
                    const s = await stat(path.join(dir, entry)).catch(() => null);
                    if (s && s.mtimeMs > latest.mtime) {
                        latest = { id: entry, mtime: s.mtimeMs };
                    }
                }
                targetId = latest.id || undefined;
            }
            catch {
                return { model: null, totalUsed: 0, contextLimit: 0 };
            }
        }
        if (!targetId)
            return { model: null, totalUsed: 0, contextLimit: 0 };
        // Read summary.json for model.
        let model = null;
        try {
            const raw = await readFile(path.join(dir, targetId, "summary.json"), "utf-8");
            const data = JSON.parse(raw);
            model = data.current_model_id ?? null;
        }
        catch { /* ok */ }
        // Estimate tokens from chat_history.jsonl character count.
        const chatPath = path.join(dir, targetId, "chat_history.jsonl");
        let totalChars = 0;
        try {
            const rl = readline.createInterface({ input: createReadStream(chatPath) });
            for await (const line of rl) {
                try {
                    const d = JSON.parse(line);
                    const content = d.content;
                    if (typeof content === "string") {
                        totalChars += content.length;
                    }
                    else if (Array.isArray(content)) {
                        for (const block of content) {
                            if (block && typeof block === "object" && typeof block.text === "string") {
                                totalChars += block.text.length;
                            }
                        }
                    }
                }
                catch { /* skip bad lines */ }
            }
        }
        catch { /* file missing */ }
        // Rough estimate: ~4 chars per token.
        const estimatedTokens = Math.round(totalChars / 4);
        const contextLimit = model ? (KNOWN_CONTEXT_WINDOWS[model] ?? 256_000) : 256_000;
        return { model, totalUsed: estimatedTokens, contextLimit };
    }
}
//# sourceMappingURL=grok.js.map