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
  makeOpencodeProfile,
  type AgentAdapter,
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

export function loadHostAdapters(copilotCmd: string): Map<string, AgentAdapter> {
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
      id: "opencode",
      bin: process.env.OPENCODE_CLI_PATH ?? "opencode",
      make: () => makeOpencodeProfile({ defaultModel: "default" }),
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
    opencode: process.env.OPENCODE_CLI_PATH ?? "opencode",
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
