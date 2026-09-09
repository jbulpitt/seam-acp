/**
 * Probe which agent CLIs are present on this host so `hello` can advertise
 * an inventory. Instantiates `@seam/adapters` factories with conservative
 * defaults — describe/prepare/install do not spawn.
 */
import { execFileSync } from "node:child_process";
import {
  AGENT_ADAPTER_VERSION,
  makeAgyProfile,
  makeClaudeProfile,
  makeCodexProfile,
  makeCopilotProfile,
  makeGrokProfile,
  type AgentAdapter,
  type CopilotCatalogLaunch,
  type CopilotCatalogProbe,
  type HelloAgentInventory,
} from "@seam/adapters";

function commandExists(cmd: string): boolean {
  const bin = cmd.split(" ")[0]!;
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function resolveCopilotHostLaunch(
  copilotCmd: string,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {}
): CopilotCatalogLaunch {
  const commandParts = copilotCmd.split(" ");
  const cliPath = commandParts[0]!;
  const args = [
    ...commandParts.slice(1),
    ...(process.env.COPILOT_ARGS !== undefined
      ? process.env.COPILOT_ARGS.split(" ").filter(Boolean)
      : ["--acp"]),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!env.GH_TOKEN) {
    try {
      env.GH_TOKEN = execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // The ACP probe will report auth failure without exposing credentials.
    }
  }
  Object.assign(env, extraEnv);
  return { cliPath, args, cwd, env };
}

function copilotProfileForHost(
  copilotCmd: string,
  cwd: string,
  catalogProbe?: (launch: CopilotCatalogLaunch) => Promise<CopilotCatalogProbe>
): AgentAdapter {
  const launch = resolveCopilotHostLaunch(copilotCmd, cwd);
  return makeCopilotProfile({
    cliPath: launch.cliPath,
    acpArgs: launch.args,
    cwd: launch.cwd,
    environment: launch.env,
    defaultModel: "gpt-5.4",
    ...(catalogProbe ? { catalogProbe } : {}),
  });
}

export function loadHostAdapters(
  copilotCmd: string,
  cwd: string,
  exists: (bin: string) => boolean = commandExists,
  copilotCatalogProbe?: (launch: CopilotCatalogLaunch) => Promise<CopilotCatalogProbe>
): Map<string, AgentAdapter> {
  const out = new Map<string, AgentAdapter>();
  const factories: Array<{ id: string; bin: string; make: () => AgentAdapter }> = [
    {
      id: "copilot",
      bin: copilotCmd,
      make: () => copilotProfileForHost(copilotCmd, cwd, copilotCatalogProbe),
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
      bin: "grok",
      make: () => makeGrokProfile({ defaultModel: "grok-4" }),
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
  copilotCmd: string
): HelloAgentInventory[] {
  const bins: Record<string, string> = {
    copilot: copilotCmd,
    claude: process.env.CLAUDE_CLI_PATH ?? "claude-agent-acp",
    agy: "agy",
    codex: "codex-acp",
    grok: "grok",
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
