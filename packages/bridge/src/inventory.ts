/**
 * Probe which agent CLIs are present on this host so `hello` can advertise
 * an inventory. Instantiates `@seam/adapters` factories with conservative
 * defaults — describe/prepare/install do not spawn.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import {
  AGENT_ADAPTER_VERSION,
  makeAgyProfile,
  makeClaudeProfile,
  makeCodexProfile,
  makeCopilotProfile,
  makeGrokProfile,
  type AgentAdapter,
  type HelloAgentInventory,
} from "@seam/adapters";

function commandExists(cmd: string): boolean {
  try {
    accessSync(cmd, constants.X_OK);
    return true;
  } catch {
    // COPILOT_CMD historically permits fixed arguments; configured Grok paths
    // are tried exactly above, including paths containing spaces.
  }
  const bin = cmd.trim().split(/\s+/, 1)[0]!;
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface HostAdapterRuntimeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (bin: string) => boolean;
}

function parseConfiguredModels(raw: string | undefined): Array<{ modelId: string; name: string }> | undefined {
  const models = (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf(":");
    return separator > 0 && separator < entry.length - 1
      ? { modelId: entry.slice(0, separator).trim(), name: entry.slice(separator + 1).trim() }
      : { modelId: entry, name: entry };
  });
  return models.length ? models : undefined;
}

export function loadHostAdapters(
  copilotCmd: string,
  options: HostAdapterRuntimeOptions = {}
): Map<string, AgentAdapter> {
  const env = options.env ?? process.env;
  const exists = options.exists ?? commandExists;
  const grokCli = env.GROK_CLI_PATH?.trim() || "grok";
  const grokCatalogMode = env.GROK_CATALOG_MODE?.trim() || "subscription";
  const grokModels = parseConfiguredModels(env.GROK_MODELS);
  const out = new Map<string, AgentAdapter>();
  const factories: Array<{ id: string; bin: string; make: () => AgentAdapter }> = [
    {
      id: "copilot",
      bin: copilotCmd,
      make: () => makeCopilotProfile({ defaultModel: "gpt-5.4" }),
    },
    {
      id: "claude",
      bin: process.env.CLAUDE_CLI_PATH ?? "claude-agent-acp",
      make: () => makeClaudeProfile({ defaultModel: "claude-sonnet-4.5" }),
    },
    {
      id: "agy",
      bin: "agy",
      make: () => makeAgyProfile({ defaultModel: "default" }),
    },
    {
      id: "codex",
      bin: "codex-acp",
      make: () => makeCodexProfile({ defaultModel: "gpt-5.5" }),
    },
    {
      id: "grok",
      bin: grokCli,
      make: () => {
        if (grokCatalogMode !== "subscription" && grokCatalogMode !== "api-key") {
          throw new Error("GROK_CATALOG_MODE must be subscription or api-key");
        }
        return makeGrokProfile({
          cliPath: grokCli,
          defaultModel: env.GROK_DEFAULT_MODEL?.trim() || "grok-4.6",
          catalogMode: grokCatalogMode,
          ...(grokCatalogMode === "api-key" && env.GROK_API_KEY
            ? { apiKey: env.GROK_API_KEY }
            : {}),
          ...(grokModels ? { staticModels: grokModels } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
          baseEnv: env,
        });
      },
    },
  ];
  for (const f of factories) {
    // Skip before construct: agy's factory warms a catalog by spawning `agy`
    // (ENOENT is an unhandled 'error' and kills the whole bridge process).
    if (!exists(f.bin)) continue;
    try {
      out.set(f.id, f.make());
    } catch {
      // Factory threw (missing optional deps) — skip.
    }
  }
  return out;
}

export function inventoryFromAdapters(
  adapters: Map<string, AgentAdapter>,
  copilotCmd: string,
  env: NodeJS.ProcessEnv = process.env
): HelloAgentInventory[] {
  const bins: Record<string, string> = {
    copilot: copilotCmd,
    claude: process.env.CLAUDE_CLI_PATH ?? "claude-agent-acp",
    agy: "agy",
    codex: "codex-acp",
    grok: env.GROK_CLI_PATH?.trim() || "grok",
  };
  const rows: HelloAgentInventory[] = [];
  for (const [id, adapter] of adapters) {
    let installed = commandExists(bins[id] ?? id);
    let version = AGENT_ADAPTER_VERSION;
    try {
      version = adapter.describe().version;
    } catch {
      /* keep default */
    }
    rows.push({ agentId: id, version, installed, ready: false });
  }
  return rows;
}
