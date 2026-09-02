import { describe, expect, it, vi } from "vitest";
import { buildSeamCommand } from "../packages/core/src/platforms/discord/commands.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

describe("/seam config rename and namer surfaces", () => {
  it("publishes thread/channel rename, explicit legacy migration, and namer editor", () => {
    const command = buildSeamCommand().toJSON();
    const config = command.options?.find((option) => option.name === "config");
    const rename = config?.options?.find((option) => option.name === "rename");
    const namer = config?.options?.find((option) => option.name === "namer");

    expect(rename).toBeDefined();
    expect(rename?.options?.find((option) => option.name === "scope")?.choices)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "thread", value: "thread" }),
        expect.objectContaining({ name: "channel", value: "channel" }),
      ]));
    expect(rename?.options?.find((option) => option.name === "migrate-legacy")?.type).toBe(5);
    expect(namer).toBeDefined();
  });

  it("shows naming state without reapplying after core configure already ran the funnel", async () => {
    const target = {
      id: "discord:thread-123",
      platform: "discord",
      channelRef: "thread-123",
      parentRef: "channel-456",
    };
    const applyThreadName = vi.fn(async () => ({ status: "renamed" }));
    let posted: any;
    const mock = {
      store: { get: () => target },
      applyThreadName,
      adapter: {
        sendPanel: async (_channel: unknown, panel: unknown) => {
          posted = panel;
          return { id: "card-1", channelId: "thread-123" };
        },
      },
      router: {
        getProfile: () => ({ id: "claude", displayName: "Claude" }),
      },
      logger: { warn: () => {} },
      presentThreadConfigurationChange: Orchestrator.prototype.presentThreadConfigurationChange,
    } as any;

    const result = await mock.presentThreadConfigurationChange(
      { channelRef: "caller" },
      target,
      {
        ok: true,
        applied: {
          agent: "claude",
          model: "claude-opus-5",
          effort: "high",
          role: "orch",
          disableThreadPrefix: false,
        },
        changes: {
          agent: { before: "agy", after: "claude", changed: true },
          model: { before: "gemini", after: "claude-opus-5", changed: true },
          effort: { before: "high", after: "high", changed: false },
          role: { before: "auto", after: "orch", changed: true },
          disableThreadPrefix: { before: "enabled", after: "enabled", changed: false },
        },
        sessionReset: true,
        resetReason: "agent-switch",
        runtimeReloaded: false,
        threadIdentityUpdated: true,
        warnings: [],
      }
    );

    expect(result).toMatchObject({ confirmationPosted: true, threadIdentityUpdated: true });
    expect(applyThreadName).not.toHaveBeenCalled();
    expect(posted.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Agent", value: expect.stringContaining("Changed from") }),
      expect.objectContaining({ name: "Role", value: expect.stringContaining("orch") }),
    ]));
  });

  it("defers channel recompaction before work and edits a failure-aware summary", async () => {
    const events: string[] = [];
    const reply = vi.fn(async () => { events.push("reply"); });
    const deferReply = vi.fn(async () => { events.push("defer"); });
    const editReply = vi.fn(async () => { events.push("edit"); });
    const recompactChannel = vi.fn(async () => {
      events.push("recompact");
      expect(deferReply).toHaveBeenCalledOnce();
      return [
        { status: "renamed" },
        { status: "unchanged" },
        { status: "unmanaged" },
        { status: "gone" },
        { status: "failed" },
      ];
    });
    const mock = {
      recordFromInteraction: () => ({
        id: "discord:thread-123",
        platform: "discord",
        channelRef: "thread-123",
        parentRef: "channel-456",
      }),
      threadNamer: { recompactChannel },
    } as any;
    const interaction = {
      options: {
        getString: () => "channel",
        getBoolean: () => false,
      },
      reply,
      deferReply,
      editReply,
    } as any;

    await (Orchestrator.prototype as any).cmdThreadRename.call(mock, interaction);

    expect(events).toEqual(["defer", "recompact", "edit"]);
    expect(reply).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: "Recomputed 5 channel thread(s): 1 renamed, 1 unchanged, 1 left untouched, 1 gone, 1 failed.",
    });
  });

  it("defers the single-thread rename and edits instead of replying twice", async () => {
    const events: string[] = [];
    const reply = vi.fn(async () => { events.push("reply"); });
    const deferReply = vi.fn(async () => { events.push("defer"); });
    const editReply = vi.fn(async () => { events.push("edit"); });
    const applyThreadName = vi.fn(async () => {
      events.push("rename");
      expect(deferReply).toHaveBeenCalledOnce();
      return { status: "renamed", name: "🤖 fixed" };
    });
    const mock = {
      recordFromInteraction: () => ({
        id: "discord:thread-123",
        platform: "discord",
        channelRef: "thread-123",
        parentRef: "channel-456",
      }),
      applyThreadName,
    } as any;
    const interaction = {
      options: {
        getString: () => "thread",
        getBoolean: () => true,
      },
      reply,
      deferReply,
      editReply,
    } as any;

    await (Orchestrator.prototype as any).cmdThreadRename.call(mock, interaction);

    expect(events).toEqual(["defer", "rename", "edit"]);
    expect(reply).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({ content: "Renamed to 🤖 fixed." });
  });
});
