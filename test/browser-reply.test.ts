import { describe, it, expect, vi } from "vitest";
import { SyntheticInteraction, type SyntheticContext } from "../packages/core/src/platforms/discord/synthetic-interaction.js";
import { browserReplyFromInteraction, browserReply } from "../packages/core/src/platforms/discord/browser-reply.js";

describe("persistent browser reply transport", () => {
  it("restores the test-driver reply without extending its token lifetime", async () => {
    let now = 1000;
    const message = { id: "message", edit: vi.fn(async () => message), delete: vi.fn(async () => {}) };
    const send = vi.fn(async () => message);
    const context = { client: {}, channel: { id: "thread", guildId: "guild", send },
      user: { id: "owner" }, member: null, now: () => now } as unknown as SyntheticContext;
    const interaction = new SyntheticInteraction({ kind: "slash", channelId: "thread",
      command: "seam", subcommandGroup: "info", subcommand: "sessions" }, context);
    const output = browserReplyFromInteraction(interaction);
    await interaction.deferReply({ flags: 64 });
    await output.editReply({ content: "browser" });
    const target = output.target;
    const restored = browserReply(target, "owner", "thread", async () => ({ ...context, message } as unknown as SyntheticContext));
    await restored.editReply({ content: "after restart" });
    expect(message.edit).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(restored.target).toBe(target);
    now += 15 * 60 * 1000 + 1;
    await expect(restored.editReply({ content: "too late" })).rejects.toThrow();
    expect(message.edit).toHaveBeenCalledTimes(1);
  });
});
