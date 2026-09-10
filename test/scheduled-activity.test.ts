import { describe, expect, it, vi } from "vitest";
import { ScheduledActivityRegistry } from "../packages/core/src/core/scheduled-prompts/activity.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { buildSeamAdminCommand } from "../packages/core/src/platforms/discord/commands.js";
import { renderServerStatusPanel, type ServerStatusSnapshot } from "../packages/core/src/core/server-status.js";

const meta = { occurrenceId: "occ-1", scheduleId: "schedule-1", name: "Disposable check",
  platform: "discord", channelRef: "111111111111111111", parentRef: "parent", mode: "isolated" as const };

describe("#253 scheduled metadata boundaries", () => {
  it("tracks one logical occurrence across duplicate accounting tokens and idempotent release", () => {
    const registry = new ScheduledActivityRegistry();
    const releaseA = registry.begin({ ...meta, prompt: "PRIVATE-SENTINEL" } as typeof meta); registry.phase(meta.occurrenceId, "provider");
    const releaseB = registry.begin(meta);
    expect(registry.snapshot()).toHaveLength(1);
    expect(JSON.stringify(registry.snapshot())).not.toContain("PRIVATE-SENTINEL");
    releaseB(); releaseB();
    expect(registry.snapshot()[0]?.phase).toBe("provider");
    releaseA(); expect(registry.snapshot()).toEqual([]);
  });

  it("threads renders isolated activity separately from idle and suppresses foreign hook entries", async () => {
    const registry = new ScheduledActivityRegistry(); registry.begin(meta);
    const foreign = { ...registry.snapshot()[0]!, occurrenceId: "SECRET-OCC", name: "SECRET-NAME",
      channelRef: "foreign-thread", parentRef: "foreign-channel" };
    const self = Object.create(SeamMcpServer.prototype);
    Object.assign(self, { deps: {
      listThreads: async () => [{ id: meta.channelRef, name: "Sibling", isSelf: false, agent: "codex", model: "test",
        effort: null, cwd: "", busy: false, status: "active", lastActivityUtc: new Date().toISOString() }],
      getScheduledWork: vi.fn(() => ({ total: 2, entries: [...registry.snapshot(), foreign] })),
    } });
    const caller = { platform: "discord", id: "discord:caller", channelRef: "caller", parentRef: "parent" };
    const result = await self.toolThreads(caller, {});
    const text = result.content[0].text;
    expect(text).toContain("[idle]");
    expect(text).toContain("Scheduled activity (separate from busy): 1 in this channel; 2 bot-wide");
    expect(text).toContain("occurrence occ-1"); expect(text).toContain("outside this visible scope");
    expect(text).not.toContain("SECRET"); expect(text).not.toContain("foreign-thread");
    self.deps.getScheduledWork.mockClear();
    expect((await self.toolThreads(caller, { scope: "foreign-channel" })).isError).toBe(true);
    expect(self.deps.getScheduledWork).not.toHaveBeenCalled();
  });

  it.each([false, true])("global diagnostics require the stamped config admin; identity enabled=%s", async enabled => {
    const registry = new ScheduledActivityRegistry(); registry.begin(meta);
    const host = Object.create(Orchestrator.prototype);
    Object.assign(host, { config: { SPEAKER_IDENTITY_ENABLED: enabled, SEAM_CONFIG_ADMIN_USER_IDS: new Set(["admin"]) },
      scheduledActivity: registry, activeTurnSettles: new Set([Promise.resolve()]), inboundWork: new Set(), restartPending: true });
    const reply = vi.fn(async (_payload: any) => {});
    await host.cmdScheduledWork({ user: { id: "other" }, reply });
    expect(reply.mock.calls[0]?.[0].content).toContain("admin-only");
    expect(JSON.stringify(reply.mock.calls)).not.toContain("occ-1");
    reply.mockClear();
    await host.cmdScheduledWork({ user: { id: "admin" }, reply });
    const payload = reply.mock.calls[0]?.[0];
    expect(payload.flags).toBe(64); // ephemeral, including refusals
    if (enabled) {
      expect(payload.content).toContain("occurrence occ-1");
      expect(payload.content).toContain("1 turn accounting token(s)");
      expect(payload.content).toContain("Cron remains open");
    } else expect(payload.content).toContain("admin-only");
  });

  it("registers the admin-only read surface within Discord's command budget", () => {
    const command = buildSeamAdminCommand().toJSON();
    expect(command.options?.find(o => o.name === "debug")).toMatchObject({
      options: expect.arrayContaining([expect.objectContaining({ name: "work" })]),
    });
    const size = (node: any): number => {
      if (!node || typeof node !== "object") return 0;
      return (typeof node.name === "string" ? node.name.length : 0) +
        (typeof node.description === "string" ? node.description.length : 0) +
        (typeof node.value === "string" ? node.value.length : 0) +
        [...(node.options ?? []), ...(node.choices ?? [])].reduce((n, child) => n + size(child), 0);
    };
    expect(size(command)).toBeLessThanOrEqual(8000);
  });

  it("the shared server card exposes aggregate counts, not other channels' identities", () => {
    const snapshot: ServerStatusSnapshot = { nowUtc: Date.now(), startedUtc: Date.now() - 1000,
      pid: 1, nodeVersion: "test", memoryRssBytes: 0, memoryHeapUsedBytes: 0, activeTurns: 2,
      activeScheduledOccurrences: 1, liveRuntimes: 0, sessions: 1, pendingWakes: 0, pendingWatches: 0,
      scheduledJobs: 1, restartPending: true, bridges: [] };
    const card = JSON.stringify(renderServerStatusPanel(snapshot));
    expect(card).toContain("2 turn tokens"); expect(card).toContain("1 occurrence");
    expect(card).not.toContain("occ-1"); expect(card).not.toContain("schedule-1");
  });
});
