import { describe, it, expect } from "vitest";
import {
  cyclePace,
  cycleStyle,
  effectiveTts,
  isTtsDraftDirty,
  parseTtsCustomId,
  renderTtsHub,
  renderTtsVoiceStep,
  ttsDirtyChanges,
  voiceIndexFor,
  type TtsEditorDraft,
} from "../packages/core/src/platforms/discord/tts-editor.js";

function draft(over: Partial<TtsEditorDraft> = {}): TtsEditorDraft {
  return {
    id: "d1",
    threadId: "t1",
    userId: "u1",
    createdAt: 1,
    updatedAt: 1,
    snapshot: { tts: false, voice: "Kore", pace: "natural", style: "neutral" },
    overlay: {},
    view: "hub",
    voiceIndex: voiceIndexFor("Kore"),
    ...over,
  };
}

describe("tts editor", () => {
  it("parses custom ids and rejects others", () => {
    expect(parseTtsCustomId("seam-tts:d1:toggle")).toEqual({ draftId: "d1", action: "toggle" });
    expect(parseTtsCustomId("seam-cfg-edit:d1:save")).toBeNull();
  });

  it("cycles pace and style", () => {
    expect(cyclePace("slow")).toBe("natural");
    expect(cyclePace("fast")).toBe("faster");
    expect(cyclePace("faster")).toBe("slow");
    expect(cycleStyle("neutral")).toBe("warm");
    expect(cycleStyle("clear")).toBe("neutral");
  });

  it("hub shows current settings and Save disabled until dirty", () => {
    const clean = renderTtsHub(draft());
    expect(clean.title).toContain("TTS");
    expect(clean.fields.find((f) => f.name === "TTS")?.value).toBe("`off`");
    const save = clean.actions?.flat().find((b) => b.label === "Save");
    expect(save?.disabled).toBe(true);

    const dirtyDraft = draft({ overlay: { tts: true } });
    expect(isTtsDraftDirty(dirtyDraft)).toBe(true);
    const dirty = renderTtsHub(dirtyDraft);
    expect(dirty.actions?.flat().find((b) => b.label === "Save")?.disabled).toBe(false);
    expect(ttsDirtyChanges(dirtyDraft)).toEqual({ tts: true });
  });

  it("voice step shows style text and disables prev on first voice", () => {
    const panel = renderTtsVoiceStep(draft({ view: "voice", voiceIndex: 0 }));
    expect(panel.title).toMatch(/Voice 1\/30/);
    expect(panel.description).toMatch(/Zephyr/i);
    expect(panel.actions?.flat().find((b) => b.label === "◀ Prev")?.disabled).toBe(true);
  });

  it("picking a voice only dirties ttsVoice", () => {
    const d = draft({ overlay: { voice: "Puck" } });
    expect(effectiveTts(d).voice).toBe("Puck");
    expect(ttsDirtyChanges(d)).toEqual({ ttsVoice: "Puck" });
  });
});
