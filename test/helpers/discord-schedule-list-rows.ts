import type { ScheduledPrompt } from "../../packages/core/src/core/scheduled-prompts/types.js";

export function discordScheduleListRows(): ScheduledPrompt[] {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `sch_${i}`, platform: "discord", channelRef: "thread", parentRef: "parent",
    name: i === 3 ? "A long scheduled prompt name ".repeat(4) : `Schedule ${i}`,
    promptText: "run the report", cron: "0 9 * * *", timezone: "America/Chicago", sessionMode: i % 2 ? "live" : "isolated",
    model: "test-model", cwd: null, targetChannel: null, outputType: "card", catchupSeconds: 7200,
    enabled: i % 2 === 0, legacyAttachmentCount: i === 2 ? 1 : 0, createdBy: "owner",
    createdUtc: "2026-10-01T00:00:00Z", updatedUtc: "2026-10-01T00:00:00Z",
    lastRunUtc: null, lastStatus: i === 4 ? "error: original cause" : i === 1 ? null : "ok",
    nextRunUtc: "2026-10-16T14:00:00Z", pinnedSessionId: null,
  }));
}
