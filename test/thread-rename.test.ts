import { describe, it, expect } from "vitest";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { ChannelRef } from "../packages/core/src/platforms/chat-adapter.js";

describe("Orchestrator Thread Renaming Abbreviation", () => {
  it("replaces known agent abbreviations case-insensitively in brackets", async () => {
    let renamedTo: string | null = null;
    let threadName = "seam-acp [agy]";

    const mockOrchestrator = {
      adapter: {
        getThreadName: async (ch: ChannelRef) => threadName,
        renameThread: async (ch: ChannelRef, name: string) => {
          renamedTo = name;
        },
      },
      router: {
        getProfile: (id: string) => {
          if (id === "copilot") return { threadAbbr: "cp-jp" };
          return { threadAbbr: "agy" };
        },
        listProfiles: () => [
          { threadAbbr: "agy" },
          { threadAbbr: "cp-jp" },
          { threadAbbr: "cc" }
        ],
      },
      logger: {
        info: () => {},
        warn: () => {},
      },
      // Bind actual implementation
      updateThreadAbbreviation: Orchestrator.prototype["updateThreadAbbreviation"],
    };

    const channel: ChannelRef = {
      platform: "discord",
      id: "thread-123",
      parentId: "channel-456",
    };

    // Act
    await mockOrchestrator.updateThreadAbbreviation(channel, "agy", "copilot");

    // Assert
    expect(renamedTo).toBe("seam-acp [cp-jp]");
  });

  it("handles case-insensitive replacement", async () => {
    let renamedTo: string | null = null;
    let threadName = "my-project [AGY]";

    const mockOrchestrator = {
      adapter: {
        getThreadName: async (ch: ChannelRef) => threadName,
        renameThread: async (ch: ChannelRef, name: string) => {
          renamedTo = name;
        },
      },
      router: {
        getProfile: (id: string) => ({ threadAbbr: "cp-jp" }),
        listProfiles: () => [
          { threadAbbr: "agy" },
          { threadAbbr: "cp-jp" }
        ],
      },
      logger: {
        info: () => {},
        warn: () => {},
      },
      updateThreadAbbreviation: Orchestrator.prototype["updateThreadAbbreviation"],
    };

    const channel: ChannelRef = {
      platform: "discord",
      id: "thread-123",
      parentId: "channel-456",
    };

    await mockOrchestrator.updateThreadAbbreviation(channel, "agy", "copilot");
    expect(renamedTo).toBe("my-project [cp-jp]");
  });

  it("stamps the target abbreviation when a custom name has no known icon", async () => {
    let renamedTo: string | null = null;
    const threadName = "my-project-without-bracket";

    const mockOrchestrator = {
      adapter: {
        getThreadName: async (ch: ChannelRef) => threadName,
        renameThread: async (ch: ChannelRef, name: string) => {
          renamedTo = name;
        },
      },
      router: {
        getProfile: (id: string) => ({ threadAbbr: "cp-jp" }),
        listProfiles: () => [
          { threadAbbr: "agy" },
          { threadAbbr: "cp-jp" }
        ],
      },
      logger: {
        info: () => {},
        warn: () => {},
      },
      updateThreadAbbreviation: Orchestrator.prototype["updateThreadAbbreviation"],
    };

    const channel: ChannelRef = {
      platform: "discord",
      id: "thread-123",
      parentId: "channel-456",
    };

    await mockOrchestrator.updateThreadAbbreviation(channel, "agy", "copilot");
    expect(renamedTo).toBe("cp-jp my-project-without-bracket");
  });

  it("posts an exact visual confirmation card and refreshes the agent identity", async () => {
    let renamedTo: string | null = null;
    let posted: any = null;
    const mockOrchestrator = {
      adapter: {
        getThreadName: async () => "agy project",
        renameThread: async (_ch: ChannelRef, name: string) => { renamedTo = name; },
        sendPanel: async (_ch: ChannelRef, panel: any) => {
          posted = panel;
          return { id: "card-1", channelId: "thread-123" };
        },
      },
      router: {
        getProfile: (id: string) => ({
          id,
          displayName: id === "claude" ? "Claude" : id,
          threadAbbr: id === "claude" ? "cc" : "agy",
        }),
        listProfiles: () => [{ threadAbbr: "agy" }, { threadAbbr: "cc" }],
      },
      logger: { info: () => {}, warn: () => {} },
      updateThreadAbbreviation: Orchestrator.prototype["updateThreadAbbreviation"],
      presentThreadConfigurationChange:
        Orchestrator.prototype.presentThreadConfigurationChange,
    } as any;

    const result = await mockOrchestrator.presentThreadConfigurationChange(
      { channelRef: "caller" },
      { platform: "discord", channelRef: "thread-123", parentRef: "channel-456" },
      {
        ok: true,
        applied: { agent: "claude", model: "default", effort: "high" },
        changes: {
          agent: { before: "agy", after: "claude", changed: true },
          model: { before: "gemini", after: "default", changed: true },
          effort: { before: "high", after: "high", changed: false },
        },
        sessionReset: true,
        resetReason: "agent-switch",
        runtimeReloaded: false,
        warnings: [],
      }
    );

    expect(result).toMatchObject({ confirmationPosted: true, threadIdentityUpdated: true });
    expect(renamedTo).toBe("cc project");
    expect(posted.title).toBe("✅ Thread configuration confirmed");
    expect(posted.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Agent", value: expect.stringContaining("Changed from") }),
      expect.objectContaining({ name: "Effort", value: expect.stringContaining("no change") }),
    ]));
  });
});
