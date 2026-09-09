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

export function loadHostAdapters(
  copilotCmd: string,
  exists: (bin: string) => boolean = commandExists
): Map<string, AgentAdapter> {
  const out = new Map<string, AgentAdapter>();
  // Resolved once so the existence probe and the profile use the SAME path.
  const claudeCli = process.env.CLAUDE_CLI_PATH?.trim() || "claude-agent-acp";
  const factories: Array<{ id: string; bin: string; make: () => AgentAdapter }> = [
    {
      id: "copilot",
      bin: copilotCmd,
      make: () => makeCopilotProfile({ defaultModel: "gpt-5.4" }),
    },
    {
      id: "claude",
      bin: claudeCli,
      // #232: the remote host must collect the SAME direct-Anthropic live
      // catalog the controller does. Without `directAnthropic` the profile fell
      // back to a one-row validated manifest, and without `cliPath` it probed
      // whatever `claude-agent-acp` was on PATH rather than the executable this
      // host is actually configured to run — so remote and local disagreed
      // about both the strategy and the binary.
      make: () => makeClaudeProfile({
        cliPath: claudeCli,
        directAnthropic: true,
        // The host's own configured identity. `default` is the alias the
        // wrapper always advertises, so it resolves without inventing one; a
        // configured id that this host cannot publish fails the fetch closed
        // rather than silently selecting some other model.
        defaultModel: process.env.CLAUDE_DEFAULT_MODEL?.trim() || "default",
        // Credential scope parity: a host pinned to an alternate config dir
        // probes under that dir, exactly as its runtime spawn would.
        ...(process.env.CLAUDE_CONFIG_DIR?.trim()
          ? { configDir: process.env.CLAUDE_CONFIG_DIR.trim() }
          : {}),
      }),
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
