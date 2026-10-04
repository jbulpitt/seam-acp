import { z } from "zod";
import type { Plugin } from "../types.js";
import type { ComponentEvent } from "../../platforms/chat-adapter.js";
import {
  ServiceStatusCard, SERVICE_STATUS_REFRESH_CUSTOM_ID, type ServiceStatusCardTransport,
} from "../../core/service-status-card.js";
import {
  createDefaultServiceStatusSources, createServiceStatusMcpView, ServiceStatusStore,
  ServiceStatusRefreshManager, SERVICE_STATUS_DEFAULTS, type ServiceStatusMcpView,
} from "../../core/service-status/index.js";
import { shouldIncludeLinkworksOllamaSource } from "../../core/parked-agents.js";
import { serviceStatusMcp } from "./mcp.js";

const schema = z.object({
  DISCORD_SERVICE_STATUS_THREAD_ID: z.string().optional(),
  OLLAMA_CLOUD_ENABLED: z.boolean(),
});

/** Bootstrap-only card transport; cached reads feed the kernel's canary diagnostics. */
export function createServiceStatusPlugin(transport: ServiceStatusCardTransport): {
  plugin: Plugin;
  read: ServiceStatusMcpView["read"];
} {
  let store: ServiceStatusStore | undefined;
  let manager: ServiceStatusRefreshManager | undefined;
  let card: ServiceStatusCard | undefined;
  let view: ServiceStatusMcpView | undefined;
  let threadId: string | undefined;
  let ready = false;
  const current = () => {
    if (!view) throw new Error("Service status is not enabled on this deployment.");
    return view;
  };
  const refresh = async (options: Parameters<ServiceStatusMcpView["refresh"]>[0]) => {
    if (!ready) throw new Error("Service-status refresh is unavailable during startup or shutdown.");
    return current().refresh(options);
  };
  const component = async (event: ComponentEvent) => {
    if (event.customId !== SERVICE_STATUS_REFRESH_CUSTOM_ID) return;
    if (!threadId || event.channel.id !== threadId) return event.replyEphemeral("This service-status control is not active in this thread.");
    if (!ready) return event.replyEphemeral("Service-status refresh is unavailable during startup or shutdown.");
    await event.replyEphemeral("Refreshing upstream service status…");
    const result = await manager!.refresh({ force: true });
    const attempted = result.sources.filter(source => source.attempted).length;
    const failed = result.sources.filter(source => source.succeeded === false).length;
    const rateLimited = result.sources.filter(source => source.disposition === "rate_limited").length;
    const message = attempted === 0 && rateLimited > 0
      ? "Refresh is cooling down; no upstream source was fetched again."
      : result.outcome === "succeeded" ? `Service status refreshed (${attempted} sources).`
      : result.outcome === "mixed" ? `Service status refreshed with ${failed} source failure${failed === 1 ? "" : "s"}.`
      : result.outcome === "failed" ? "Service-status refresh failed; the card is retaining its last known good provider data."
      : "No service-status source was eligible to refresh yet.";
    await event.editReplyEphemeral(message);
  };
  const stop = () => { ready = false; manager?.stop(); card?.stop(); };
  const drain = async () => { await Promise.all([manager?.drain(), card?.drain()]); };
  const plugin: Plugin = {
    id: "service-status", apiVersion: 1, builtin: true, internal: true,
    validateConfig: config => schema.parse(config),
    activate: context => {
      if (!context.storage) throw new Error("Service status requires plugin storage.");
      const config = schema.parse(context.config);
      threadId = config.DISCORD_SERVICE_STATUS_THREAD_ID;
      const sources = createDefaultServiceStatusSources({ includeLinkworksOllama: shouldIncludeLinkworksOllamaSource(config.OLLAMA_CLOUD_ENABLED) });
      store = new ServiceStatusStore(context.storage.path("service-status.sqlite"));
      manager = new ServiceStatusRefreshManager({ store, sources, logger: context.logger, onUpdate: () => card?.poke() });
      view = createServiceStatusMcpView({ store, manager, sources });
      if (threadId) card = new ServiceStatusCard({
        logger: context.logger, adapter: transport, threadId,
        stateFile: context.storage.path("service-status-card.json"), sources,
        collect: () => store!.listSnapshots().filter(snapshot => sources.some(source => source.id === snapshot.sourceId)),
      });
    },
    dispose: async () => { stop(); await drain(); store?.close(); view = undefined; },
    contributions: {
      mcp: serviceStatusMcp(() => ({ read: options => current().read(options), refresh })),
      components: [{ namespace: "seam-service-status:", types: ["button"], lifetime: "persistent", access: "read-only", authorization: "user", handle: component }],
      jobs: [{ name: "poll", phase: "after-admission", intervalMs: SERVICE_STATUS_DEFAULTS.normalIntervalMs,
        start: async ({ signal }) => {
          signal.addEventListener("abort", stop, { once: true });
          await card?.start();
          if (signal.aborted) return;
          ready = true;
          manager!.start();
        }, stop, drain }],
    },
  };
  return { plugin, read: options => current().read(options) };
}
