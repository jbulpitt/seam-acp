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

  it("does not rename if no abbreviation brackets are matched", async () => {
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
    expect(renamedTo).toBeNull();
  });
});
