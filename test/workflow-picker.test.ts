import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { workflowActionLabel, type InterruptedTurnRow } from "../packages/core/src/platforms/discord/workflows-view.js";
import { workflowCategoryList, workflowLanding } from "../packages/core/src/platforms/discord/workflow-category-view.js";
import { WorkflowInventoryController } from "../packages/core/src/platforms/discord/workflow-inventory-controls.js";
import { collectAcknowledgedInteractions, replyToInteraction } from "../packages/core/src/platforms/discord/interaction-response.js";
import { SyntheticInteraction } from "../packages/core/src/platforms/discord/synthetic-interaction.js";

const row: InterruptedTurnRow = {
  id: "d4a166f6-2222-3333-4444-555555555555", source: "dispatch", channelRef: "thread",
  correlationId: null, status: "interrupted", startedUtc: "2026-10-05T12:00:00.000Z",
  acpSessionId: "acp", targetRef: "thread", actions: ["resume", "cancel"],
};

describe("workflow landing and labels", () => {
  it("renders one select with all seven labelled category counts", () => {
    const view = workflowLanding({ parked: 1, wakes: 2, watches: 3, choices: 4, ingests: 5, live: 6, schedules: 7 }, "this thread");
    expect(view.components).toHaveLength(1);
    const menu = view.components[0]!.toJSON().components[0] as any;
    expect(menu.custom_id).toBe("wf:category");
    expect(menu.options.map((option: any) => option.label)).toEqual([
      "Parked turns (1)", "Wakes (2)", "Watches (3)", "Choices (4)", "Ingests (5)", "Live help (6)", "Schedules (7)",
    ]);
  });

  it("reads scoped backing lists and counts only actionable parked turns", async () => {
    const orch = Object.create(Orchestrator.prototype) as any;
    orch.collectInterruptedRows = vi.fn(async () => [row, { ...row, id: "dead", actions: [] }]);
    orch.store = Object.fromEntries(["listWakesByChannel", "listOpenChoiceCards", "listOpenIngestEndpoints", "listScheduledByChannel"]
      .map(name => [name, vi.fn(() => [])]));
    orch.listWatches = vi.fn(() => []);
    const view = await orch.renderWorkflowInventory({ channelId: "thread", options: { getString: () => null, getBoolean: () => false } }, 20, 0);
    expect(orch.collectInterruptedRows).toHaveBeenCalledWith("thread", "thread");
    expect(orch.store.listScheduledByChannel).toHaveBeenCalledWith("discord", "thread");
    const menu = view.components[0].toJSON().components[0];
    expect(menu.options[0].label).toBe("Parked turns (1)");
  });

  it("labels actions with the same recognizable ID and the resume age", () => {
    const now = new Date("2026-10-05T12:05:00.000Z");
    expect(workflowActionLabel("resume", row, now)).toBe("Resume d4a166f6 (5m)");
    expect(workflowActionLabel("cancel", row, now)).toBe("Cancel d4a166f6");
  });

  it("links every open card using its own channel, including reauth and parked notices", async () => {
    const orch = Object.create(Orchestrator.prototype) as any;
    orch.collectInterruptedRows = vi.fn(async () => []);
    orch.store = Object.fromEntries(["listWakesByChannel", "listAllWatches", "listOpenChoiceCards", "listOpenIngestEndpoints", "listAllScheduled"]
      .map(name => [name, vi.fn(() => [])]));
    orch.store.listOpenChoiceCards.mockReturnValue([
      { id: "choice", title: "Choose", platform: "discord", channelRef: "thread-a", messageId: "m1", clickCount: 0, maxClicks: 1, createdUtc: "2026-10-05T12:00:03Z" },
      { id: "reauth", title: "Authentication", platform: "discord", channelRef: "thread-b", messageId: "m2", clickCount: 0, maxClicks: 1, createdUtc: "2026-10-05T12:00:02Z" },
      { id: "parked", title: "Parked turn", platform: "discord", channelRef: "thread-c", messageId: "m3", clickCount: 0, maxClicks: 1, createdUtc: "2026-10-05T12:00:01Z" },
      { id: "missing", title: "Gone", platform: "discord", channelRef: "deleted", messageId: "m4", clickCount: 0, maxClicks: 1, createdUtc: "2026-10-05T12:00:00Z" },
    ]);
    orch.listWatches = vi.fn(() => []);
    orch.adapter = { getMessageLink: vi.fn(async (channel: { id: string }, messageId: string) => channel.id === "deleted"
      ? { jumpLinkUnavailableReason: "Unknown Channel" }
      : { jumpUrl: `https://discord.com/channels/g-${channel.id}/${channel.id}/${messageId}` }) };
    const view = await orch.renderWorkflowInventory({ channelId: "caller-thread", guildId: "caller-guild",
      options: { getString: () => "all", getBoolean: () => false } }, 20, 0, "choices");
    const text = view.embeds[0].data.description;
    expect(text).toContain("[Open card](https://discord.com/channels/g-thread-a/thread-a/m1)");
    expect(text).toContain("[Open card](https://discord.com/channels/g-thread-b/thread-b/m2)");
    expect(text).toContain("[Open card](https://discord.com/channels/g-thread-c/thread-c/m3)");
    expect(text).toContain("message m4 — Unknown Channel");
    expect(text).not.toContain("caller-guild");
    expect(orch.adapter.getMessageLink).toHaveBeenCalledWith({ platform: "discord", id: "thread-b" }, "m2");
  });

  it("paginates a selected category and always offers a route back to the picker", () => {
    const view = workflowCategoryList("wakes", ["newest", "second", "third", "fourth", "oldest"], "this thread", 1, 20);
    expect(view.embeds[0]!.data.description).toBe("oldest");
    expect(view.components[0]!.toJSON().components[0]).toMatchObject({ custom_id: "wf:category:home", label: "Categories" });
    expect(view.page).toBe(1);
  });
});

describe("workflow category navigation", () => {
  it("keeps the selected category for pagination and resets it on Home", async () => {
    const calls: Array<[number, string | undefined]> = [];
    const controls = new WorkflowInventoryController({
      resume: async () => "", cancel: async () => "",
      render: async (page, category) => {
        calls.push([page, category]);
        return { embeds: [], components: [{}], page };
      },
      refresh: async () => true, terminal: async () => true,
    });
    const click = { followUp: async () => {} };
    await controls.handle("wf:category:parked", click);
    await controls.handle("wf:page:1", click);
    await controls.handle("wf:category:home", click);
    expect(calls).toEqual([[0, "parked"], [1, "parked"], [0, undefined]]);
  });

  it("reads the selected category before the central ACK completes and waits to repaint", async () => {
    const card = { id: "card", edit: vi.fn(async () => card) };
    const native = new SyntheticInteraction({ kind: "select", channelId: "thread", messageId: card.id,
      customId: "wf:category", values: ["parked"] }, {
      client: {} as never, channel: { id: "thread" } as never,
      user: { id: "owner" } as never, member: null, message: card as never,
    });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const defer = native.deferUpdate.bind(native);
    vi.spyOn(native, "deferUpdate").mockImplementation(async () => { await pending; return defer(); });
    const render = vi.fn(async (page: number, category?: string) => ({ embeds: [], components: [], page }));
    const repaint = async (view: { embeds?: unknown[]; components?: unknown[] }) => {
      await replyToInteraction(native as never, view as never);
      return true;
    };
    const controls = new WorkflowInventoryController({
      resume: async () => "", cancel: async () => "", render,
      refresh: repaint, terminal: (_reason, view) => repaint(view),
    });
    const collector = new EventEmitter();
    let complete!: (value: unknown) => void;
    const completed = new Promise(resolve => { complete = resolve; });
    const onError = vi.fn();
    collectAcknowledgedInteractions(collector, "update", async click => {
      complete(await controls.handle(`wf:category:${(click as any).values[0]}`, { followUp: async () => {} }));
    }, onError);
    collector.emit("collect", native);
    await Promise.resolve();
    expect(render).toHaveBeenCalledWith(0, "parked");
    expect(card.edit).not.toHaveBeenCalled();
    release();
    expect(await completed).toBe("paged");
    expect(card.edit).toHaveBeenCalledOnce();
    expect(native.transcript.map(entry => entry.op)).toEqual(["deferUpdate", "editReply"]);
    expect(onError).not.toHaveBeenCalled();
  });
});
