/** Passive inventory, also sent verbatim over the existing rollout SSH transport.
 * No agent executable is run: #415 showed that even --version can self-update.
 * Inventory is filesystem evidence, NOT a claim about the active provider binding.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const VERSION = /^v?(\d+\.\d+\.\d+)$/;
const PACKAGES = {
  codex: "@openai/codex", claude: "@anthropic-ai/claude-code",
  copilot: "@github/copilot",
  "codex-acp": "@agentclientprotocol/codex-acp",
  "claude-agent-acp": "@agentclientprotocol/claude-agent-acp",
};
async function read(file) { try { return await fs.readFile(file, "utf8"); } catch { return null; } }
async function dirs(file) { try { return await fs.readdir(file); } catch { return []; } }
const version = (s) => VERSION.exec(s ?? "")?.[1] ?? null;

export async function observeHost({ home = os.homedir(), checkout, node = process.execPath } = {}) {
  const nvm = path.join(home, ".nvm");
  const installed = (await dirs(path.join(nvm, "versions/node"))).filter((v) => version(v));
  const roots = new Set([
    path.resolve(path.dirname(node), "../lib/node_modules"),
    path.join(home, ".seam/lib/node_modules"),
    ...installed.map((v) => path.join(nvm, "versions/node", v, "lib/node_modules")),
    ...(checkout ? [path.join(checkout, "node_modules")] : []),
  ]);
  const artifacts = [];
  for (const [agent, name] of Object.entries(PACKAGES)) {
    for (const root of roots) {
      try {
        const pkg = JSON.parse(await read(path.join(root, name, "package.json")));
        if (pkg?.name === name && version(pkg.version)) {
          artifacts.push({ agent, version: version(pkg.version), source: "npm-package-manifest", binding: "installation-only" });
        }
      } catch { /* One missing/invalid manifest leaves only that artifact unknown. */ }
    }
  }
  // Native CLIs with version-addressed links can be inventoried without running
  // them. An unversioned agy/grok binary is deliberately unknown, not executed.
  for (const agent of ["grok", "claude", "agy"]) {
    for (const dir of [path.join(home, ".local/bin"), path.join(home, ".seam/bin")]) {
      try {
        const resolved = await fs.realpath(path.join(dir, agent));
        const match = agent === "claude"
          ? /\/versions\/(\d+\.\d+\.\d+)$/.exec(resolved)
          : new RegExp(`/${agent}-(\\d+\\.\\d+\\.\\d+)-(?:linux|darwin)-(?:x64|arm64|aarch64)$`).exec(resolved);
        if (match) artifacts.push({ agent, version: match[1], source: "version-addressed-link", binding: "installation-only" });
      } catch { /* Missing link is not proof the agent is absent. */ }
    }
  }
  const initial = (await read(path.join(nvm, "alias/default")))?.trim();
  let selector = initial;
  const visited = new Set();
  // Resolve only nvm's declarative alias files; never source startup scripts.
  // A cycle/unrecognized selector makes this default unknown, not all hosts bad.
  while (selector && /^[a-zA-Z0-9_/*.-]{1,80}$/.test(selector) && !visited.has(selector)) {
    if (selector.split("/").includes("..")) break;
    visited.add(selector);
    const next = await read(path.join(nvm, "alias", selector));
    if (next === null) break;
    selector = next.trim();
  }
  let selected = null;
  if (/^v?\d+(?:\.\d+){0,2}$/.test(selector ?? "")) {
    const prefix = selector.replace(/^v/, "");
    selected = installed.map(version).filter((v) => v === prefix || v.startsWith(`${prefix}.`))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? null;
  }
  return {
    schemaVersion: 1,
    artifacts: [...new Map(artifacts.map((a) => [`${a.agent}:${a.version}:${a.source}`, a])).values()],
    defaultNode: {
      status: selected ? "observed" : "unknown", version: selected,
      basis: "nvm-alias-files-and-installed-directories",
      // A floating alias is a recreation risk even when it happens to match today.
      floating: Boolean(initial && !/^v?\d+\.\d+\.\d+$/.test(initial)),
    },
  };
}

// The rollout shell runs stdin as `node --input-type=module - <target args>`.
// Importing this module in offline tests does not collect host data.
if (process.argv[1] === "-" || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const remote = process.argv[1] === "-";
  // An administrative SSH account can inspect a different user's service in
  // preflight. Its HOME is not that service owner's nvm default (#494). Refuse
  // only this inventory, not the preflight, publisher discovery or other hosts.
  const result = remote && process.getuid?.() !== Number(args[3])
    ? { schemaVersion: 1, artifacts: [], defaultNode: { status: "unknown" }, reason: "ssh-user-differs-from-service-owner" }
    : await observeHost(remote ? { checkout: args[4], node: args[6] } : { checkout: process.cwd() });
  console.log(JSON.stringify(result));
}
