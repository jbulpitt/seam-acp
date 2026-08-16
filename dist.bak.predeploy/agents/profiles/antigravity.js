import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Bridge script lives at <project-root>/scripts/agy-acp-bridge.mjs.
// Compiled profile is at dist/agents/profiles/, so go up three levels.
const BRIDGE_SCRIPT = path.resolve(__dirname, "../../../scripts/agy-acp-bridge.mjs");
/**
 * Google Antigravity CLI (agy) as an ACP server via a bridge script.
 *
 * The `agy` CLI does not natively support `--acp`, so we run a small bridge
 * (`scripts/agy-acp-bridge.mjs`) that speaks ACP on stdio and delegates
 * each prompt turn to `agy -p` (print mode). Conversation history is
 * preserved across turns using `agy --conversation <uuid>`.
 *
 * Auth is handled by whatever OAuth token `agy` already has on this machine
 * (~/.gemini/antigravity-cli/antigravity-oauth-token).
 *
 * Multi-account: not currently supported by `agy`; `configDir` is accepted
 * for future use but has no effect on the CLI binary today.
 */
export function makeAntigravityProfile(opts) {
    const cliPath = opts.cliPath?.trim() || "agy";
    const agyHome = path.join(os.homedir(), ".gemini", "antigravity-cli");
    let identityCache;
    return {
        id: opts.id ?? "antigravity",
        displayName: opts.displayName ?? "Google Antigravity",
        defaultModel: opts.defaultModel,
        spawn() {
            return spawn(process.execPath, [BRIDGE_SCRIPT], {
                stdio: ["pipe", "pipe", "pipe"],
                env: {
                    ...process.env,
                    AGY_CLI_PATH: cliPath,
                    AGY_HOME: agyHome,
                },
            });
        },
        async whoami() {
            if (identityCache !== undefined)
                return identityCache;
            identityCache = await readAntigravityIdentity(agyHome);
            return identityCache;
        },
    };
}
/**
 * Try to read the authenticated Google account from the Gemini/Antigravity
 * CLI data directory. Falls back gracefully on any error.
 */
async function readAntigravityIdentity(agyHome) {
    // The Gemini CLI stores the active account in google_accounts.json one
    // level up from the app data dir (i.e. ~/.gemini/google_accounts.json).
    const accountsFile = path.join(agyHome, "..", "google_accounts.json");
    try {
        const raw = await fsp.readFile(accountsFile, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.active === "string" && parsed.active.length > 0) {
            return { login: parsed.active };
        }
    }
    catch {
        /* fall through */
    }
    return null;
}
//# sourceMappingURL=antigravity.js.map