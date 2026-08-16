import { describe, it, expect } from "vitest";
import { frameSteerPrompt } from "../src/core/steer.js";

describe("frameSteerPrompt", () => {
  it("wraps the prompt in a <seam-steer> fence with the operator directive", () => {
    expect(frameSteerPrompt("go check the logs")).toBe(
      "<seam-steer>\ngo check the logs\n</seam-steer>\n\n" +
        "The operator is steering you mid-task — adjust to the above now."
    );
  });

  it("preserves the raw prompt verbatim inside the fence (incl. multi-line)", () => {
    const raw = "line 1\nline 2";
    const framed = frameSteerPrompt(raw);
    expect(framed).toContain(`<seam-steer>\n${raw}\n</seam-steer>`);
    expect(framed.startsWith("<seam-steer>\n")).toBe(true);
    expect(framed.trimEnd().endsWith("adjust to the above now.")).toBe(true);
  });
});
