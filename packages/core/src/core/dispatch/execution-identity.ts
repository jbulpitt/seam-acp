import { createHash } from "node:crypto";
import { hostname, homedir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Conservative private fingerprint. Never persist credentials or raw env.
 * A credential/config rotation may require an operator's explicit identity
 * reconciliation; that is preferable to silently continuing on a new account.
 * Remote slots require a separate host-side ownership protocol, not this hash.
 */
export function executionIdentity(selection: unknown): string {
  const providerEnv = Object.keys(process.env).sort()
    .filter(k => /^(CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_|COPILOT_|GITHUB_|GH_|GEMINI_|GOOGLE_|GROK_|XAI_|OLLAMA_)/.test(k))
    .map(k => [k, process.env[k]]);
  const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  const privateFileHashes = ["auth.json", "config.toml"].map(name => {
    try { return createHash("sha256").update(readFileSync(path.join(codexHome, name))).digest("hex"); }
    catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable"; }
  });
  return createHash("sha256").update(JSON.stringify({
    selection, host: hostname(), uid: process.getuid?.(), home: homedir(), codexHome,
    providerEnv, privateFileHashes,
  })).digest("hex");
}
