import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ScheduleUi } from "../packages/core/src/plugins/schedule-ui/index.js";
import { discordScheduleListRows } from "./helpers/discord-schedule-list-rows.js";

describe("Discord schedule list compatibility", () => {
  it("keeps list message JSON byte-identical to the pre-extraction payloads", () => {
    let rows = discordScheduleListRows();
    const ui = new ScheduleUi({ logger: { warn() {}, error() {} }, repository: { list: () => rows } } as any);
    const channel = { platform: "discord", id: "thread", parentId: "parent" };
    const views = [0, 1, 99].map(page => ui.buildScheduleListMessage(channel, page));
    rows = [];
    views.push(ui.buildScheduleListMessage(channel));
    expect(JSON.stringify(views, null, 2) + "\n").toBe(readFileSync(new URL("./fixtures/discord-schedule-list.json", import.meta.url), "utf8"));
  });
});
