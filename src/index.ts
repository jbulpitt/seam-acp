import path from "node:path";
import { loadConfig } from "./config.js";
import { logger } from "./lib/logger.js";
import { startHealthServer } from "./lib/health.js";
import { SessionStore } from "./core/session-store.js";
import { SessionRouter } from "./core/session-router.js";
import { makeCopilotProfile } from "./agents/profiles/copilot.js";
import { makeGeminiProfile } from "./agents/profiles/gemini.js";
import { makeClaudeProfile } from "./agents/profiles/claude.js";
import { makeRemoteCopilotServerProfile, makeRemoteCopilotClientProfile } from "./agents/profiles/remote.js";
import { discordRenderer } from "./platforms/discord/renderer.js";
import { DiscordAdapter } from "./platforms/discord/adapter.js";
import { Orchestrator } from "./platforms/discord/orchestrator.js";
import { buildGlobalMcpServers } from "./mcp.js";
import { startTunnelGistPublisher } from "./lib/tunnel-gist.js";

async function main(): Promise<void> {
  const config = loadConfig();
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
    mcpServers,
  });

  const extraCopilots = config.COPILOT_PROFILES.map((p) =>
    makeCopilotProfile({
      id: `copilot-${p.id}`,
      displayName: `GitHub Copilot (${p.id})`,
      configDir: p.configDir,
      ...(config.COPILOT_CLI_PATH ? { cliPath: config.COPILOT_CLI_PATH } : {}),
      defaultModel: config.DEFAULT_MODEL,
      mcpServers,
    })
  );

  const gemini = makeGeminiProfile({
    ...(config.GEMINI_CLI_PATH ? { cliPath: config.GEMINI_CLI_PATH } : {}),
    defaultModel: config.GEMINI_DEFAULT_MODEL,
    mcpServers,
  });

  const extraGeminis = config.GEMINI_PROFILES.map((p) =>
    makeGeminiProfile({
      id: `gemini-${p.id}`,
      displayName: `Google Gemini (${p.id})`,
      configDir: p.configDir,
      ...(config.GEMINI_CLI_PATH ? { cliPath: config.GEMINI_CLI_PATH } : {}),
      defaultModel: config.GEMINI_DEFAULT_MODEL,
      mcpServers,
    })
  );

  const claude = makeClaudeProfile({
    ...(config.CLAUDE_CLI_PATH ? { cliPath: config.CLAUDE_CLI_PATH } : {}),
    defaultModel: config.CLAUDE_DEFAULT_MODEL,
    mcpServers,
  });

  const extraClaudes = config.CLAUDE_PROFILES.map((p) =>
    makeClaudeProfile({
      id: `claude-${p.id}`,
      displayName: `Anthropic Claude (${p.id})`,
      configDir: p.configDir,
      ...(config.CLAUDE_CLI_PATH ? { cliPath: config.CLAUDE_CLI_PATH } : {}),
      defaultModel: config.CLAUDE_DEFAULT_MODEL,
      mcpServers,
    })
  );

  const remoteCopilots = config.REMOTE_COPILOT_PROFILES.map((p) =>
    p.mode === "server"
      ? makeRemoteCopilotServerProfile({
          id: `copilot-remote-${p.id}`,
          wsPort: p.wsPort,
          token: p.token,
          defaultModel: p.defaultModel ?? config.DEFAULT_MODEL,
        })
      : makeRemoteCopilotClientProfile({
          id: `copilot-remote-${p.id}`,
          wsUrl: p.wsUrl,
          token: p.token,
          defaultModel: p.defaultModel ?? config.DEFAULT_MODEL,
        })
  );

  const router = new SessionRouter({
    logger,
    store,
    profiles: [copilot, ...extraCopilots, gemini, ...extraGeminis, claude, ...extraClaudes, ...remoteCopilots],
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
