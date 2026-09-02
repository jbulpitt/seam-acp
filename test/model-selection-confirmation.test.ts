import { describe, expect, it } from "vitest";
import { modelSelectionConfirmationPanel } from "../packages/core/src/platforms/discord/orchestrator.js";

describe("modelSelectionConfirmationPanel", () => {
  it("reports an exact no-op instead of claiming the model changed", () => {
    expect(modelSelectionConfirmationPanel("default", "default", "Jesse")).toEqual({
      color: 0x57f287,
      title: "✅ Model confirmed",
      fields: [{ name: "Model", value: "`default` *(no change)*", inline: true }],
      footer: "Confirmed by Jesse",
    });
  });

  it("reports both identities when the model changes", () => {
    expect(modelSelectionConfirmationPanel("default", "claude-opus-5", "Jesse")).toEqual({
      color: 0x57f287,
      title: "✅ Model changed",
      fields: [
        { name: "Previous", value: "`default`", inline: true },
        { name: "New", value: "`claude-opus-5`", inline: true },
      ],
      footer: "Changed by Jesse",
    });
  });
});
