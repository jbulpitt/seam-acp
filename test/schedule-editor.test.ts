import { describe, expect, it, vi } from "vitest";
import { scheduleDraft, schedulePromptDetails, saveSchedule, type ScheduleDraft, type ScheduleEditorPorts } from "../packages/core/src/core/schedule-editor.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";

function fixture() {
  const rows = new Map<string, ScheduledPrompt>();
  const ports: ScheduleEditorPorts = { reposRoot: "/repos", builderDefaults: vi.fn(),
    repository: { get: id => rows.get(id), list: () => [...rows.values()], save: vi.fn(row => { rows.set(row.id, row); }), remove: vi.fn() },
    admin: { arm: vi.fn(), reschedule: vi.fn(), disarm: vi.fn(), runNow: vi.fn() } };
  const draft: ScheduleDraft = { ...scheduleDraft(), name: " Report ", promptText: " Read runbook. ", cron: "0 9 * * *", cwd: "repo" };
  return { rows, ports, draft };
}

describe("shared Discord and Chat schedule editor rules", () => {
  it.each(["discord", "google-chat"])("creates and edits %s with inherited overrides and preserved history", platform => {
    const { ports, draft } = fixture(), channel = { platform, id: "home", parentId: "parent" };
    const created = saveSchedule(ports, channel, "owner", draft);
    expect(created).toMatchObject({ platform, channelRef: "home", parentRef: "parent", name: "Report", promptText: "Read runbook.",
      model: null, cwd: "/repos/repo", targetChannel: null, outputType: "card", sessionMode: "isolated", enabled: true, catchupSeconds: 7200 });
    expect(ports.admin.arm).toHaveBeenCalledExactlyOnceWith(created);
    const previous = { ...created, enabled: false, lastRunUtc: "2026-10-15T09:00:00Z", lastStatus: "ok", pinnedSessionId: "original-session", legacyAttachmentCount: 3 };
    const edited = saveSchedule(ports, channel, "different-editor", { ...draft, name: "Changed", model: "not-in-current-catalog" }, previous);
    expect(edited).toMatchObject({ id: created.id, name: "Changed", model: "not-in-current-catalog", enabled: false,
      lastRunUtc: previous.lastRunUtc, lastStatus: "ok", pinnedSessionId: "original-session", createdBy: "owner", createdUtc: created.createdUtc, legacyAttachmentCount: 0 });
    expect(ports.admin.reschedule).toHaveBeenCalledExactlyOnceWith(created.id);
    expect(ports.admin.arm).toHaveBeenCalledOnce();
  });

  it.each([
    [{ name: "" }, "a name"], [{ promptText: " " }, "a prompt"], [{ cron: null }, "a cadence"],
    [{ name: "x".repeat(81) }, "80 characters"], [{ cron: "not a cron" }, "Invalid cron:"],
    [{ timezone: "not a timezone" }, "Invalid cron:"], [{ cwd: '"' }, "Repo path is required"],
    [{ target: "invalid target" }, "numeric channel/thread"], [{ sessionMode: "unknown" }, "isolated or live"],
    [{ outputType: "unknown" }, "cards or messages"],
  ] as const)("rejects invalid submissions before saving or arming: %j", (change, message) => {
    const { ports, draft, rows } = fixture();
    expect(() => saveSchedule(ports, { platform: "discord", id: "home" }, "owner", { ...draft, ...change } as ScheduleDraft)).toThrow(message as string);
    expect(rows.size).toBe(0); expect(ports.admin.arm).not.toHaveBeenCalled(); expect(ports.admin.reschedule).not.toHaveBeenCalled();
  });

  it("clears isolated-only overrides in live mode even when those hidden values are invalid", () => {
    const { ports, draft } = fixture();
    const saved = saveSchedule(ports, { platform: "google-chat", id: "home" }, "owner",
      { ...draft, sessionMode: "live", cwd: '"', target: "ignored target", model: "unknown-model", outputType: "messages" });
    expect(saved).toMatchObject({ sessionMode: "live", model: null, cwd: null, targetChannel: null, outputType: "card" });
  });

  it("retains Discord modal's previous invalid optional field while sharing Chat target parsing", () => {
    const { draft } = fixture();
    expect(schedulePromptDetails("discord", "/repos", { ...draft, cwd: "/original", target: "123" },
      { name: "renamed", promptText: "changed", cwd: '"', target: "bad" })).toMatchObject({
      draft: { name: "renamed", promptText: "changed", cwd: "/original", target: "123" }, errors: ["cwd: Repo path is required", "output id must be a numeric channel/thread id"],
    });
    expect(schedulePromptDetails("google-chat", "/repos", draft,
      { name: "report", promptText: "run", cwd: "repo", target: "spaces/target/threads/topic" })).toMatchObject({ draft: { cwd: "/repos/repo", target: "target.topic" }, errors: [] });
  });
});
