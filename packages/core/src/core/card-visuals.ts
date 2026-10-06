import type { Config } from "../config.js";
import type { ConfigMutationService } from "./config-mutation.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRouter } from "./session-router.js";
import type { PluginHost } from "../plugins/host.js";
import type { ConfigApplyPlan } from "./config-apply-plan.js";
import type { CardVisualsPort } from "../plugins/card-visuals/index.js";
import { configTarget } from "./config-target.js";

/** Bootstrap translates config access into the built-in's narrow port. */
export function installCardVisuals(deps: {
  plugins: PluginHost; config: Config; store: SessionStore; router: SessionRouter; mutation: ConfigMutationService;
  plan(): ConfigApplyPlan;
  offer: CardVisualsPort["offer"];
}): Promise<void> {
  return deps.plugins.loadBuiltins([{ id: "card-visuals", load: async () => {
    const { createCardVisualsPlugin } = await import("../plugins/card-visuals/index.js");
    return createCardVisualsPlugin({
      read: (channel, scope) => {
        const resolved = deps.plan().describeTarget(channel, scope);
        return { style: resolved.statusCardStyle, gif: resolved.simpleCardGif };
      },
      write: (channel, scope, key, value, actor) => {
        const target = configTarget(channel, scope);
        const changes = { [key]: value };
        if (target.kind === "thread" && scope === "session") {
          const record = deps.router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id,
            parentRef: target.parentRef, cwd: deps.config.REPOS_ROOT });
          const result = deps.mutation.applySessionConfig(record, changes, actor);
          return !result.ok && !result.error.includes("No effective change") ? result : { ok: true };
        }
        const result = target.kind === "channel"
          ? deps.mutation.applyChannelOverlay({ channelId: target.id, changes, actor })
          : deps.mutation.applyThreadOverlay({ threadId: target.id, parentRef: target.parentRef, changes, actor });
        const record = target.kind === "thread" ? deps.store.getByChannel(channel.platform, channel.id) : null;
        if ((result.ok || result.error.includes("No effective change")) && record) deps.plan().clearLegacyOverrides(record, changes);
        if (!result.ok && result.error.includes("No effective change")) return { ok: true };
        return result.ok ? { ok: true } : result;
      },
      overrides: id => deps.plan().overrideCounts(id), offer: deps.offer,
    });
  } }], { "card-visuals": deps.config });
}
