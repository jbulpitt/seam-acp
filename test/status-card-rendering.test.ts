import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { DispatchStatusPanel } from "../packages/core/src/core/dispatch-status-panel.js";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";

describe("rebound status-card rendering", () => {
  it("renders the restored model through the real Discord limit clamp", async () => {
    const status = new TurnStatus({ model: "M".repeat(400), repoDisplay: "R".repeat(3000), authorName: "A".repeat(400) });
    status.pushThinkingChunk("T".repeat(4000));
    status.setAction("heredoc ".repeat(300));
    const edit = vi.fn(async (_id, payload) => {
      const embed = payload.embeds[0].toJSON();
      expect(embed.fields.every(field => field.value.length <= 1024 && field.name.length <= 256)).toBe(true);
      const weight = [embed.title, embed.description, embed.author?.name, embed.footer?.text,
        ...embed.fields.flatMap(field => [field.name, field.value])].join("").length;
      expect(weight).toBeLessThanOrEqual(6000);
    });
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.defineProperty(adapter, "fetchSendableChannel", { value: async () => ({ messages: { edit } }) });
    const ref = { channel: { platform: "discord", id: "thread" }, id: "original" };
    const panel = new DispatchStatusPanel(discordRenderer, TurnStatus.restore(status.snapshot()), {
      post: async () => { throw new Error("must reuse the card"); },
      edit: (ref, rendered) => adapter.editPanel(ref, rendered),
    });
    await panel.start(ref);
    await panel.finalize("Done", "end_turn");
    expect(edit).toHaveBeenLastCalledWith("original", expect.objectContaining({ embeds: expect.any(Array) }));
    expect(edit.mock.calls.at(-1)[1].embeds[0].toJSON().title).toBe("Done");
  });
});
