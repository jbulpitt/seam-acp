import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";

function adapter() {
  const logger = { child: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.child.mockReturnValue(logger);
  return new DiscordAdapter({
    config: {
      DISCORD_ALLOWED_USER_IDS: new Set(["human"]),
      DISCORD_USER_NAMES: new Map(),
    } as any,
    logger: logger as any,
  });
}

const ref = { channel: { platform: "discord" as const, id: "channel-1" }, id: "message-1" };

describe("Discord card edits patch by id (#445)", () => {
  it("editMessage does not fetch the message before the PATCH", async () => {
    const discord = adapter();
    const fetch = vi.fn();
    const edit = vi.fn(async () => ({}));
    (discord as any).fetchSendableChannel = vi.fn(async () => ({ messages: { fetch, edit } }));

    await discord.editMessage(ref, "working");

    expect(fetch).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("message-1", expect.objectContaining({ content: "working" }));
  });

  it("editPanel does not fetch the message before the PATCH", async () => {
    const discord = adapter();
    const fetch = vi.fn();
    const edit = vi.fn(async () => ({}));
    (discord as any).fetchSendableChannel = vi.fn(async () => ({ messages: { fetch, edit } }));
    const panel: StructuredPanel = {
      title: "Working",
      color: 0,
      fields: [],
    };

    await discord.editPanel(ref, panel);

    expect(fetch).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[0]).toBe("message-1");
  });
});
