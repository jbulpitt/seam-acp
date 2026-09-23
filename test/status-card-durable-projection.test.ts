import { describe, expect, it, vi } from "vitest";
import {
  DiscordAdapter,
  projectDiscordStatusEmbed,
} from "../packages/core/src/platforms/discord/adapter.js";
import { discordStatusColor } from "../packages/core/src/platforms/discord/renderer.js";

describe("durable Discord status-card projection (#586)", () => {
  it("patches only durable state/action facts and is idempotent", () => {
    const source = {
      title: "Working",
      description: "`🔨 Build`",
      color: discordStatusColor("Working"),
      fields: [
        { name: "Repo", value: "seam-acp", inline: true },
        { name: "Action", value: "Running tests", inline: true },
      ],
      footer: { text: "⏱ 94s elapsed" },
    };
    const projection = { state: "Done" as const, action: "end_turn" };

    const once = projectDiscordStatusEmbed(source, projection);
    const twice = projectDiscordStatusEmbed(once, projection);

    // Protects against reconstructing a dead process's TurnStatus: removing
    // this preservation loses real pre-restart observations from Discord.
    expect(once).toMatchObject({
      title: "Done",
      description: source.description,
      color: discordStatusColor("Done"),
      fields: [
        source.fields[0],
        { name: "Action", value: "end_turn", inline: true },
      ],
      footer: source.footer,
    });
    // Protects retry/restart reconciliation: deleting deterministic patching
    // lets repeated projection drift or race toward a different visible card.
    expect(twice).toEqual(once);
  });

  it("updates compact cards without discarding their stored author metadata", () => {
    const source = {
      author: { name: "Working", icon_url: "attachment://codex.png" },
      color: discordStatusColor("Working"),
      fields: [],
      footer: { text: "⏱ 18s" },
    };

    expect(projectDiscordStatusEmbed(source, {
      state: "Failed",
      action: "Cancelled",
    })).toMatchObject({
      author: { name: "Failed", icon_url: "attachment://codex.png" },
      color: discordStatusColor("Failed"),
      fields: [{ name: "Action", value: "Cancelled", inline: true }],
      footer: source.footer,
    });
  });

  it("fetches and patches the persisted Discord message on the production adapter path", async () => {
    const edit = vi.fn(async () => {});
    const source = {
      title: "Working",
      color: discordStatusColor("Working"),
      fields: [{ name: "Action", value: "Starting…", inline: true }],
    };
    const fetch = vi.fn(async () => ({
      embeds: [{ toJSON: () => source }],
      edit,
    }));
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.defineProperty(adapter, "fetchSendableChannel", {
      value: vi.fn(async () => ({ messages: { fetch } })),
    });

    await adapter.editStatusPanelProjection(
      { channel: { platform: "discord", id: "thread-1" }, id: "panel-1" },
      { state: "Done", action: "Completed" }
    );

    // Protects the actual Discord consumer: deleting the adapter call leaves
    // the pure projection green while no persisted message is ever edited.
    expect(fetch).toHaveBeenCalledWith("panel-1");
    expect(edit).toHaveBeenCalledWith({
      embeds: [expect.objectContaining({
        title: "Done",
        color: discordStatusColor("Done"),
        fields: [{ name: "Action", value: "Completed", inline: true }],
      })],
    });
  });
});
