import { makeCodexProfile, makeAgyNativeRuntime, makeAgyUnpinnedRuntime } from "@seam/adapters";
import type { Config } from "../../config.js";
import type { Logger } from "../../lib/logger.js";
import type { QuotaProfile } from "./usage-provider.js";
import { shouldRegisterOllamaCloud } from "../parked-agents.js";

/** Account quota still uses controller credentials, independently of host availability. */
export function controllerQuotaProfiles(config: Config, logger: Logger) {
  const profiles: QuotaProfile[] = [
    { id: "copilot", displayName: "GitHub Copilot" },
    ...config.COPILOT_PROFILES.map(p => ({ id: `copilot-${p.id}`, displayName: `GitHub Copilot (${p.id})`, configDir: p.configDir })),
    { id: "claude", displayName: "Anthropic Claude" },
    ...config.CLAUDE_PROFILES.map(p => ({ id: `claude-${p.id}`, displayName: `Anthropic Claude (${p.id})`, configDir: p.configDir })),
    ...(config.GROK_ENABLED ? [{ id: "grok", displayName: "xAI Grok" }] : []),
    ...(config.ZAI_ENABLED && config.ZAI_API_KEY ? [{ id: "zai", displayName: "Z.ai (Zhipu GLM)", brand: "z-ai" }] : []),
    ...(shouldRegisterOllamaCloud(config) ? [{ id: "ollama-cloud", displayName: "Ollama Cloud" }] : []),
  ];
  if (config.CODEX_ENABLED) {
    const codex = makeCodexProfile({
      ...(config.CODEX_CLI_PATH ? { cliPath: config.CODEX_CLI_PATH } : {}),
      defaultModel: config.CODEX_DEFAULT_MODEL, staticModels: config.CODEX_MODELS,
    });
    profiles.push({ id: codex.id, displayName: codex.displayName, accountUsage: codex.accountUsage });
  }
  let agyRuntime: ReturnType<typeof makeAgyNativeRuntime> | ReturnType<typeof makeAgyUnpinnedRuntime> | undefined;
  try {
    agyRuntime = !(config.AGY_ENABLED || config.AGY_OLD_ROLLBACK_ENABLED)
      ? undefined
      : config.AGY_PIN === "unpinned"
        ? makeAgyUnpinnedRuntime({ credentialScope: config.AGY_CREDENTIAL_SCOPE, cwd: process.cwd(), baseEnv: process.env })
        : makeAgyNativeRuntime({
            executable: config.AGY_CLI_PATH!, runtimeRoot: config.AGY_RUNTIME_ROOT!,
            version: config.AGY_VERSION, sha256: config.AGY_SHA256,
            credentialScope: config.AGY_CREDENTIAL_SCOPE, cwd: process.cwd(), baseEnv: process.env,
          });
  } catch (error) {
    config.agyDisabledReason = (error as Error).message;
    logger.error({ err: error }, "AGY quota unavailable; unrelated agents remain enabled");
  }
  if (agyRuntime) profiles.push({ id: "agy", displayName: "Antigravity", runtime: agyRuntime.descriptor });
  return { profiles, agyRuntime };
}
