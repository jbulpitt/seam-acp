import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import { brandIconUrl } from "../packages/core/src/plugins/card-visuals/agent-brand.js";
import {
  DiscordAdapter,
  projectDiscordStatusEmbed,
} from "../packages/core/src/platforms/discord/adapter.js";
import { discordStatusColor } from "../packages/core/src/platforms/discord/renderer.js";
import { visualHost } from "./plugin-card-visuals-fixture.js";

describe("durable Discord status-card projection (#586)", () => {
  it("clamps adopted tool titles before editing the actual Discord message", async () => {
    const source = { title: "Report-back · Working", fields: [{ name: "Action", value: "Starting…" }] };
    const edit = vi.fn(async ({ embeds }: any) => {
      if (embeds[0].fields.some((field: any) => field.value.length > 1024)) {
        throw new Error("DiscordAPIError 50035: field value exceeds 1024");
      }
    });
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.defineProperty(adapter, "fetchSendableChannel", { value: vi.fn(async () => ({
      messages: { fetch: vi.fn(async () => ({ embeds: [{ toJSON: () => source }],
        attachments: new Collection(), edit })) },
    })) });
    const ref = { channel: { platform: "discord", id: "thread" }, id: "card" };
    await adapter.editStatusPanelProjection(ref, { state: "Working", action: `Tool: ${"heredoc ".repeat(300)}` });
    await adapter.editStatusPanelProjection(ref, { state: "Done", action: "end_turn" });
    expect(edit.mock.calls[0]![0].embeds[0].fields[0].value).toHaveLength(1024);
    expect(edit).toHaveBeenLastCalledWith({ embeds: [expect.objectContaining({ title: "Report-back · Done" })] });
  });

  it("uses the live renderer's per-part and aggregate budget while preserving embed metadata", () => {
    const projected = projectDiscordStatusEmbed({
      title: "X".repeat(250) + " · Working",
      author: { name: "A".repeat(300), icon_url: "https://icons.example/codex.webp" },
      description: "D".repeat(4096), footer: { text: "F".repeat(2048), icon_url: "https://icons.example/footer.webp" },
      fields: [{ name: "Action", value: "old" }, ...Array.from({ length: 25 }, () => ({ name: "N".repeat(300), value: "V".repeat(1024) }))],
    }, { state: "Working", action: "T".repeat(3000) });
    expect(projected.title!.length).toBeLessThanOrEqual(256);
    expect(projected.author!.name.length).toBeLessThanOrEqual(256);
    expect(projected.author!.icon_url).toBe("https://icons.example/codex.webp");
    expect(projected.fields!.length).toBeLessThanOrEqual(25);
    expect(projected.fields!.every(f => f.name.length <= 256 && f.value.length <= 1024)).toBe(true);
    const weight = [projected.title, projected.description, projected.author?.name, projected.footer?.text,
      ...projected.fields!.flatMap(f => [f.name, f.value])].join("").length;
    expect(weight).toBeLessThanOrEqual(6000);
  });

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
      attachments: new Collection(),
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

  it.each([
    "https://cdn.discordapp.com/attachments/thread/card/codex.webp?ex=signed",
    "https://media.discordapp.net/attachments/thread/card/codex.webp?ex=signed",
    "attachment://codex.webp",
  ])("removes a legacy logo referenced by %s while retaining unrelated files", async (icon) => {
    const edit = vi.fn(async () => {});
    const source = {
      author: { name: "Working", icon_url: icon, proxy_icon_url: "old-proxy" },
      fields: [{ name: "Action", value: "Starting…", inline: true }],
    };
    const attachments = new Collection([
      ["logo", { id: "logo", name: "codex.webp",
        url: "https://cdn.discordapp.com/attachments/thread/card/codex.webp?ex=signed",
        proxyURL: "https://media.discordapp.net/attachments/thread/card/codex.webp?ex=signed" }],
      ["other", { id: "other", name: "notes.txt", url: "notes-url", proxyURL: "notes-proxy" }],
    ]);
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.defineProperties(adapter, {
      config: { value: { BRAND_ICON_BASE_URL: "https://icons.example/agents" } },
      pluginStatusCards: { value: (await visualHost("https://icons.example/agents")).statusCards },
      fetchSendableChannel: { value: vi.fn(async () => ({ messages: {
        fetch: vi.fn(async () => ({ embeds: [{ toJSON: () => source }], attachments, edit })),
      } })) },
    });

    await adapter.editStatusPanelProjection(
      { channel: { platform: "discord", id: "thread" }, id: "legacy-card" },
      { state: "Done", action: "Completed" }
    );
    expect(edit).toHaveBeenCalledWith({
      embeds: [expect.objectContaining({
        author: { name: "Done", icon_url: "https://icons.example/agents/codex.webp" },
      })],
      attachments: [{ id: "other" }],
    });
  });

  it("preserves a hosted icon and unrelated attachments during projection", async () => {
    const edit = vi.fn(async () => {});
    const source = { author: { name: "Working", icon_url: brandIconUrl("claude") }, fields: [] };
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.defineProperty(adapter, "fetchSendableChannel", { value: vi.fn(async () => ({
      messages: { fetch: vi.fn(async () => ({ embeds: [{ toJSON: () => source }],
        attachments: new Collection([["other", { id: "other", name: "notes.txt", url: "notes-url", proxyURL: "notes-proxy" }]]),
        edit })) },
    })) });

    await adapter.editStatusPanelProjection(
      { channel: { platform: "discord", id: "thread" }, id: "new-card" },
      { state: "Working", action: "Reconnected" }
    );
    expect(edit).toHaveBeenCalledWith({ embeds: [expect.objectContaining({ author: source.author })] });
  });

  it("removes a legacy logo hidden from Discord's attachment list before the first projection", async () => {
    const edit = vi.fn(async () => {});
    const source = { author: { name: "Working",
      icon_url: "https://cdn.discordapp.com/attachments/thread/logo/claude.webp?ex=signed" }, fields: [] };
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.defineProperties(adapter, {
      config: { value: {} },
      pluginStatusCards: { value: (await visualHost()).statusCards },
      fetchSendableChannel: { value: vi.fn(async () => ({ messages: {
        fetch: vi.fn(async () => ({ embeds: [{ toJSON: () => source }], attachments: new Collection(), edit })),
      } })) },
    });
    await adapter.editStatusPanelProjection(
      { channel: { platform: "discord", id: "thread" }, id: "legacy-card" },
      { state: "Working", action: "Reconnected" }
    );
    expect(edit).toHaveBeenCalledWith({
      embeds: [expect.objectContaining({ author: { name: "Working", icon_url: brandIconUrl("claude") } })],
      attachments: [],
    });
  });
});
