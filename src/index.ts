import path from "node:path";
import { loadConfig, REMOTE_MAC_MODELS } from "./config.js";
import { logger } from "./lib/logger.js";
import { startHealthServer } from "./lib/health.js";
import { SessionStore } from "./core/session-store.js";
import { SessionRouter } from "./core/session-router.js";
import { makeCopilotProfile } from "./agents/profiles/copilot.js";
import { makeClaudeProfile } from "./agents/profiles/claude.js";
import { makeAgyProfile } from "./agents/profiles/agy.js";
import { makeOpencodeProfile, fetchLmStudioModels, syncOpencodeLmStudioConfig } from "./agents/profiles/opencode.js";
import { makeRemoteCopilotServerProfile, makeRemoteCopilotClientProfile } from "./agents/profiles/remote.js";
import { discordRenderer } from "./platforms/discord/renderer.js";
import { DiscordAdapter } from "./platforms/discord/adapter.js";
import { Orchestrator } from "./platforms/discord/orchestrator.js";
import { buildGlobalMcpServers } from "./mcp.js";
import { startTunnelGistPublisher } from "./lib/tunnel-gist.js";
import { ScheduledPromptManager } from "./core/scheduled-prompts/manager.js";

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[BOOT] Loaded REPO_EMOJIS with ${config.REPO_EMOJIS.size} entries.`);
  logger.info(
    {
      agent: config.DEFAULT_AGENT,
      model: config.DEFAULT_MODEL,
      reposRoot: config.REPOS_ROOT,
      dataDir: config.DATA_DIR,
    },
    "seam-acp starting"
  );

  const health = startHealthServer(config.HEALTH_PORT, logger);

  const store = new SessionStore(path.join(config.DATA_DIR, "seam.db"));

  const { servers: mcpServers } = buildGlobalMcpServers(logger, {
    dataDir: config.DATA_DIR,
  });

  const copilot = makeCopilotProfile({
    ...(config.COPILOT_CLI_PATH ? { cliPath: config.COPILOT_CLI_PATH } : {}),
    defaultModel: config.DEFAULT_MODEL,
    staticModels: config.COPILOT_MODELS,
    threadAbbr: "🤖🛢️",
    mcpServers,
  });

  const extraCopilots = config.COPILOT_PROFILES.map((p) =>
    makeCopilotProfile({
      id: `copilot-${p.id}`,
      displayName: `GitHub Copilot (${p.id})`,
      configDir: p.configDir,
      ...(config.COPILOT_CLI_PATH ? { cliPath: config.COPILOT_CLI_PATH } : {}),
      defaultModel: config.DEFAULT_MODEL,
      staticModels: config.COPILOT_MODELS,
      threadAbbr: p.id === "jbulpitt" ? "🤖 👨‍💻" : "🤖",
      mcpServers,
    })
  );

  const claude = makeClaudeProfile({
    ...(config.CLAUDE_CLI_PATH ? { cliPath: config.CLAUDE_CLI_PATH } : {}),
    defaultModel: config.CLAUDE_DEFAULT_MODEL,
    staticModels: config.CLAUDE_MODELS,
    threadAbbr: "👾",
    maxThinkingTokens: config.CLAUDE_MAX_THINKING_TOKENS,
    thinkingDisplay: config.CLAUDE_THINKING_DISPLAY,
    compactionTokenThreshold: config.CLAUDE_COMPACTION_TOKEN_THRESHOLD,
    mcpServers,
  });

  const extraClaudes = config.CLAUDE_PROFILES.map((p) =>
    makeClaudeProfile({
      id: `claude-${p.id}`,
      displayName: `Anthropic Claude (${p.id})`,
      configDir: p.configDir,
      ...(config.CLAUDE_CLI_PATH ? { cliPath: config.CLAUDE_CLI_PATH } : {}),
      defaultModel: config.CLAUDE_DEFAULT_MODEL,
      staticModels: config.CLAUDE_MODELS,
      maxThinkingTokens: config.CLAUDE_MAX_THINKING_TOKENS,
      thinkingDisplay: config.CLAUDE_THINKING_DISPLAY,
      compactionTokenThreshold: config.CLAUDE_COMPACTION_TOKEN_THRESHOLD,
      mcpServers,
    })
  );

  const agy = makeAgyProfile({
    ...(config.AGY_CLI_PATH ? { cliPath: config.AGY_CLI_PATH } : {}),
    defaultModel: config.AGY_DEFAULT_MODEL,
    staticModels: config.AGY_MODELS,
    threadAbbr: "🌌",
    dataDir: config.DATA_DIR,
    printTimeoutSeconds: config.TURN_TIMEOUT_SECONDS,
  });

  // Optional "LM Studio 🦙" agent: opencode (sst/opencode) over ACP, pointed at a
  // local/remote LM Studio via opencode's own config. Provider-agnostic, so it
  // drives local models natively — no Anthropic proxy. The model list is
  // discovered live from LM Studio's /api/v0/models at startup (no hardcoding),
  // and seam-acp writes the matching `models` block into opencode's config —
  // opencode does NOT auto-discover custom providers, so the declared list must
  // track what the server serves. Only registered when OPENCODE_ENABLED.
  let opencodeModels: Array<{ modelId: string; name: string; contextLimit?: number }> | undefined;
  let opencodeDefaultModel = config.OPENCODE_DEFAULT_MODEL;
  if (config.OPENCODE_ENABLED && config.OPENCODE_LMSTUDIO_URL) {
    const discovered = await fetchLmStudioModels(
      config.OPENCODE_LMSTUDIO_URL,
      config.OPENCODE_LMSTUDIO_API_KEY || undefined,
      config.OPENCODE_MODEL_PREFIX,
    ).catch((err) => {
      logger.warn({ err }, "opencode: LM Studio model discovery failed; picker empty until reachable");
      return [];
    });
    if (discovered.length > 0) {
      const opencodeConfigPath =
        config.OPENCODE_CONFIG_PATH ||
        path.join(
          process.env.XDG_CONFIG_HOME || path.join(process.env.HOME ?? "", ".config"),
          "opencode",
          "opencode.json",
        );
      // Pick a real, loaded default so opencode never falls back to its built-in
      // `big-pickle` (no vision): the configured default if it's actually loaded,
      // else the first discovered model.
      opencodeDefaultModel =
        discovered.find((m) => m.modelId === config.OPENCODE_DEFAULT_MODEL)?.modelId ??
        discovered[0]!.modelId;
      // Web-search MCP(s) for the agent. seam-acp manages these keys, reconciling on
      // each sync (disabling a source removes its entry).
      const opencodeMcp: Record<string, unknown> = {};
      if (config.OPENCODE_DDG_SEARCH) {
        opencodeMcp["ddg-search"] = {
          type: "local",
          command: ["npx", "-y", "@oevortex/ddg_search"],
          enabled: true,
          timeout: 20000,
        };
      }
      if (config.OPENCODE_TAVILY_URL) {
        opencodeMcp["tavily"] = { type: "remote", url: config.OPENCODE_TAVILY_URL, enabled: true };
      }
      await syncOpencodeLmStudioConfig({
        configPath: opencodeConfigPath,
        providerKey: config.OPENCODE_MODEL_PREFIX,
        baseURL: config.OPENCODE_LMSTUDIO_URL.replace(/\/+$/, "") + "/v1",
        ...(config.OPENCODE_LMSTUDIO_API_KEY ? { apiKey: config.OPENCODE_LMSTUDIO_API_KEY } : {}),
        defaultModel: opencodeDefaultModel,
        mcp: opencodeMcp,
        mcpManagedKeys: ["ddg-search", "tavily"],
        models: discovered.map((m) => ({
          rawId: m.rawId,
          ...(m.attachment ? { attachment: true } : {}),
          ...(m.toolCall ? { toolCall: true } : {}),
          ...(m.reasoning ? { reasoning: true } : {}),
        })),
      }).catch((err) => logger.warn({ err }, "opencode: config sync failed"));
      opencodeModels = discovered.map(({ modelId, name, contextLimit }) => ({
        modelId,
        name,
        ...(contextLimit ? { contextLimit } : {}),
      }));
    }
    logger.info({ count: discovered.length }, "opencode: discovered LM Studio models");
  }
  const ollama = config.OPENCODE_ENABLED
    ? makeOpencodeProfile({
        id: "opencode",
        displayName: "LM Studio 🔮",
        threadAbbr: "🔮",
        ...(config.OPENCODE_CLI_PATH ? { cliPath: config.OPENCODE_CLI_PATH } : {}),
        defaultModel: opencodeDefaultModel,
        ...(opencodeModels && opencodeModels.length > 0 ? { staticModels: opencodeModels } : {}),
      })
    : undefined;

  // Late-bound so the callback can reference `orchestrator` which isn't created yet.
  let notifyBridgeConnect: (id: string) => void = () => {};

  const remoteCopilots = config.REMOTE_COPILOT_PROFILES.map((p) =>
    p.mode === "server"
      ? makeRemoteCopilotServerProfile({
          id: `copilot-remote-${p.id}`,
          wsPort: p.wsPort,
          token: p.token,
          defaultModel: p.defaultModel ?? config.DEFAULT_MODEL,
          staticModels: p.id === "mac" ? REMOTE_MAC_MODELS : config.COPILOT_MODELS,
          threadAbbr: "🤖 💳",
          restrictDiscordAccess: config.REMOTE_DISCORD_RESTRICTED_PROFILES.has(p.id),
          onBridgeConnect: () => notifyBridgeConnect(`copilot-remote-${p.id}`),
        })
      : makeRemoteCopilotClientProfile({
          id: `copilot-remote-${p.id}`,
          wsUrl: p.wsUrl,
          token: p.token,
          defaultModel: p.defaultModel ?? config.DEFAULT_MODEL,
          staticModels: p.id === "mac" ? REMOTE_MAC_MODELS : config.COPILOT_MODELS,
          threadAbbr: "🤖 💳",
          restrictDiscordAccess: config.REMOTE_DISCORD_RESTRICTED_PROFILES.has(p.id),
          onBridgeConnect: () => notifyBridgeConnect(`copilot-remote-${p.id}`),
        })
  );

  const router = new SessionRouter({
    logger,
    store,
    profiles: [copilot, ...extraCopilots, claude, ...extraClaudes, agy, ...(ollama ? [ollama] : []), ...remoteCopilots],
    defaultAgentId: config.DEFAULT_AGENT,
    defaultModel: config.DEFAULT_MODEL,
    // Legacy DEFAULT_AUTO_APPROVE=true overrides the policy default to "always".
    defaultPermissionMode: config.DEFAULT_AUTO_APPROVE
      ? "always"
      : config.DEFAULT_PERMISSION_POLICY,
    mcpServers,
  });

  const renderer = discordRenderer;

  const adapter: DiscordAdapter = new DiscordAdapter({
    config,
    logger,
    slashHandler: async (interaction) => {
      await orchestrator.handleSlashInteraction(interaction);
    },
  });

  const orchestrator = new Orchestrator({
    logger,
    config,
    adapter,
    router,
    store,
    renderer,
  });

  orchestrator.install();

  // Now that orchestrator exists, wire the bridge-connect notification callback.
  notifyBridgeConnect = (id) =>
    void orchestrator.postNotification(`🟢 Remote bridge connected: ${id}`);

  // Wire the ask-the-user callback now that both the router and the adapter
  // exist. Router calls this when a session's policy is "ask".
  router.setAskUser(async (record, req) => {
    if (!adapter.requestApproval) {
      return { outcome: { outcome: "cancelled" } };
    }
    const channel = {
      platform: record.platform,
      id: record.channelRef,
      ...(record.parentRef ? { parentId: record.parentRef } : {}),
    };
    return adapter.requestApproval(channel, req);
  });

  await adapter.start();

  // Scheduled prompts: arm timers from the DB once Discord is connected (so a
  // catch-up fire can post immediately). onFire runs the schedule as an isolated
  // job and posts output to the thread.
  const scheduledManager = new ScheduledPromptManager({
    store,
    logger: logger.child({ mod: "scheduled" }),
    onFire: (id) => orchestrator.runScheduledPrompt(id),
  });
  orchestrator.setScheduledManager(scheduledManager);
  scheduledManager.start();

  logger.info("seam-acp ready");

  // Best-effort startup notification to a configured channel.
  void orchestrator.postNotification("✅ Seam online.");

  // Publish quick-tunnel URL to gist whenever it changes.
  let stopTunnelGist: (() => void) | undefined;
  if (config.TUNNEL_GIST_ID) {
    const urlFile = path.join(config.DATA_DIR, "tunnel-url.txt");
    stopTunnelGist = startTunnelGistPublisher(config.TUNNEL_GIST_ID, urlFile, logger);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    orchestrator.stopSentinelWatcher();
    scheduledManager.stop();
    stopTunnelGist?.();
    try {
      await adapter.stop();
    } catch (err) {
      logger.warn({ err }, "adapter stop failed");
    }
    try {
      await router.disposeAll();
    } catch (err) {
      logger.warn({ err }, "router disposeAll failed");
    }
    try {
      store.close();
    } catch {
      /* ignore */
    }
    health.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
