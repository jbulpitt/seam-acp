import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { discordScheduleBuilderViews } from "./helpers/discord-schedule-builder-views.js";

afterEach(() => vi.useRealTimers());
it("keeps new, isolated-edit and live-edit Discord builder JSON byte-identical", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  expect(JSON.stringify(await discordScheduleBuilderViews(), null, 2) + "\n")
    .toBe(readFileSync(new URL("./fixtures/discord-schedule-builder.json", import.meta.url), "utf8"));
});
