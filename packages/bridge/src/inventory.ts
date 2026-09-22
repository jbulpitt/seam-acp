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
  makeAgyNativeRuntime,
  makeAgyUnpinnedRuntime,
  standingAgyPinKeys,
  describeProvenanceMode,
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
import path from "node:path";
import os from "node:os";

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
  /** #330: observe a strict adapter refusing to load instead of it killing the bridge. */
  onAdapterRefused?: (agentId: string, reason: string) => void;
  /**
   * #329: structured, secret-free evidence that an installed/configured
   * adapter was omitted. The bridge keeps serving every adapter that did load.
   */
  onAdapterUnavailable?: (refusal: HostAdapterRefusal) => void;
}

export interface HostAdapterRefusal {
  agentId: string;
  code: "configuration_incomplete" | "executable_unavailable" | "runtime_refused";
  missing?: string[];
}

export interface HostAdapterInventory {
  adapters: Map<string, AgentAdapter>;
  adapterRefusals: HostAdapterRefusal[];
}

const AGY_NATIVE_REQUIREMENTS = [
  "AGY_ENABLED=true",
  "AGY_CLI_PATH (absolute)",
  "AGY_DEFAULT_MODEL",
  "AGY_VERSION",
  "AGY_SHA256",
  "AGY_RUNTIME_ROOT (absolute)",
] as const;

function reportUnavailable(
  options: HostAdapterRuntimeOptions,
  refusal: HostAdapterRefusal,
): void {
  const missing = refusal.missing?.length
    ? `; missing or invalid: ${refusal.missing.join(", ")}`
    : "";
  // Refuse only this adapter. The bridge and every independently loadable
  // adapter keep serving; this names the code-upgrade loss that was silent on
  // macbook-pro and home-hub (#329).
  console.error(
    `[bridge] adapter ${refusal.agentId} unavailable (${refusal.code})${missing}; ` +
    "adapter will not be advertised, but the bridge and other adapters remain available",
  );
  options.onAdapterUnavailable?.(refusal);
}

export function resolveCopilotHostLaunch(
  copilotCmd: string,
  cwd: string,
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
  return { cliPath, args, cwd, env };
}

function copilotProfileForHost(
  copilotCmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  catalogProbe?: (launch: CopilotCatalogLaunch) => Promise<CopilotCatalogProbe>
): AgentAdapter {
  const launch = resolveCopilotHostLaunch(copilotCmd, cwd, env);
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
  const agyBin = env.AGY_BIN?.trim();
  const agyVersion = env.AGY_VERSION?.trim();
  const agySha256 = env.AGY_SHA256?.trim();
  const agyRuntimeRoot = env.AGY_RUNTIME_ROOT?.trim();
  const agyDefaultModel = env.AGY_DEFAULT_MODEL?.trim();
  const agyModels = parseConfiguredModels(env.AGY_MODELS);
  const agyNativeBin = env.AGY_CLI_PATH?.trim() || env.AGY_OLD_CLI_PATH?.trim() || agyBin;
  const agyEnabled = env.AGY_ENABLED === "true" || env.AGY_OLD_ROLLBACK_ENABLED === "true";
  const agyExplicitlyDisabled = env.AGY_ENABLED === "false" && env.AGY_OLD_ROLLBACK_ENABLED !== "true";
  const agyUnpinned = env.AGY_PIN?.trim() === "unpinned";
  const agyCandidate = agyUnpinned && agyEnabled ? "agy" : (agyNativeBin || "agy");
  const agyExecutableAvailable = !agyExplicitlyDisabled && exists(agyCandidate);
  const standingPin = standingAgyPinKeys(env);
  const agyMissing = agyUnpinned && agyEnabled
    ? [
        ...(!agyDefaultModel ? [AGY_NATIVE_REQUIREMENTS[2]] : []),
        ...(standingPin.length
          ? [`AGY_PIN=unpinned still has ${standingPin.join(", ")}`]
          : []),
      ]
    : [
        ...(!agyEnabled ? [AGY_NATIVE_REQUIREMENTS[0]] : []),
        ...(!agyNativeBin || !path.isAbsolute(agyNativeBin) ? [AGY_NATIVE_REQUIREMENTS[1]] : []),
        ...(!agyDefaultModel ? [AGY_NATIVE_REQUIREMENTS[2]] : []),
        ...(!agyVersion ? [AGY_NATIVE_REQUIREMENTS[3]] : []),
        ...(!agySha256 ? [AGY_NATIVE_REQUIREMENTS[4]] : []),
        ...(!agyRuntimeRoot || !path.isAbsolute(agyRuntimeRoot) ? [AGY_NATIVE_REQUIREMENTS[5]] : []),
      ];
  if (!agyExplicitlyDisabled && (agyEnabled || agyExecutableAvailable)) {
    if (agyMissing.length > 0) {
      reportUnavailable(options, {
        agentId: "agy",
        code: "configuration_incomplete",
        missing: agyMissing,
      });
    } else if (!agyExecutableAvailable) {
      reportUnavailable(options, { agentId: "agy", code: "executable_unavailable" });
    }
  }
  const agyLoadable = agyEnabled && agyMissing.length === 0 && agyExecutableAvailable;
  // Copilot is licensed per-seat and may be entitled to one project only. Unlike
  // every other adapter here, "is the binary on PATH" is the wrong question for
  // it — a reinstall must not silently re-enable a seat this host is not
  // licensed to use. Mirrors AGY_ENABLED: explicit opt-out, refused loudly.
  const copilotExplicitlyDisabled = env.COPILOT_ENABLED === "false";
  const factories: Array<{
    id: string;
    bin: string;
    make: () => AgentAdapter;
    strict?: boolean;
    disabled?: boolean;
  }> = [
    {
      id: "copilot",
      bin: copilotCmd,
      disabled: copilotExplicitlyDisabled,
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
    ...(agyLoadable ? [{
      id: "agy",
      bin: agyUnpinned ? "agy" : agyNativeBin!,
      strict: true,
      make: () => makeAgyProfile({
        runtime: agyUnpinned
          ? makeAgyUnpinnedRuntime({
              credentialScope: env.AGY_CREDENTIAL_SCOPE ?? "antigravity-oauth:default",
              cwd: options.cwd ?? process.cwd(),
              baseEnv: env,
            })
          : makeAgyNativeRuntime({
              executable: agyNativeBin!,
              runtimeRoot: agyRuntimeRoot!,
              version: agyVersion!,
              sha256: agySha256!,
              credentialScope: env.AGY_CREDENTIAL_SCOPE ?? "antigravity-oauth:default",
              cwd: options.cwd ?? process.cwd(),
              baseEnv: env,
            }),
        defaultModel: agyDefaultModel!,
        staticModels: agyModels,
      }),
    }] : []),
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
    // Explicit opt-out outranks discovery: refuse before probing the binary, so
    // the reason recorded is the licence decision rather than "not installed".
    if (f.disabled) {
      options.onAdapterUnavailable?.({ agentId: f.id, code: "configuration_incomplete" });
      continue;
    }
    // Skip before construct so inventory never starts or refreshes an adapter.
    if (!exists(f.bin)) continue;
    try {
      out.set(f.id, f.make());
      if (f.strict) {
        // Mode is null until a snapshot is actually opened (prepare()), so say
        // "pending" rather than assert a platform default — the two disagree
        // for a Node fixture on darwin. #330 review. Unpinned never opens one.
        const provenance = f.id === "agy" && agyUnpinned
          ? "unpinned (no digest; ordinary PATH binary)"
          : (describeProvenanceMode() ?? "pending first launch");
        console.error(`[bridge] adapter ${f.id} loaded; provenance mode: ${provenance}`);
      }
    } catch (error) {
      // Factory threw (missing optional deps) — skip.
      //
      // #330: a strict adapter must NOT be able to take the bridge down with
      // it. Rethrowing here escaped loadHostAdapters and killed the process,
      // so one agent failing verification became a HOST outage — and on a
      // single-agent host those are the same event with very different blast
      // radii. An agy provenance failure on macOS took an entire laptop
      // offline this way. Refuse the agent loudly and keep serving the rest.
      const reason = error instanceof Error ? error.message : String(error);
      if (f.strict) {
        // Refusal is the case you most want the mode for, so report it here too.
        console.error(
          `[bridge] adapter ${f.id} refused to load (provenance mode: ${describeProvenanceMode() ?? "not reached"}): ${reason}`
        );
        options.onAdapterRefused?.(f.id, reason);
        options.onAdapterUnavailable?.({ agentId: f.id, code: "runtime_refused" });
      }
    }
  }
  return out;
}

/**
 * The production bridge startup boundary: keep the usable adapter map and the
 * reasons omitted adapters were refused as one result so rollout evidence
 * cannot accidentally discard the diagnostic half (#329).
 */
export function loadHostAdapterInventory(
  copilotCmd: string,
  options: HostAdapterRuntimeOptions = {},
): HostAdapterInventory {
  const adapterRefusals: HostAdapterRefusal[] = [];
  const onAdapterUnavailable = options.onAdapterUnavailable;
  const adapters = loadHostAdapters(copilotCmd, {
    ...options,
    onAdapterUnavailable: (refusal) => {
      adapterRefusals.push(refusal);
      onAdapterUnavailable?.(refusal);
    },
  });
  return { adapters, adapterRefusals };
}

export function inventoryFromAdapters(
  adapters: Map<string, AgentAdapter>,
  copilotCmd: string,
  env: NodeJS.ProcessEnv = process.env
): HelloAgentInventory[] {
  const bins: Record<string, string> = {
    copilot: copilotCmd,
    claude: env.CLAUDE_CLI_PATH ?? "claude-agent-acp",
    agy: env.AGY_PIN?.trim() === "unpinned"
      ? "agy"
      : env.AGY_CLI_PATH?.trim() || env.AGY_OLD_CLI_PATH?.trim() || env.AGY_BIN?.trim() || "agy",
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
    const runtime = adapter.describe().runtime;
    rows.push({ agentId: id, version, installed, ready: false, ...(runtime ? { runtime } : {}) });
  }
  return rows;
}
