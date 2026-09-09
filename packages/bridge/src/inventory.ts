/**
 * Probe which agent CLIs are present on this host so `hello` can advertise
 * an inventory. Instantiates `@seam/adapters` factories with conservative
 * defaults — describe/prepare/install do not spawn.
 */
import { execFileSync } from "node:child_process";
import {
  AGENT_ADAPTER_VERSION,
  makeAgyProfile,
  makeAgyOldProfile,
  makeClaudeProfile,
  makeCodexProfile,
  makeCopilotProfile,
  makeGrokProfile,
  type AgentAdapter,
  type HelloAgentInventory,
} from "@seam/adapters";
import path from "node:path";
import os from "node:os";

function commandExists(cmd: string): boolean {
  const bin = cmd.split(" ")[0]!;
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function loadHostAdapters(
  copilotCmd: string,
  exists: (bin: string) => boolean = commandExists
): Map<string, AgentAdapter> {
  const out = new Map<string, AgentAdapter>();
  const agyAcpPath = process.env.AGY_ACP_BIN?.trim();
  const agyBin = process.env.AGY_BIN?.trim();
  const agyVersion = process.env.AGY_VERSION?.trim();
  const agySha256 = process.env.AGY_SHA256?.trim();
  const agyDefaultModel = process.env.AGY_DEFAULT_MODEL?.trim();
  const agyOldBin = process.env.AGY_OLD_CLI_PATH?.trim();
  const agyEnabled = process.env.AGY_ENABLED === "true";
  const agyRiskAcknowledged = process.env.AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED === "true";
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
    ...(agyEnabled && agyAcpPath && agyBin && agyVersion && agySha256 && agyDefaultModel && agyRiskAcknowledged ? [{
      id: "agy",
      bin: agyAcpPath,
      make: () => makeAgyProfile({
        acpPath: agyAcpPath,
        agyBin,
        agyVersion,
        agySha256,
        defaultModel: agyDefaultModel,
        stateDir: process.env.AGY_ACP_STATE_DIR ?? path.join(os.homedir(), ".agy-acp"),
        conversationsDir: process.env.AGY_CONVERSATIONS_DIR ?? path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations"),
        cwd: process.env.AGY_ACP_CWD ?? process.cwd(),
        credentialScope: process.env.AGY_CREDENTIAL_SCOPE ?? "antigravity-oauth:default",
        wrapperVersion: process.env.AGY_ACP_VERSION ?? "",
        wrapperSha256: process.env.AGY_ACP_SHA256 ?? "",
        permissionRiskAcknowledged: true,
      }),
    }] : []),
    ...(process.env.AGY_OLD_ROLLBACK_ENABLED === "true" && agyOldBin ? [{
      id: "agy-old",
      bin: agyOldBin,
      make: () => makeAgyOldProfile({
        cliPath: agyOldBin,
        defaultModel: agyDefaultModel || "antigravity",
      }),
    }] : []),
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
    // Skip before construct so inventory never starts or refreshes an adapter.
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
    agy: process.env.AGY_ACP_BIN ?? "antigravity-acp",
    "agy-old": process.env.AGY_OLD_CLI_PATH ?? "agy-old-disabled",
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
    const runtime = adapter.describe().runtime;
    rows.push({ agentId: id, version, installed, ready: false, ...(runtime ? { runtime } : {}) });
  }
  return rows;
}
