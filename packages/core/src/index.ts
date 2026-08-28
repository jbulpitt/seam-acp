import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, isChannelLocked, resolveThreadLocation, adminParticipantOverlapIds, GROK_STATIC_MODELS, ZAI_STATIC_MODELS, OLLAMA_CLOUD_STATIC_MODELS } from "./config.js";
import { hostEmoji } from "./core/location.js";
import { LoopbackHost } from "./core/loopback-host.js";
import { logger } from "./lib/logger.js";
import { startHealthServer } from "./lib/health.js";
import { SessionStore } from "./core/session-store.js";
import { SessionRouter } from "./core/session-router.js";
import { makeCopilotProfile } from "@seam/adapters";
import { makeClaudeProfile } from "@seam/adapters";
import { makeAgyProfile, scrubStaleGlobalSeamStdio } from "@seam/adapters";
import { makeOpencodeProfile, fetchLmStudioModels, syncOpencodeLmStudioConfig } from "@seam/adapters";
import { makeCodexProfile } from "@seam/adapters";
import { makeGrokProfile, fetchXaiModels } from "@seam/adapters";
import { discordRenderer } from "./platforms/discord/renderer.js";
import { DiscordAdapter } from "./platforms/discord/adapter.js";
import { Orchestrator } from "./platforms/discord/orchestrator.js";
import { buildGlobalMcpServers } from "./mcp.js";
import { startTunnelGistPublisher } from "./lib/tunnel-gist.js";
import { ScheduledPromptManager } from "./core/scheduled-prompts/manager.js";
import { WakeManager } from "./core/wake/manager.js";
import { ParkedPromptManager } from "./core/parked-prompts/manager.js";
import { WatchManager } from "./core/watch/manager.js";
import { LiveHelpManager } from "./core/live-help/manager.js";
import { ThreadVoiceManager } from "./core/thread-voice/manager.js";
import { VoiceLeaseManager } from "./core/voice-lease.js";
import { evaluateWatch } from "./core/watch/evaluate.js";
import { DispatchWatcher } from "./core/dispatch/watcher.js";
import { dispatchDirs, enqueueDispatchSpec, type DispatchSpec } from "./core/dispatch/types.js";
import { SeamTokenRegistry } from "./core/mcp/token-registry.js";
import { SeamMcpServer } from "./core/mcp/seam-mcp-server.js";
import { watchChannelPresets } from "./core/config-reload.js";
import { BridgeHub } from "./core/bridge-hub.js";
import { ServerStatusCard } from "./core/server-status-card.js";
import type { BridgeAgent } from "./core/server-status.js";
import { ChoiceResultHub } from "./core/choice/result.js";
import { ChoiceIngest } from "./core/choice/ingest.js";
import { CardGifCatalog } from "./core/card-gifs.js";
import { resolveIngestPublicBase, resolvePublicBridgeWsUrl } from "./core/mcp-url.js";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { QuotaRegistry } from "./core/quota/quota-registry.js";
import {
  AgentQuotaPoller,
  createAgentQuotaSources,
} from "./core/quota/quota-poller.js";
import { AgentQuotaCard } from "./core/quota/agent-quota-card.js";

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
  // #74: an id in BOTH admin and participant sets is an admin, not a restricted
  // participant. Silently picking one is how a privilege bug hides — name them.
  const adminParticipantOverlap = adminParticipantOverlapIds(config);
  if (adminParticipantOverlap.length > 0) {
    logger.warn(
      { overlappingUserIds: adminParticipantOverlap },
      `SEAM_CONFIG_ADMIN_USER_IDS and SEAM_PARTICIPANT_USER_IDS overlap — admin wins; these ids are NOT restricted participants: ${adminParticipantOverlap.join(", ")}`
    );
  }

  let mcpHttpHandle:
    | ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>)
    | undefined;
  let ingestHttpHandle:
    | ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>)
    | undefined;
  const health = startHealthServer(config.HEALTH_PORT, logger, {
    onMcp: (req, res) => {
      if (!mcpHttpHandle) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "mcp not ready" }));
        return;
      }
      return mcpHttpHandle(req, res);
    },
    onIngest: (req, res) => {
      if (!ingestHttpHandle) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ingest not ready" }));
        return;
      }
      return ingestHttpHandle(req, res);
    },
  });

  const store = new SessionStore(path.join(config.DATA_DIR, "seam.db"));
  // #75: crash leftovers stay `dispatched`/`running` forever unless we flip
  // them here. Target / correlation / acp_session_id are preserved for resume.
  // Does not delete isolated ACP sessions — #76 decides whether to reattach.
  const orphaned = store.reconcileOrphanedDelegations();
  if (orphaned > 0) {
    logger.warn(
      { count: orphaned },
      "reconciled orphaned delegation ledger rows as interrupted"
    );
  }

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

  // Optional Vertex AI Claude profile: same claude-agent-acp binary, but with
  // CLAUDE_CODE_USE_VERTEX=1 and GCP project/region injected per-spawn so the
  // standard `claude` profile stays on the direct Anthropic API.
  const claudeVertex = config.CLAUDE_VERTEX_PROJECT_ID
    ? makeClaudeProfile({
        id: "claude-vertex",
        displayName: "Claude (Vertex AI)",
        brand: "vertex",
        ...(config.CLAUDE_CLI_PATH ? { cliPath: config.CLAUDE_CLI_PATH } : {}),
        defaultModel: config.CLAUDE_DEFAULT_MODEL,
        staticModels: config.CLAUDE_MODELS,
        threadAbbr: "👾☁️",
        maxThinkingTokens: config.CLAUDE_MAX_THINKING_TOKENS,
        thinkingDisplay: config.CLAUDE_THINKING_DISPLAY,
        compactionTokenThreshold: config.CLAUDE_COMPACTION_TOKEN_THRESHOLD,
        mcpServers,
        extraEnv: {
          CLAUDE_CODE_USE_VERTEX: "1",
          ANTHROPIC_VERTEX_PROJECT_ID: config.CLAUDE_VERTEX_PROJECT_ID,
          CLOUD_ML_REGION: config.CLAUDE_VERTEX_REGION,
        },
      })
    : undefined;

  const agy = makeAgyProfile({
    ...(config.AGY_CLI_PATH ? { cliPath: config.AGY_CLI_PATH } : {}),
    defaultModel: config.AGY_DEFAULT_MODEL,
    staticModels: config.AGY_MODELS,
    threadAbbr: "🌌",
    dataDir: config.DATA_DIR,
    printTimeoutSeconds: config.TURN_TIMEOUT_SECONDS,
    mcpServers,
  });
  scrubStaleGlobalSeamStdio();

  // Optional OpenAI Codex agent via @agentclientprotocol/codex-acp.
  const codex = config.CODEX_ENABLED
    ? makeCodexProfile({
        ...(config.CODEX_CLI_PATH ? { cliPath: config.CODEX_CLI_PATH } : {}),
        defaultModel: config.CODEX_DEFAULT_MODEL,
        // No static list: codex-acp advertises its current catalog in session/new,
        // so the picker uses that live list (always up to date). CODEX_MODELS still
        // overrides if an operator wants to pin a custom set.
        staticModels: config.CODEX_MODELS,
        threadAbbr: "🧬",
      })
    : undefined;

  // Optional xAI Grok Build agent — speaks ACP natively via `grok agent stdio`.
  // When GROK_API_KEY is set and no explicit GROK_MODELS override, discover the
  // live model list from xAI's /v1/models endpoint so the picker stays current.
  let grokModels: Array<{ modelId: string; name: string; contextLimit?: number }> | undefined;
  if (config.GROK_ENABLED && !config.GROK_MODELS && config.GROK_API_KEY) {
    const discovered = await fetchXaiModels(config.GROK_API_KEY).catch((err) => {
      logger.warn({ err }, "grok: xAI model discovery failed; using static list");
      return [];
    });
    if (discovered.length > 0) {
      grokModels = discovered;
      logger.info({ count: discovered.length }, "grok: discovered xAI models");
    }
  }
  const grok = config.GROK_ENABLED
    ? makeGrokProfile({
        ...(config.GROK_CLI_PATH ? { cliPath: config.GROK_CLI_PATH } : {}),
        defaultModel: config.GROK_DEFAULT_MODEL,
        staticModels: config.GROK_MODELS ?? grokModels ?? GROK_STATIC_MODELS,
        threadAbbr: "🪐",
        ...(config.GROK_API_KEY ? { extraEnv: { XAI_API_KEY: config.GROK_API_KEY } } : {}),
      })
    : undefined;

  // Optional Z.ai (Zhipu) agent: Claude Code (claude-agent-acp) pointed at Z.ai's
  // Anthropic-compatible endpoint.  Uses GLM models (glm-5.2 flagship, 1M context).
  // Only registered when ZAI_ENABLED and ZAI_API_KEY are set.
  const zai = config.ZAI_ENABLED && config.ZAI_API_KEY
    ? makeClaudeProfile({
        id: "zai",
        displayName: "Z.ai (Zhipu GLM)",
        brand: "z-ai",
        defaultModel: config.ZAI_DEFAULT_MODEL,
        staticModels: config.ZAI_MODELS ?? ZAI_STATIC_MODELS,
        threadAbbr: "🀄",
        // GLM models don't support Anthropic's effort mechanism.
        effort: { mechanism: "none" as const, levels: [] },
        extraEnv: {
          ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          ANTHROPIC_API_KEY: config.ZAI_API_KEY,
        },
      })
    : undefined;

  // Optional Ollama Cloud agent: Claude Code (claude-agent-acp) pointed at
  // Ollama's Anthropic-compatible endpoint.  Runs open-weight models
  // (qwen3-coder 480B, deepseek-v3.1 671B, etc.) on Ollama's cloud GPUs.
  // Only registered when OLLAMA_CLOUD_ENABLED and OLLAMA_CLOUD_API_KEY are set.
  const ollamaCloud = config.OLLAMA_CLOUD_ENABLED && config.OLLAMA_CLOUD_API_KEY
    ? makeClaudeProfile({
        id: "ollama-cloud",
        displayName: "Ollama Cloud",
        brand: "ollama-cloud",
        defaultModel: config.OLLAMA_CLOUD_DEFAULT_MODEL,
        staticModels: config.OLLAMA_CLOUD_MODELS ?? OLLAMA_CLOUD_STATIC_MODELS,
        configDir: path.join(process.env.HOME ?? "", ".claude-ollama-cloud"),
        threadAbbr: "🦙☁️",
        // Ollama Cloud's Anthropic /v1/messages maps output_config.effort →
        // native think levels (low|medium|high|max; xhigh→high). Empirically
        // verified 2026-08-20 against kimi-k3:cloud: effort=low collapses
        // thinking; omit-think on the native API matches think=max (Moonshot's
        // K3 default). Claude Code Options.effort is the same field. Do NOT
        // also send thinking.type=enabled — that shadows effort and forces
        // boolean think=true.
        effort: {
          mechanism: "meta" as const,
          levels: ["low", "medium", "high", "max"],
        },
        extraEnv: {
          ANTHROPIC_BASE_URL: "https://ollama.com",
          // Ollama Cloud expects Authorization: Bearer — ANTHROPIC_AUTH_TOKEN
          // sends the key as a Bearer token; ANTHROPIC_API_KEY would send it
          // via x-api-key which Ollama rejects (401).
          ANTHROPIC_AUTH_TOKEN: config.OLLAMA_CLOUD_API_KEY,
          // Remap claude-agent-acp's internal model aliases so it doesn't try
          // to resolve "claude-sonnet-5" etc. against Ollama's endpoint.
          ANTHROPIC_DEFAULT_SONNET_MODEL: config.OLLAMA_CLOUD_DEFAULT_MODEL,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: config.OLLAMA_CLOUD_DEFAULT_MODEL,
          ANTHROPIC_DEFAULT_OPUS_MODEL: config.OLLAMA_CLOUD_DEFAULT_MODEL,
          ANTHROPIC_MODEL: config.OLLAMA_CLOUD_DEFAULT_MODEL,
        },
      })
    : undefined;

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

  // Agent-facing seam-MCP surface (#24). The shared HTTP server binds its port
  // later (after the adapter is up), so the router gets the token registry now
  // and a late-bound port getter; per-session injection happens at runtime start.
  const seamTokenRegistry = new SeamTokenRegistry({
    persistPath: path.join(config.DATA_DIR, "mcp-session-tokens.json"),
  });
  let seamMcpServer: SeamMcpServer | undefined;
  let bridgeHub: BridgeHub | undefined;

  const router = new SessionRouter({
    logger,
    store,
    profiles: [copilot, ...extraCopilots, claude, ...extraClaudes, ...(claudeVertex ? [claudeVertex] : []), agy, ...(codex ? [codex] : []), ...(grok ? [grok] : []), ...(zai ? [zai] : []), ...(ollamaCloud ? [ollamaCloud] : []), ...(ollama ? [ollama] : [])],
    defaultAgentId: config.DEFAULT_AGENT,
    defaultModel: config.DEFAULT_MODEL,
    // Legacy DEFAULT_AUTO_APPROVE=true overrides the policy default to "always".
    defaultPermissionMode: config.DEFAULT_AUTO_APPROVE
      ? "always"
      : config.DEFAULT_PERMISSION_POLICY,
    mcpServers,
    ...(config.SEAM_MCP_ENABLED
      ? {
          seamMcp: {
            registry: seamTokenRegistry,
            // `.port` throws before the server binds; treat unbound as "not yet
            // available" so an early runtime start just skips injection.
            getPort: () => {
              try {
                return seamMcpServer?.port;
              } catch {
                return undefined;
              }
            },
            getLoopbackUrl: () => `http://127.0.0.1:${config.HEALTH_PORT}/mcp`,
            getPublicUrl: () => bridgeHub?.mcpUrlForRemote(),
            isRemoteSession: (sessionId) => !!bridgeHub?.sessionBridgeId(sessionId),
            mcpServersForRemoteSpawn: (sessionId) =>
              bridgeHub?.mcpServersForRemoteSpawn(sessionId),
            muxForSession: (sessionId) => {
              const id = bridgeHub?.sessionBridgeId(sessionId);
              return id ? bridgeHub?.muxFor(id) ?? bridgeHub?.get(id)?.mux : undefined;
            },
            bindSessionLocation: (sessionId, location) => {
              bridgeHub?.markSessionBridge(sessionId, location);
            },
          },
        }
      : {}),
    channelPresets: config.channelPresets,
    threadPresets: config.threadPresets,
    bindSessionLocation: (sessionId, location) => {
      bridgeHub?.markSessionBridge(sessionId, location);
    },
  });

  const quotaRegistry = new QuotaRegistry();
  const quotaPoller = new AgentQuotaPoller({
    logger,
    registry: quotaRegistry,
    sources: createAgentQuotaSources(router.listProfiles(), {
      agyCliPath: config.AGY_CLI_PATH,
      grokCliPath: config.GROK_CLI_PATH,
      ollamaUsageCliPath: config.OLLAMA_USAGE_CLI_PATH,
    }),
    staleRetentionMs: config.QUOTA_STALE_RETENTION_MS,
  });

  const renderer = discordRenderer;

  const adapter: DiscordAdapter = new DiscordAdapter({
    config,
    logger,
    slashHandler: async (interaction) => {
      await orchestrator.handleSlashInteraction(interaction);
    },
    autocompleteHandler: async (interaction) => {
      await orchestrator.handleAutocompleteInteraction(interaction);
    },
  });

  const orchestrator = new Orchestrator({
    logger,
    config,
    adapter,
    router,
    store,
    renderer,
    quotaPoller,
  });

  orchestrator.install();

  const choiceResults = new ChoiceResultHub({
    store,
    logger: logger.child({ mod: "choice-result" }),
  });
  orchestrator.setChoiceResults(choiceResults);
  const ingestPublicBase = (): string => {
    let tunnel: string | null = null;
    try {
      tunnel = fs.readFileSync(path.join(config.DATA_DIR, "tunnel-url.txt"), "utf8").trim() || null;
    } catch {
      tunnel = null;
    }
    const ws = resolvePublicBridgeWsUrl({
      configured: config.SEAM_BRIDGE_PUBLIC_URL,
      tunnelUrl: tunnel,
      healthPort: config.HEALTH_PORT,
    });
    return resolveIngestPublicBase({
      ingestPublicUrl: config.SEAM_INGEST_PUBLIC_URL,
      bridgeWsUrl: ws,
      healthPort: config.HEALTH_PORT,
    });
  };
  const choiceIngest = new ChoiceIngest({
    store,
    results: choiceResults,
    logger: logger.child({ mod: "ingest" }),
    enqueue: (spec) => enqueueDispatchSpec(config.DATA_DIR, spec),
    destLive: (card, optionIndex) => orchestrator.inspectChoiceDestLive(card, optionIndex),
    authoringSession: (channelRef) => store.getByChannel("discord", channelRef),
    publicBase: ingestPublicBase,
    waitMs: config.SEAM_INGEST_WAIT_MS,
    bodyMax: config.SEAM_INGEST_BODY_MAX,
    ratePerMin: config.SEAM_INGEST_RATE_PER_MIN,
    defaultModel: config.DEFAULT_MODEL,
  });
  orchestrator.setIngestUrl(() => choiceIngest.ingestUrl());
  ingestHttpHandle = (req, res) => choiceIngest.handle(req, res);

  bridgeHub = new BridgeHub({
    logger,
    config,
    httpServer: health,
    mutation: orchestrator.getConfigMutation(),
    getMcpPort: () => {
      try {
        return seamMcpServer?.port;
      } catch {
        return undefined;
      }
    },
    getMcpRegistry: () => seamTokenRegistry,
    healthPort: config.HEALTH_PORT,
    dataDir: config.DATA_DIR,
  });
  orchestrator.setBridgeHub(bridgeHub);
  bridgeHub.setLoopback(
    new LoopbackHost({
      adapters: router.listProfiles(),
      workspaceRoot: config.REPOS_ROOT,
    })
  );

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
  // Seed one normalized snapshot per configured agent before MCP/card startup,
  // then let each agent's own recent turn rate drive its recursive poll timer.
  await quotaPoller.start();

  // Start the shared seam-MCP server now that the adapter exists (peek reads
  // threads through it). Its ephemeral port feeds the router's late-bound
  // getPort, so per-session injection works from here on. The tools only
  // enqueue dispatch specs / read threads — the DispatchWatcher + report-back
  // do the rest.
  if (config.SEAM_MCP_ENABLED) {
    seamMcpServer = new SeamMcpServer({
      logger,
      resolveSession: (token) => {
        const sid = seamTokenRegistry.resolve(token);
        if (!sid) return undefined;
        return store.get(sid) ?? orchestrator.resolveIngestJob(sid);
      },
      enqueueDispatch: (spec) => enqueueDispatchSpec(config.DATA_DIR, spec),
      getAgentQuotas: (agentId) => {
        if (!agentId) return quotaRegistry.all();
        const quota = quotaRegistry.get(agentId);
        return quota ? [quota] : [];
      },
      // Agent-scheduled wake events (#59): arm/cancel a one-shot self-resumption
      // for the calling thread. The orchestrator owns the loop-safety guards and
      // the DB row; the WakeManager sweeper fires it via the dispatch queue.
      scheduleWake: (record, req) => orchestrator.scheduleWake(record, req),
      cancelWake: (record, id) => orchestrator.cancelWake(record, id),
      createChoice: (record, spec) => orchestrator.createChoice(record, spec),
      cancelChoice: (record, id) => orchestrator.cancelChoice(record, id),
      submitResult: (record, value) => orchestrator.submitChoiceResult(record, value),
      createIngest: (record, spec) => orchestrator.createIngest(record, spec),
      cancelIngest: (record, id) => orchestrator.cancelIngest(record, id),
      createLiveHelp: (record, spec) => orchestrator.createLiveHelp(record, spec),
      cancelLiveHelp: (record, id) => orchestrator.cancelLiveHelp(record, id),
      // Agent-defined watches (#60): register/cancel/list a bridge-evaluated
      // condition trigger for the calling thread. The orchestrator owns the
      // guards (including the D8 command gate) and the DB row; the WatchManager
      // sweeper evaluates the predicate and fires via the dispatch queue.
      createWatch: (record, req) =>
        orchestrator.createWatch(record, req as Parameters<typeof orchestrator.createWatch>[1]),
      cancelWatch: (record, id) => orchestrator.cancelWatch(record, id),
      listWatches: (record) =>
        orchestrator.listWatches(record.platform, record.channelRef).map((w) => ({
          id: w.id,
          kind: w.kind,
          spec: w.spec,
          intervalSeconds: w.intervalSeconds,
          mode: w.mode,
          fireCount: w.fireCount,
          maxFires: w.maxFires,
          expiresAtUtc: w.expiresAtUtc,
          reason: w.reason,
        })),
      // Durable multi-hop chains (#25): create the chain row and pop hop 1, so
      // the `chain` tool can enqueue the first dispatch. The runtime advances
      // the rest (Orchestrator.advanceChain).
      createChain: ({ hops, originRef, promptPreview }) => {
        const chainId = randomUUID();
        store.createChain({ id: chainId, hops, originRef, promptPreview: promptPreview ?? null });
        const advanced = store.advanceChain(chainId);
        if (!advanced?.nextHop) {
          throw new Error("chain requires at least one worker");
        }
        return { chainId, firstHop: advanced.nextHop };
      },
      ...(adapter.fetchThreadMessages
        ? {
            peekThread: async (threadId: string, count: number) => {
              const msgs = await adapter.fetchThreadMessages!({
                platform: "discord",
                id: threadId,
              });
              return msgs.slice(-count);
            },
          }
        : {}),
      // #73: discover the addressable teammate threads in the caller's OWN
      // channel. Composes the per-channel SQL query (listSessionsByParent — NOT
      // an in-memory filter over list(100), so a quiet-but-bound thread past the
      // global newest-N cap still surfaces), the DERIVED busy read + config
      // precedence from the router, and the platform's thread-name/live-state
      // lookups. Self-scoped: the channel is record.parentRef, never an arg.
      listThreads: async (record) => {
        if (!record.parentRef) return [];
        const siblings = store.listSessionsByParent(record.platform, record.parentRef);
        return Promise.all(
          siblings.map(async (s) => {
            const cfg = router.describeConfig(s);
            let name: string | null = null;
            let status: "active" | "archived" | "gone" = "active";
            try {
              name =
                (await adapter.getThreadName?.({ platform: s.platform, id: s.channelRef })) ??
                null;
            } catch {
              name = null;
            }
            try {
              const live = adapter.getThreadLiveState
                ? await adapter.getThreadLiveState({ platform: s.platform, id: s.channelRef })
                : { locked: false, archived: false };
              // undefined ⇒ platform confirmed the thread is gone; {archived} ⇒
              // dormant but still bound; otherwise addressable now.
              if (live === undefined) status = "gone";
              else if (live.archived) status = "archived";
            } catch {
              // Transient lookup failure — treat as active rather than hiding it.
              status = "active";
            }
            const location = resolveThreadLocation(config, s.channelRef);
            const host = location === "local" ? undefined : config.bridgePresets.get(location);
            return {
              id: s.channelRef,
              name,
              isSelf: s.id === record.id,
              agent: cfg.agent.value,
              model: cfg.model.value,
              cwd: cfg.cwd.value,
              busy: router.isBusy(s.id),
              status,
              lastActivityUtc: s.updatedUtc,
              location,
              hostEmoji: hostEmoji(host, location),
            };
          })
        );
      },
      // #58 P1: read-only config introspection. describeConfig re-derives the
      // exact precedence startRuntime applies (which layer won); listConfigEntities
      // projects the schedules/presets visible to the calling thread. Both are
      // scoped to the token-resolved caller — no cross-thread reads.
      describeConfig: (record) => router.describeConfig(record),
      listConfigEntities: (record) => ({
        // #69: FULL schedule definitions (incl. promptText + id), not the thin
        // name/cron/tz listing — so an agent can describe AND target a schedule.
        schedules: store
          .listScheduledByChannel(record.platform, record.channelRef)
          .map((s) => ({
            id: s.id,
            name: s.name,
            promptText: s.promptText,
            cron: s.cron,
            timezone: s.timezone,
            enabled: s.enabled,
            sessionMode: s.sessionMode,
            model: s.model,
            cwd: s.cwd,
            targetChannel: s.targetChannel,
            outputType: s.outputType,
            catchupSeconds: s.catchupSeconds,
            attachments: s.attachments.map((a) => a.filename),
            lastStatus: s.lastStatus,
            lastRunUtc: s.lastRunUtc,
            nextRunUtc: s.nextRunUtc,
          })),
        presets: store.listPresetsForProject(record.parentRef).map((p) => ({
          name: p.name,
          scope: p.projectRef ? ("project" as const) : ("global" as const),
          agentId: p.agentId,
          model: p.model,
          effort: p.effort,
          permission: p.permission,
          cwd: p.repoPath,
          description: p.description,
          statusCardStyle: p.statusCardStyle,
        })),
      }),
      // #58 D2: the mutation tool refuses in a locked channel — enforced in the
      // tool layer via this predicate (read from the presets file, the source of
      // truth), never from a model-supplied value.
      isChannelLocked: (record) => isChannelLocked(config, record.parentRef ?? undefined),
      // #71: the propose gate's lock exemption — config admins (if configured)
      // may propose in a locked channel, but ONLY when the current turn's
      // harness-stamped speaker id is in the set. `currentSpeakerId` returns that
      // id (undefined when speaker identity is off or the turn has no human
      // author), so with the flag off a locked channel keeps refusing everyone.
      configAdminUserIds: config.SEAM_CONFIG_ADMIN_USER_IDS,
      configParticipantUserIds: config.SEAM_PARTICIPANT_USER_IDS,
      currentSpeakerId: (record) => orchestrator.currentSpeaker(record.channelRef),
      // #58 P2/P3: propose-then-confirm mutation. The orchestrator validates,
      // renders the confirm card, and applies only on a human click (D5),
      // auditing every change (D6).
      proposeConfig: (record, input) => orchestrator.proposeConfig(record, input),
      // Agent-callable thread compaction: the `compact` tool enqueues a
      // kind:"compact" dispatch (non-blocking); the DispatchWatcher invokes this
      // same primitive off-turn and posts the result into the target thread. The
      // dep's presence gates the tool (undefined ⇒ "not supported").
      compactThread: (record, opts) => orchestrator.compactThread(record, opts),
      // Agent inbox (#61): the PRODUCER (`send`) leaves a pull-only message in a
      // target thread's durable inbox — no dispatch, no turn — and the CONSUMER
      // (`poll_inbox`) drains the caller's OWN inbox. The orchestrator owns the
      // store rows + best-effort ledger; delivery is deliver-once-then-delete.
      pushInbox: (caller, to, message, priority) => orchestrator.pushInbox(caller, to, message, priority),
      drainInbox: (record) => orchestrator.drainInbox(record),
      // Preemptive interrupt (#67): `send(interrupt:true)` cancels the target's
      // in-flight turn and issues a fresh directive — the agent-facing twin of
      // `/seam steer now:true`. Suppresses the aborted handoff's report-back.
      interruptRedirect: (caller, to, message, fresh) =>
        orchestrator.interruptRedirect(caller, to, message, fresh),
      renameThread: async (record, name) => {
        if (!adapter.renameThread) {
          return { ok: false, error: "This platform cannot rename threads." };
        }
        try {
          await adapter.renameThread(
            {
              platform: record.platform,
              id: record.channelRef,
              ...(record.parentRef ? { parentId: record.parentRef } : {}),
            },
            name
          );
          return { ok: true };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
    });
    await seamMcpServer.start();
    mcpHttpHandle = (req, res) => seamMcpServer!.handleRequest(req, res);
  }

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

  // Agent-scheduled wake events (#59): a DB sweeper polls for due one-shot
  // wakes and fires each via the dispatch queue (delete-before-fire, D1). No
  // rehydrate/re-arm — restart-safe by construction (D11). Started after the
  // adapter so a due-at-boot wake can post immediately.
  const wakeManager = new WakeManager({
    store,
    logger: logger.child({ mod: "wake" }),
    onFire: (wake) => orchestrator.fireWake(wake),
  });
  orchestrator.setWakeManager(wakeManager);
  wakeManager.start();

  // Agent-defined watches (#60): a DB sweeper polls each watch's predicate on
  // its interval and fires a turn via the dispatch queue ONLY when a condition
  // trips — the model is never invoked to check (D1). Restart-safe like the wake
  // sweeper. The command source is gated by config (D8): the evaluator re-checks
  // WATCH_COMMAND_ENABLED + the allowlist as a backstop to registration-time
  // refusal, so a command watch persisted before the flag flipped won't run.
  const watchManager = new WatchManager({
    store,
    logger: logger.child({ mod: "watch" }),
    evaluate: (watch) =>
      evaluateWatch(watch, {
        enabled: config.WATCH_COMMAND_ENABLED,
        allowlist: config.WATCH_COMMAND_ALLOWLIST,
      }),
    onFire: (watch, eventText) => orchestrator.fireWatch(watch, eventText),
    onExpire: (watch) => orchestrator.fireWatchExpiry(watch),
    onStopped: (watch, reason) => orchestrator.postWatchStopped(watch, reason),
  });
  orchestrator.setWatchManager(watchManager);
  watchManager.start();

  const voiceLeases = new VoiceLeaseManager();
  const liveHelpManager = new LiveHelpManager({
    store,
    logger: logger.child({ mod: "live-help" }),
    apiKey: () => config.SEAM_GEMINI_API_KEY,
    leases: voiceLeases,
    host: {
      inspectVoiceChannel: (id) => adapter.inspectLiveHelpVoice(id),
      runCall: (opts) => adapter.runLiveHelpCall(opts),
      notify: async (threadId, text) => {
        await adapter.sendMessage({ platform: "discord", id: threadId }, text);
      },
    },
  });
  orchestrator.setLiveHelpManager(liveHelpManager);

  // Operator-dispatch bridge: a trusted process drops a spec into
  // <DATA_DIR>/dispatch/pending/ and the watcher runs it as a turn in the
  // target thread, writing the captured output to done/. Started after the
  // adapter so a dispatch never fires before Discord can receive its output.
  const dispatchWatcher = new DispatchWatcher({
    dataDir: config.DATA_DIR,
    logger: logger.child({ mod: "dispatch" }),
    onDispatch: (spec) => orchestrator.dispatchInjectTurn(spec),
    // Flag-on: mark stale running specs in place (orchestrator stagger-
    // requeues after preconditions). Flag-off: today's recoverStale replay.
    resumeEnabled: config.SEAM_TURN_RESUME_ENABLED,
  });
  orchestrator.setDispatchWatcher(dispatchWatcher);

  const threadVoiceManager = new ThreadVoiceManager({
    store,
    logger: logger.child({ mod: "thread-voice" }),
    leases: voiceLeases,
    host: {
      inspectOwnerVoiceState: (userId, guildId) =>
        adapter.inspectThreadVoiceOwner(userId, guildId),
      runSession: (opts) => adapter.runThreadVoiceSession(opts),
      speak: (sessionId, pcm) => adapter.speakThreadVoice(sessionId, pcm),
      waitForPlaybackIdle: (sessionId) =>
        adapter.waitForThreadVoicePlaybackIdle(sessionId),
      stopPlayback: (sessionId) => adapter.stopThreadVoicePlayback(sessionId),
      notify: (threadId, event) => orchestrator.notifyThreadVoice(threadId, event),
    },
    dispatch: {
      isHomeThreadBusy: (session) => orchestrator.isChannelBusy(session.channelRef),
      inspectArtifact: async (id) => {
        const dirs = dispatchDirs(config.DATA_DIR);
        if (fs.existsSync(path.join(dirs.done, `${id}.json`))) return "done";
        if (fs.existsSync(path.join(dirs.running, `${id}.json`))) return "running";
        if (fs.existsSync(path.join(dirs.pending, `${id}.json`))) return "pending";
        return "missing";
      },
      enqueue: async (request) => {
        const spec: DispatchSpec = {
          id: request.id,
          target: request.target,
          prompt: request.prompt,
          session: "live",
          kind: "thread_voice",
          authorId: request.authorId,
          authorName: request.authorName,
          threadVoiceSessionId: request.threadVoiceSessionId,
          createdUtc: request.createdUtc,
        };
        await enqueueDispatchSpec(config.DATA_DIR, spec);
      },
    },
  });
  orchestrator.setThreadVoiceManager(threadVoiceManager);
  // Reconcile both durable products before either can claim a boot lease.
  // Live Help v1 cannot reconnect, so its in-flight rows end first; eligible
  // muted Thread Voice rows may then reacquire and reconnect.
  liveHelpManager.reconcileOnBoot();
  await threadVoiceManager.reconcileOnBoot();
  await threadVoiceManager.recoverDispatches();
  // Only now may durable specs run: Thread Voice verification, settlement,
  // lease reconciliation, and recovery bookkeeping are all installed first.
  await dispatchWatcher.start();

  // #88: parked prompts wait on onBridgeReady (no timer). Start after the
  // dispatch watcher so a boot-time fire can enqueue immediately. Rehydrate
  // fires any row whose host is already ready.
  const parkedManager = new ParkedPromptManager({
    store,
    hub: bridgeHub!,
    logger: logger.child({ mod: "parked" }),
    onFire: (parked) => orchestrator.fireParked(parked),
    // #89: a reconnect must not fire a `/seam queue` row while that thread's
    // current turn is still running (D5/D9 — park stays cancellable).
    isChannelBusy: (channelRef) => orchestrator.isChannelBusy(channelRef),
  });
  orchestrator.setParkedManager(parkedManager);
  parkedManager.start();

  const cardGifs = new CardGifCatalog({
    url: config.SIMPLE_CARD_GIF_MANIFEST_URL,
    logger: logger.child({ mod: "card-gifs" }),
  });
  orchestrator.setCardGifs(cardGifs);
  cardGifs.start();

  // #76: reconcile live-turn markers (always) and auto-resume if the flag
  // is on. SIGTERM/disposeAll above leave markers intact — this is the
  // path that acts on them. Fire-and-forget so boot is not blocked by
  // long resumes; the stagger gate caps concurrency.
  void orchestrator.recoverInterruptedTurns().catch((err) =>
    logger.warn({ err }, "turn-resume recovery failed")
  );

  // P0 (#58): hot-reload data/channel-presets.json. The watcher mutates the
  // SAME map objects the router and orchestrator hold (config.channelPresets /
  // config.threadPresets), so an edit takes effect on the next turn with no
  // redeploy. Validated + atomic — a bad edit is rejected and the prior good
  // config is kept (see core/config-reload.ts).
  let stopPresetsWatch: (() => void) | undefined;
  if (config.CHANNEL_PRESETS_FILE) {
    stopPresetsWatch = watchChannelPresets(
      config.CHANNEL_PRESETS_FILE,
      {
        channelPresets: config.channelPresets,
        threadPresets: config.threadPresets,
        bridgePresets: config.bridgePresets,
      },
      logger
    );
  }

  logger.info("seam-acp ready");

  // Operator-controlled, one-shot batch migration. Missing sentinel is a
  // silent no-op; malformed input is logged without taking the bot down.
  void orchestrator.runPendingThreadMigration().catch((err) =>
    logger.error({ err }, "pending thread migration failed")
  );

  // Best-effort startup notification to a configured channel.
  void orchestrator.postNotification("✅ Seam online.");

  // One pinned quota card for every configured agent. Poller refreshes poke it;
  // the controller edits in place and silently self-bumps its thread every 20h.
  let stopQuotaCard: (() => void) | undefined;
  if (config.DISCORD_AGENT_QUOTA_THREAD_ID) {
    const quotaCard = new AgentQuotaCard({
      logger,
      adapter,
      threadId: config.DISCORD_AGENT_QUOTA_THREAD_ID,
      dataDir: config.DATA_DIR,
      collect: () => quotaRegistry.all(),
    });
    quotaPoller.setOnUpdate(() => quotaCard.poke());
    stopQuotaCard = () => {
      quotaPoller.setOnUpdate(undefined);
      quotaCard.stop();
    };
    void quotaCard.start().catch((err) =>
      logger.warn({ err }, "agent quota card failed to start")
    );
  }

  // One editable server-status card (uptime / turns / bridges). Posts once,
  // then edits in place — 30s tick + immediate bump on bridge connect/drop.
  let stopStatusCard: (() => void) | undefined;
  if (config.DISCORD_STATUS_THREAD_ID && bridgeHub) {
    const hub = bridgeHub;
    const statusCard = new ServerStatusCard({
      logger,
      adapter,
      threadId: config.DISCORD_STATUS_THREAD_ID,
      dataDir: config.DATA_DIR,
      collect: () => {
        const mem = process.memoryUsage();
        const connected = hub.connectedIds();
        const emojiByAgent = new Map(
          router.listProfiles().map((p) => [p.id, p.threadAbbr] as const)
        );
        const bridges = [...config.bridgePresets.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((b) => {
            const conn = hub.get(b.id);
            const agents: BridgeAgent[] = [];
            if (conn) {
              for (const [id, info] of conn.agents) {
                if (!info.installed) continue;
                agents.push({
                  id,
                  emoji: emojiByAgent.get(id),
                  ready: info.ready,
                });
              }
            }
            return {
              id: b.id,
              emoji: b.emoji,
              shortName: b.shortName,
              connected: connected.has(b.id),
              os: conn?.host.os,
              arch: conn?.host.arch,
              connectedAt: conn?.connectedAt,
              agents,
              devMode: conn?.devMode,
              waiting: store.countParkedByLocation(b.id),
            };
          });
        return {
          nowUtc: Date.now(),
          startedUtc: Date.now() - process.uptime() * 1000,
          pid: process.pid,
          nodeVersion: process.version,
          memoryRssBytes: mem.rss,
          memoryHeapUsedBytes: mem.heapUsed,
          activeTurns: orchestrator.activeTurnCount(),
          liveRuntimes: router.liveRuntimeCount(),
          sessions: store.countSessions(),
          pendingWakes: store.countPendingWakes(),
          pendingWatches: store.listAllWatches().length,
          scheduledJobs: store.listScheduledEnabled().length,
          restartPending: orchestrator.isRestartPending(),
          discordPingMs: adapter.gatewayPingMs(),
          bridges,
        };
      },
    });
    const offReady = hub.onBridgeReady(() => statusCard.poke());
    const offDisc = hub.onBridgeDisconnect(() => statusCard.poke());
    orchestrator.setOnParkedChange(() => statusCard.poke());
    stopStatusCard = () => {
      offReady();
      offDisc();
      statusCard.stop();
    };
    void statusCard.start().catch((err) =>
      logger.warn({ err }, "server status card failed to start")
    );
  }

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
    quotaPoller.stop();
    stopQuotaCard?.();
    stopStatusCard?.();
    scheduledManager.stop();
    wakeManager.stop();
    parkedManager.stop();
    cardGifs.stop();
    watchManager.stop();
    threadVoiceManager.shutdown();
    liveHelpManager.stopAll();
    voiceLeases.releaseAll();
    dispatchWatcher.stop();
    stopPresetsWatch?.();
    await seamMcpServer?.stop().catch((err) =>
      logger.warn({ err }, "seam-mcp stop failed")
    );
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
