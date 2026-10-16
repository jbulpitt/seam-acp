import { randomUUID } from "node:crypto";
import type { ChannelRef } from "../platforms/chat-adapter.js";
import type { ScheduleListPorts } from "./schedule-list.js";
import type { ScheduledPrompt } from "./scheduled-prompts/types.js";
import { validateCron } from "./scheduled-prompts/cron.js";
import { resolveRepoPath } from "./path-utils.js";

export const SCHEDULE_DEFAULT_TZ = "America/Chicago";
export const SCHEDULE_TIMEZONES = ["America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "UTC", "Europe/London", "Europe/Berlin", "Asia/Tokyo"];
export const SCHEDULE_PRESETS = [
  { label: "Every day at 9:00 AM", value: "0 9 * * *" },
  { label: "Weekdays at 9:00 AM", value: "0 9 * * 1-5" },
  { label: "Every Monday at 9:00 AM", value: "0 9 * * 1" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Custom cron…", value: "__custom__" },
];

export interface ScheduleBuilderDefaults {
  agent: string; registered: boolean; model: string; cwd: string;
  models: Array<{ modelId: string; name: string }>;
}
export interface ScheduleEditorPorts extends ScheduleListPorts {
  reposRoot: string;
  builderDefaults(channel: ChannelRef): ScheduleBuilderDefaults;
}
export interface ScheduleDraft {
  name: string; promptText: string; cron: string | null; timezone: string;
  model: string | null; cwd: string | null; target: string | null;
  outputType: "card" | "messages"; sessionMode: "isolated" | "live";
}

export function scheduleDraft(existing?: ScheduledPrompt): ScheduleDraft {
  return { name: existing?.name ?? "", promptText: existing?.promptText ?? "", cron: existing?.cron ?? null,
    timezone: existing?.timezone ?? SCHEDULE_DEFAULT_TZ, model: existing?.model ?? null,
    cwd: existing?.cwd ?? null, target: existing?.targetChannel ?? null,
    outputType: existing?.outputType ?? "card", sessionMode: existing?.sessionMode ?? "isolated" };
}

export function scheduleMissingFields(state: ScheduleDraft): string[] {
  const missing: string[] = [];
  if (!state.name) missing.push("a name");
  if (!state.promptText) missing.push("a prompt");
  if (!state.cron) missing.push("a cadence/schedule");
  return missing;
}

/** Keeps the previous optional value when Discord's details modal reports an invalid field. */
export function schedulePromptDetails(platform: string, reposRoot: string, state: ScheduleDraft,
  fields: { name: string; promptText: string; cwd?: string; target?: string }, live = state.sessionMode === "live") {
  const draft = { ...state, name: fields.name.trim(), promptText: fields.promptText.trim() }, errors: string[] = [];
  if (!live) {
    const cwd = fields.cwd?.trim() ?? "", target = fields.target?.trim() ?? "";
    if (cwd) {
      try { draft.cwd = resolveRepoPath(reposRoot, cwd); }
      catch (e) { errors.push(`cwd: ${(e as Error).message}`); }
    } else draft.cwd = null;
    if (target) {
      if (platform === "google-chat") {
        const resource = /^spaces\/([\w-]+)(?:\/threads\/([\w-]+))?$/.exec(target);
        if (resource) draft.target = resource[1]! + (resource[2] ? `.${resource[2]}` : "");
        else if (/^[\w-]+(?:\.[\w-]+)?$/.test(target)) draft.target = target;
        else errors.push("output id must be a Space/thread id (spaces/SPACE/threads/THREAD or SPACE.THREAD)");
      } else if (/^\d+$/.test(target)) draft.target = target;
      else errors.push("output id must be a numeric channel/thread id");
    } else draft.target = null;
  }
  return { draft, errors };
}

export function saveSchedule(ports: ScheduleEditorPorts, channel: ChannelRef, authorId: string,
  state: ScheduleDraft, existing?: ScheduledPrompt): ScheduledPrompt {
  const details = schedulePromptDetails(channel.platform, ports.reposRoot, state,
    { name: state.name, promptText: state.promptText, cwd: state.cwd ?? "", target: state.target ?? "" });
  const draft = details.draft, missing = scheduleMissingFields(draft);
  if (missing.length) throw new Error(`Still need ${missing.join(", ")}.`);
  if (details.errors.length) throw new Error(details.errors.join("; "));
  if (draft.name.length > 80) throw new Error("Name must be 80 characters or fewer.");
  if (draft.sessionMode !== "isolated" && draft.sessionMode !== "live") throw new Error("Session must be isolated or live.");
  if (draft.sessionMode !== "live" && draft.outputType !== "card" && draft.outputType !== "messages") throw new Error("Output must be cards or messages.");
  const cron = draft.cron!.trim(), validated = validateCron(cron, draft.timezone);
  if (!validated.ok) throw new Error(`Invalid cron: ${validated.error}`);
  const now = new Date().toISOString(), live = draft.sessionMode === "live";
  const values = { name: draft.name, promptText: draft.promptText, cron, timezone: draft.timezone,
    model: live ? null : draft.model, cwd: live ? null : draft.cwd, targetChannel: live ? null : draft.target,
    outputType: live ? "card" as const : draft.outputType, sessionMode: draft.sessionMode,
    legacyAttachmentCount: 0, updatedUtc: now, nextRunUtc: validated.next!.toISOString() };
  const row: ScheduledPrompt = existing ? { ...existing, ...values } : {
    id: `sch_${randomUUID().slice(0, 8)}`, platform: channel.platform, channelRef: channel.id, parentRef: channel.parentId ?? null,
    ...values, catchupSeconds: 7200, enabled: true, createdBy: authorId, createdUtc: now,
    lastRunUtc: null, lastStatus: null, pinnedSessionId: null,
  };
  ports.repository.save(row);
  if (existing) ports.admin.reschedule(existing.id);
  else ports.admin.arm(row);
  return row;
}
