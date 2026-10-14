import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { renderStatusPanel, TurnStatus } from "../packages/core/src/core/status-panel.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";

const ref = { channel: { platform: "discord", id: "thread" }, id: "status-message" };
const terminal = (state: "Done" | "Failed", style: "full" | "simple" = "full") => {
  const status = new TurnStatus({ model: "fixture-model", repoDisplay: "/fixture", style });
  status.setState(state);
  status.setAction(state === "Done" ? "end_turn" : "provider rejected the turn");
  return renderStatusPanel(discordRenderer, status.toInput(), Date.now());
};

function setup() {
  const logger = { child: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.child.mockReturnValue(logger);
  const adapter = new DiscordAdapter({ config: {} as never, logger: logger as never,
    slashHandler: vi.fn() });
  const edit = vi.fn(async (messageId: string, payload: { embeds: Array<{ toJSON(): any }> }) => {
    const embed = payload.embeds[0]!.toJSON();
    return { id: messageId, channelId: "thread", editedTimestamp: 1234,
      embeds: [{ title: embed.title ?? null, author: embed.author ?? null, color: embed.color }] };
  });
  const fetchChannel = vi.fn(async () => ({ messages: { edit } }));
  Object.defineProperty(adapter, "fetchSendableChannel", { value: fetchChannel });
  return { adapter, logger, edit, fetchChannel };
}

describe("terminal status PATCH receipts", () => {
  it.each(["full", "simple"] as const)("logs intent and the real Discord acknowledgement for %s cards", async style => {
    const h = setup();
    await h.adapter.editPanel(ref, terminal("Done", style));
    const expected = { sequence: 1, channelId: "thread", messageId: "status-message", targetState: "Done" };
    expect(h.logger.info.mock.calls).toEqual([
      [expected, "status card terminal PATCH intent"],
      [{ ...expected, ack: { messageId: "status-message", channelId: "thread", editedTimestamp: 1234,
        stateLabel: "Done", color: 0x57f287 } }, "status card terminal PATCH acknowledged"],
    ]);
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logger.info.mock.calls)).not.toContain("fixture-model");
    expect(JSON.stringify(h.logger.info.mock.calls)).not.toContain("/fixture");
  });

  it("keeps request sequence when terminal acknowledgements complete out of order", async () => {
    const h = setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const edit = h.edit.getMockImplementation()!;
    h.edit.mockImplementationOnce(async (...args) => { entered(); await gate; return edit(...args); });
    const first = h.adapter.editPanel(ref, terminal("Done"));
    await started;
    try { await h.adapter.editPanel(ref, terminal("Failed")); }
    finally { release(); await first; }
    const calls = h.logger.info.mock.calls;
    expect(calls.map(([record]) => record.sequence)).toEqual([1, 2, 2, 1]);
    expect(calls.map(([record]) => record.targetState)).toEqual(["Done", "Failed", "Failed", "Done"]);
  });

  it("warns with the original rejection and rethrows it without a success acknowledgement", async () => {
    const h = setup();
    const err = Object.assign(new Error("Discord refused PATCH: Missing Access"), { code: 50001, status: 403 });
    h.edit.mockRejectedValueOnce(err);
    await expect(h.adapter.editPanel(ref, terminal("Failed"))).rejects.toBe(err);
    expect(h.logger.info).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith({ sequence: 1, channelId: "thread", messageId: "status-message",
      targetState: "Failed", err }, "status card terminal PATCH failed");
  });

  it("records a real channel-acquisition failure instead of silently losing the edit", async () => {
    const h = setup();
    const err = new Error("thread lookup failed: Unknown Channel");
    h.fetchChannel.mockRejectedValueOnce(err);
    await expect(h.adapter.editPanel(ref, terminal("Done"))).rejects.toBe(err);
    expect(h.edit).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1, err }),
      "status card terminal PATCH failed");
  });

  it("does not log Working status edits or ordinary panels titled Done", async () => {
    const h = setup();
    const status = new TurnStatus({ model: "fixture", repoDisplay: "/fixture" });
    await h.adapter.editPanel(ref, renderStatusPanel(discordRenderer, status.toInput(), Date.now()));
    await h.adapter.editPanel(ref, { title: "Done", color: 0, fields: [] } satisfies StructuredPanel);
    expect(h.logger.info).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
    await h.adapter.editPanel(ref, terminal("Done"));
    expect(h.logger.info.mock.calls[0]![0].sequence).toBe(2);
  });
});
