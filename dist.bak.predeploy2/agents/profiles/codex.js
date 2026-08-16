import { spawn } from "node:child_process";
/**
 * OpenAI Codex CLI as an ACP server, via the official adapter
 * `@agentclientprotocol/codex-acp` (binary `codex-acp`).
 *
 * Setup on the host (one-time):
 *   npm i -g @openai/codex @agentclientprotocol/codex-acp
 *   codex auth                # complete the API-key flow
 *
 * The Codex adapter speaks ACP over stdio just like claude-agent-acp.
 * It honors the standard ACP session/new → session/prompt flow.
 *
 * Reasoning effort: Codex surfaces effort as an ACP config option
 * `reasoning_effort` (same as Copilot — both are OpenAI-backed).
 * Applied post-session-create via setSessionConfigOption in AgentRuntime.
 */
export function makeCodexProfile(opts) {
    const cli = opts.cliPath?.trim() || "codex-acp";
    return {
        id: opts.id ?? "codex",
        displayName: opts.displayName ?? "OpenAI Codex",
        defaultModel: opts.defaultModel,
        staticModels: opts.staticModels,
        threadAbbr: opts.threadAbbr,
        // Codex uses the same configOption effort mechanism as Copilot (both OpenAI).
        effort: opts.effort ?? {
            mechanism: "configOption",
            configId: "reasoning_effort",
            levels: ["low", "medium", "high"],
        },
        spawn() {
            const env = { ...process.env };
            if (opts.extraEnv) {
                for (const [k, v] of Object.entries(opts.extraEnv)) {
                    if (v !== undefined)
                        env[k] = v;
                }
            }
            return spawn(cli, [], {
                stdio: ["pipe", "pipe", "pipe"],
                env,
                detached: true,
            });
        },
    };
}
//# sourceMappingURL=codex.js.map