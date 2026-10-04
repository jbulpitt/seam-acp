import type { Config } from "../config.js";
import type { ConfigMutationService } from "./config-mutation.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRouter } from "./session-router.js";
import type { PluginHost } from "../plugins/host.js";

/** Bootstrap translates config access into the built-in's narrow port. */
export function installCardVisuals(deps: {
  plugins: PluginHost; config: Config; store: SessionStore; router: SessionRouter; mutation: ConfigMutationService;
}): Promise<void> {
  return deps.plugins.loadBuiltins([{ id: "card-visuals", load: async () => {
    const { createCardVisualsPlugin } = await import("../plugins/card-visuals/index.js");
    return createCardVisualsPlugin({
      read: threadId => {
        const record = deps.store.getByChannel("discord", threadId);
        if (!record) return undefined;
        const resolved = deps.router.describeConfig(record);
        return { parentId: record.parentRef ?? undefined, style: resolved.statusCardStyle, gif: resolved.simpleCardGif };
      },
      write: (threadId, scope, key, value, actor) => {
        const record = deps.store.getByChannel("discord", threadId);
        if (!record) return { ok: false, error: "This session no longer exists." };
        const changes = { [key]: value };
        const result = scope === "channel"
          ? deps.mutation.applyChannelOverlay({ channelId: record.parentRef!, changes, actor })
          : scope === "thread" ? deps.mutation.applyThreadOverlay({ threadId, parentRef: record.parentRef ?? undefined, changes, actor })
          : deps.mutation.applySessionConfig(record, changes, actor);
        if (!result.ok && result.error.includes("No effective change")) return { ok: true };
        return result.ok ? { ok: true } : result;
      },
    });
  } }], { "card-visuals": deps.config });
}
