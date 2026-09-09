/**
 * Probe which agent CLIs are present on this host so `hello` can advertise
 * an inventory. Instantiates `@seam/adapters` factories with conservative
 * defaults — describe/prepare/install do not spawn.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
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
  copilotCatalogProbe?: (launch: CopilotCatalogLaunch) => Promise<CopilotCatalogProbe>;
}

export function resolveCopilotHostLaunch(
  copilotCmd: string,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  baseEnv: NodeJS.ProcessEnv = process.env
): CopilotCatalogLaunch {
  const commandParts = copilotCmd.split(" ");
  const cliPath = commandParts[0]!;
  const args = [
    ...commandParts.slice(1),
    ...(baseEnv.COPILOT_ARGS !== undefined
      ? baseEnv.COPILOT_ARGS.split(" ").filter(Boolean)
      : ["--acp"]),
  ];
  const env: NodeJS.ProcessEnv = { ...baseEnv };
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
  env: NodeJS.ProcessEnv,
  catalogProbe?: (launch: CopilotCatalogLaunch) => Promise<CopilotCatalogProbe>
): AgentAdapter {
  const launch = resolveCopilotHostLaunch(copilotCmd, cwd, {}, env);
  const token = launch.env.GH_TOKEN || launch.env.COPILOT_GITHUB_TOKEN;
  const credentialProfile = token
    ? `github-token-sha256:${createHash("sha256").update(token).digest("hex")}`
    : "default";
  return makeCopilotProfile({
    cliPath: launch.cliPath,
    acpArgs: launch.args,
    cwd: launch.cwd,
    environment: launch.env,
    credentialProfile,
    defaultModel: "gpt-5.4",
    ...(catalogProbe ? { catalogProbe } : {}),
  });
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
  // Resolved once so the existence probe and the profile use the SAME path.
  const claudeCli = env.CLAUDE_CLI_PATH?.trim() || "claude-agent-acp";
  const factories: Array<{ id: string; bin: string; make: () => AgentAdapter }> = [
    {
      id: "copilot",
      bin: copilotCmd,
      make: () => copilotProfileForHost(
        copilotCmd,
        options.cwd ?? process.cwd(),
        env,
        options.copilotCatalogProbe
      ),
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
        defaultModel: env.CLAUDE_DEFAULT_MODEL?.trim() || "default",
        // Credential scope parity: a host pinned to an alternate config dir
        // probes under that dir, exactly as its runtime spawn would.
        ...(env.CLAUDE_CONFIG_DIR?.trim()
          ? { configDir: env.CLAUDE_CONFIG_DIR.trim() }
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
    claude: env.CLAUDE_CLI_PATH ?? "claude-agent-acp",
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
