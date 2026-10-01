import { describe, it, expect } from "vitest";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";

describe("TurnStatus style + brand (#96)", () => {
  it("defaults to full and omits style from toInput", () => {
    const s = new TurnStatus({ model: "m", repoDisplay: "r" });
    expect(s.style).toBe("full");
    expect(s.toInput().style).toBeUndefined();
  });

  it("threads simple style, hosted icon, author, and contextPct", () => {
    const s = new TurnStatus({
      model: "m",
      repoDisplay: "r",
      style: "simple",
      brandIconURL: "https://icons.example/grok.webp",
      authorName: "Grok Build",
    });
    s.contextUsedHighWater = 13_000;
    s.contextWindowSize = 100_000;
    const input = s.toInput();
    expect(input.style).toBe("simple");
    expect(input.brandIconURL).toBe("https://icons.example/grok.webp");
    expect(input.authorName).toBe("Grok Build");
    expect(input.contextPct).toBe(13);
  });

});
