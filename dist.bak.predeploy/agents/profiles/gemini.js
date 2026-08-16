import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
/**
 * Google Gemini CLI as an ACP server (`gemini --acp`).
 *
 * Gemini's CLI honors MCP servers from `~/.gemini/settings.json` plus
 * an optional `--allowed-mcp-server-names` allowlist. It does not
 * accept an inline MCP config flag the way Copilot does, so the
 * `mcpServers` option is accepted for parity but currently unused;
 * configure servers in `~/.gemini/settings.json` and list the names
 * you want enabled here (via env var) if you need to restrict them.
 *
 * Multi-account: set `configDir` to an alternate home directory. The
 * Gemini CLI honors `GEMINI_CLI_HOME` as a home-directory override —
 * it reads/writes all state (auth tokens, credentials, settings,
 * session history) under `$GEMINI_CLI_HOME/.gemini/`. So each profile
 * gets a fully isolated Gemini CLI sharing one binary.
 */
export function makeGeminiProfile(opts) {
    const cli = opts.cliPath?.trim() || "gemini";
    const allow = opts.allowedMcpServerNames?.filter(Boolean) ?? [];
    const configDir = opts.configDir?.trim() || undefined;
    let identityCache;
    return {
        id: opts.id ?? "gemini",
        displayName: opts.displayName ?? "Google Gemini",
        defaultModel: opts.defaultModel,
        staticModels: opts.staticModels,
        threadAbbr: opts.threadAbbr,
        spawn() {
            const args = ["--acp"];
            if (allow.length > 0) {
                args.push("--allowed-mcp-server-names", ...allow);
            }
            const env = { ...process.env };
            if (configDir)
                env.GEMINI_CLI_HOME = configDir;
            return spawn(cli, args, {
                stdio: ["pipe", "pipe", "pipe"],
                env,
                detached: true,
            });
        },
        async whoami() {
            if (identityCache !== undefined)
                return identityCache;
            identityCache = await readGeminiIdentity(configDir);
            return identityCache;
        },
    };
}
/**
 * Read the active Google account from Gemini's `google_accounts.json`.
 * Returns null on any failure.
 */
async function readGeminiIdentity(configDir) {
    const home = configDir ?? (process.env.HOME ?? "");
    const file = path.join(home, ".gemini", "google_accounts.json");
    try {
        const raw = await fsp.readFile(file, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.active === "string" && parsed.active.length > 0) {
            return { login: parsed.active };
        }
        return null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=gemini.js.map