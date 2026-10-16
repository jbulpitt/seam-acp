import { EventEmitter } from "node:events";
import { ScheduleUi } from "../../packages/core/src/plugins/schedule-ui/index.js";
import type { ScheduledPrompt } from "../../packages/core/src/core/scheduled-prompts/types.js";

export async function discordScheduleBuilderViews() {
  const ui = new ScheduleUi({ logger: { warn() {}, error() {} }, reposRoot: "/repos",
    repository: { list: () => [] }, builderDefaults: () => ({ agent: "codex", registered: true,
      model: "session-model", cwd: "/repos/current", models: [{ modelId: "model-two", name: "Model two" }] }),
  } as any);
  const existing: ScheduledPrompt = { id: "sch_existing", platform: "discord", channelRef: "thread", parentRef: "parent",
    name: "Report", promptText: "Read the runbook.\nPost the result.", cron: "0 17 * * 1-5", timezone: "UTC",
    model: "model-two", cwd: "/repos/other", targetChannel: "123456789", outputType: "messages", sessionMode: "isolated",
    enabled: false, catchupSeconds: 7200, legacyAttachmentCount: 1, createdBy: "owner", createdUtc: "2026-10-01T00:00:00Z",
    updatedUtc: "2026-10-01T00:00:00Z", lastRunUtc: null, lastStatus: null, nextRunUtc: null, pinnedSessionId: null };
  const views: unknown[] = [];
  for (const row of [undefined, existing, { ...existing, sessionMode: "live" as const }]) {
    await ui.cmdScheduleAdd({ channelRef: { platform: "discord", id: "thread", parentId: "parent" }, user: { id: "owner" },
      reply: async (view: any) => { views.push({ embeds: view.embeds.map((e: any) => e.toJSON()), components: view.components.map((r: any) => r.toJSON()) }); },
      fetchReply: async () => ({ id: "builder", createMessageComponentCollector: () => new EventEmitter() }),
      attachLifecycle: () => ({ terminal: async () => {} }),
    } as any, row);
  }
  return views;
}
