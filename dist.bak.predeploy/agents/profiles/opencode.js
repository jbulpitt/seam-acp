import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
/** One fetch with a 10s abort timeout. */
async function fetchJson(fetchFn, url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
        const res = await fetchFn(url, { ...init, signal: ctrl.signal });
        if (!res.ok)
            throw new Error(`${url} HTTP ${res.status}`);
        return (await res.json());
    }
    finally {
        clearTimeout(timer);
    }
}
/** Display label for a model id: the part after the last `/` (drops the
 *  publisher prefix, e.g. `google/gemma-4-26b-a4b` → `gemma-4-26b-a4b`). */
function modelLabel(rawId) {
    return rawId.includes("/") ? rawId.slice(rawId.lastIndexOf("/") + 1) : rawId;
}
/**
 * Discover the live model list from an LM Studio server's `/api/v0/models`
 * (LM Studio's native REST API — unlike the OpenAI `/v1/models` it returns the
 * served context window and capabilities in one call). Each model maps to its
 * opencode id (`<prefix>/<rawId>`, e.g. `lmstudio-remote/google/gemma-4-26b-a4b`)
 * and carries the served window (`loaded_context_length`, falling back to
 * `max_context_length`) so the picker's usage display is accurate.
 *
 * Auth: LM Studio behind the tunnel requires a bearer token. Returns [] if the
 * list can't be fetched (the agent still registers; picker empty until LM Studio
 * is reachable). 10s timeout.
 */
export async function fetchLmStudioModels(baseUrl, apiKey, prefix, fetchFn = fetch) {
    const root = baseUrl.replace(/\/+$/, "");
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    let body;
    try {
        body = await fetchJson(fetchFn, `${root}/api/v0/models`, { headers });
    }
    catch {
        return [];
    }
    const out = [];
    for (const m of body.data ?? []) {
        if (typeof m.id !== "string" || m.id.length === 0)
            continue;
        const loaded = m.loaded_context_length;
        const max = m.max_context_length;
        const contextLimit = typeof loaded === "number" && loaded > 0 ? loaded :
            typeof max === "number" && max > 0 ? max : undefined;
        // LM Studio reports `type: "vlm"` for vision models and a `capabilities`
        // array (e.g. ["tool_use"]). Map these to opencode's per-model flags so it
        // forwards images / tool calls instead of silently dropping them.
        const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
        const attachment = m.type === "vlm";
        const toolCall = caps.includes("tool_use") || caps.includes("tools");
        const reasoning = caps.includes("thinking") || caps.includes("reasoning");
        out.push({
            rawId: m.id,
            modelId: `${prefix}/${m.id}`,
            name: `${modelLabel(m.id)} 🦙`,
            ...(contextLimit ? { contextLimit } : {}),
            ...(attachment ? { attachment: true } : {}),
            ...(toolCall ? { toolCall: true } : {}),
            ...(reasoning ? { reasoning: true } : {}),
        });
    }
    return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
}
/**
 * Write the custom LM Studio provider block into opencode's global config
 * (`~/.config/opencode/opencode.json`) from the discovered model list.
 *
 * Why seam-acp owns this: opencode 1.15.x does NOT auto-discover models for a
 * custom `@ai-sdk/openai-compatible` provider — they must be declared, or
 * `set_model` fails with "Model not found". (The provider name must also avoid
 * colliding with a models.dev built-in like `lmstudio`, hence `lmstudio-remote`.)
 * So we keep the declared `models` block in sync with what LM Studio actually
 * serves — fully dynamic, no hardcoding, no drift from the seam-acp picker.
 *
 * The apiKey is written literally (sourced from seam-acp's `.env`, so `.env`
 * stays the single source of truth — seam-acp just propagates it into opencode's
 * own config, which is a local, non-repo file). opencode's `{env:VAR}`
 * interpolation would avoid the second copy, but the literal value is the
 * configuration verified end-to-end, so we use it for determinism. Other
 * providers in the file are preserved. No-op when `models` is empty, so a
 * transient discovery failure never wipes a good config.
 */
export async function syncOpencodeLmStudioConfig(opts) {
    if (opts.models.length === 0)
        return;
    let cfg = {};
    try {
        const parsed = JSON.parse(await fsp.readFile(opts.configPath, "utf8"));
        if (parsed && typeof parsed === "object")
            cfg = parsed;
    }
    catch {
        /* missing/invalid → start fresh */
    }
    if (!cfg.$schema)
        cfg.$schema = "https://opencode.ai/config.json";
    const providers = (cfg.provider && typeof cfg.provider === "object" ? cfg.provider : {});
    // Declare each model WITH its capability flags. For vision, opencode needs BOTH
    // `attachment: true` AND `modalities.input` containing "image" — and the latter
    // is the load-bearing one: opencode's message-builder consults `modalities` to
    // decide whether to forward image parts to the provider. With only `attachment`
    // (or neither), opencode accepts the image from the ACP client but silently
    // drops it before the model — the "can't see images" bug. Verified end-to-end:
    // adding modalities.input:["text","image"] flips gemma-4-26b from "I cannot see
    // any image" to reading it correctly.
    const modelsBlock = {};
    for (const m of opts.models) {
        const input = ["text", ...(m.attachment ? ["image"] : [])];
        modelsBlock[m.rawId] = {
            name: modelLabel(m.rawId),
            ...(m.attachment ? { attachment: true } : {}),
            ...(m.toolCall ? { tool_call: true } : {}),
            ...(m.reasoning ? { reasoning: true } : {}),
            modalities: { input, output: ["text"] },
        };
    }
    providers[opts.providerKey] = {
        npm: "@ai-sdk/openai-compatible",
        name: "LM Studio Remote",
        options: { baseURL: opts.baseURL, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) },
        models: modelsBlock,
    };
    cfg.provider = providers;
    if (opts.defaultModel)
        cfg.model = opts.defaultModel;
    if (opts.mcpManagedKeys && opts.mcpManagedKeys.length > 0) {
        const existingMcp = (cfg.mcp && typeof cfg.mcp === "object" ? cfg.mcp : {});
        for (const k of opts.mcpManagedKeys)
            delete existingMcp[k]; // reconcile: drop seam-managed
        const next = { ...existingMcp, ...(opts.mcp ?? {}) }; // re-add currently-enabled
        if (Object.keys(next).length > 0)
            cfg.mcp = next;
        else
            delete cfg.mcp;
    }
    await fsp.mkdir(path.dirname(opts.configPath), { recursive: true });
    await fsp.writeFile(opts.configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
/**
 * opencode (sst/opencode) as an ACP server (`opencode acp`).
 *
 * opencode is a provider-agnostic coding agent. Pointed at a local/remote
 * LM Studio via its own config (`~/.config/opencode/opencode.json` — a custom
 * `@ai-sdk/openai-compatible` provider with the LM Studio `/v1` baseURL +
 * bearer token), it drives local models **natively over ACP** with no Anthropic
 * translation proxy. The provider's `models` block is kept in sync with LM
 * Studio's live `/api/v0/models` by `syncOpencodeLmStudioConfig` (opencode does
 * not auto-discover custom providers). Verified end-to-end: clean ACP handshake
 * (initialize → session/new → set_model → session/prompt) and a real turn
 * against `gemma-4-26b-a4b` (a vision-capable MLX model) through the tunnel.
 *
 * Models are referenced by their opencode id (e.g.
 * `lmstudio-remote/google/gemma-4-26b-a4b`). Those ids carry `/`, so the picker
 * list is provided as `staticModels` (set in code) rather than the
 * colon-delimited MODELS env format.
 *
 * Minimal by design: opencode owns its own session storage, so this profile
 * doesn't implement the optional `sessionManager` (the `/seam sessions` family is
 * unavailable for it) — but the core turn flow works over ACP like any agent.
 */
export function makeOpencodeProfile(opts) {
    const cli = opts.cliPath?.trim() || "opencode";
    return {
        id: opts.id ?? "opencode",
        displayName: opts.displayName ?? "opencode",
        defaultModel: opts.defaultModel,
        staticModels: opts.staticModels,
        threadAbbr: opts.threadAbbr,
        effort: opts.effort ?? { mechanism: "none", levels: [] },
        spawn() {
            // `detached: true` makes the child a process-group leader so AgentRuntime's
            // cancel() (`process.kill(-pid)`) reaps opencode plus any tools it spawned.
            return spawn(cli, ["acp"], {
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env },
                detached: true,
            });
        },
    };
}
//# sourceMappingURL=opencode.js.map