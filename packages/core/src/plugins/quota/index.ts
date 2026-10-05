import { ApplicationCommandOptionType } from "discord.js";
import { z } from "zod";
import type { Plugin } from "../types.js";
import type { SlashInvocation } from "../slash-registry.js";
import type { ComponentEvent } from "../../platforms/chat-adapter.js";
import type { UsageBinding, UsageProviderPort } from "../../core/quota/usage-provider.js";
import { AgentQuotaPoller } from "../../core/quota/quota-poller.js";
import { QuotaRegistry, quotaPollIntervalMs } from "../../core/quota/quota-registry.js";
import { AgentQuotaCard, type AgentQuotaCardTransport } from "../../core/quota/agent-quota-card.js";
import { formatUsageAgentList, liveUsageAgentLabels, parkedAgentMessage } from "../../core/parked-agents.js";
import { createQuotaSources } from "./sources.js";
import { formatUsage } from "./format-usage.js";
import { quotaMcp } from "./mcp.js";

/** Internal-tier binding snapshots and provider reads; no router or runtime access. */
export interface QuotaPorts {
  usage: UsageProviderPort;
  bindings(): readonly Readonly<UsageBinding>[];
  resolve(threadId: string, parentId?: string): Readonly<UsageBinding> | undefined;
  card: AgentQuotaCardTransport;
}
const schema = z.object({ DISCORD_AGENT_QUOTA_THREAD_ID: z.string().optional(), QUOTA_STALE_RETENTION_MS: z.number().nonnegative(), OLLAMA_CLOUD_ENABLED: z.boolean() });

export function createQuotaPlugin(ports: QuotaPorts): Plugin {
  const registry = new QuotaRegistry();
  let poller: AgentQuotaPoller;
  let card: AgentQuotaCard | undefined;
  let ready = false;
  let lastClick = 0;
  let threadId: string | undefined;
  let ollamaEnabled = false;
  const stop = () => { ready = false; poller?.stop(); card?.stop(); };
  const drain = async () => { await Promise.all([poller?.drain(), card?.drain()]); };
  const usage = async (invocation: SlashInvocation) => {

    const binding = ports.resolve(invocation.threadId, invocation.parentId);
    if (!binding) return invocation.reply("Use inside a thread.");
    if (binding.provider === "ollama-cloud" && !ollamaEnabled) return invocation.reply(parkedAgentMessage(binding.agentId, false, "session") ?? `\`/seam usage\` is not available for parked agent \`${binding.agentId}\`.`);
    if (!binding.provider) return invocation.reply(`\`/seam usage\` is only available for the ${formatUsageAgentList(liveUsageAgentLabels(ports.bindings().map(binding => binding.agentId))) || "currently live"} agents. This thread uses \`${binding.agentId}\`.`);
    try { await invocation.reply(formatUsage(await ports.usage.readUsage(binding))); }
    catch (err) { await invocation.reply(`Couldn't fetch usage: ${err instanceof Error ? err.message : String(err)}`); }
  };
  const component = async (event: ComponentEvent) => {
    if (!ready) return event.followUpEphemeral("Usage refresh is unavailable during startup or shutdown.");
    if (Date.now() - lastClick < 10_000) return event.followUpEphemeral("Usage was refreshed recently; try again in a few seconds.");
    lastClick = Date.now();
    const result = await poller.refreshAll(true);
    const timedOut = result.sources.filter(source => source.outcome === "timed_out");
    const unavailable = result.sources.filter(source => source.outcome === "unavailable");
    await event.followUpEphemeral(timedOut.length
      ? `Usage refresh timed out after ${result.timeoutMs / 1000}s for ${timedOut.map(source => source.displayName).join(", ")}. Other agents refreshed normally; any last-known-good values were retained.`
      : unavailable.length ? `Usage refreshed with ${unavailable.length} unavailable source${unavailable.length === 1 ? "" : "s"}; other agents and retained values remain available.`
      : `Usage refreshed (${result.sources.length} agents).`);
  };
  return {
    id: "quota", apiVersion: 1, builtin: true, internal: true,
    validateConfig: config => schema.parse(config),
    activate: context => {
      const config = schema.parse(context.config);
      threadId = config.DISCORD_AGENT_QUOTA_THREAD_ID;
      ollamaEnabled = config.OLLAMA_CLOUD_ENABLED;
      poller = new AgentQuotaPoller({ logger: context.logger, registry, sources: createQuotaSources(ports.bindings(), ports.usage),
        staleRetentionMs: config.QUOTA_STALE_RETENTION_MS, onUpdate: () => { if (ready) card?.poke(); } });
      if (threadId) {
        if (!context.storage) throw new Error("Quota card requires plugin storage.");
        card = new AgentQuotaCard({ logger: context.logger, adapter: ports.card, threadId,
          stateFile: context.storage.path("agent-quota-card.json"), collect: () => registry.all() });
      }
    },
    dispose: async () => { stop(); await drain(); },
    contributions: {
      slash: [{ command: "seam", group: { name: "info", description: "Bot & account info" },
        acknowledgement: "ephemeral", leaf: { type: ApplicationCommandOptionType.Subcommand, name: "usage", description: "Show usage / credits for this thread's agent (agy, claude, copilot, grok, codex)" },
        access: { kind: "read-only" }, authorization: "user", help: "`/seam info usage` — show usage / credits for this thread's agent", handle: usage }],
      mcp: quotaMcp(registry),
      components: [{ namespace: "seam-quota:", types: ["button"], lifetime: "persistent", access: "read-only", authorization: "user", acknowledgement: "update", handle: component }],
      turnActivity: [
        { event: "turn-started", handle: event => { poller.recordTurnStart(event.binding.agentId, event.timestampMs); } },
        { event: "turn-completed", handle: async event => { if (ready) await poller.turnCompleted(event.binding.agentId, event.binding); } },
      ],
      jobs: [{ name: "poll", phase: "after-admission", intervalMs: quotaPollIntervalMs(0),
        start: async ({ signal }) => {
          signal.addEventListener("abort", stop, { once: true });
          await poller.start();
          if (signal.aborted) return;
          await card?.start();
          if (!signal.aborted) ready = true;
        }, stop, drain }],
    },
  };
}
