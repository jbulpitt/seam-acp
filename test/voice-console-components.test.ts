import { describe, expect, it } from "vitest";
import {
  VOICE_CONSOLE_CUSTOM_ID_MAX,
  buildBindingEditorRows,
  buildDuplicateVoiceConfirmationRows,
  buildEndConsoleConfirmationRows,
  buildFanoutDisarmConfirmationRows,
  buildVoiceConsoleAliasModal,
  buildVoiceConsoleComponentRows,
  buildVoicePreviewRows,
  cycleVoiceConsolePace,
  cycleVoiceConsoleStyle,
  effectiveVoiceConsoleBindingProfile,
  isVoiceConsoleBindingEditorDirty,
  makeVoiceConsoleCustomId,
  parseVoiceConsoleAlias,
  parseVoiceConsoleCustomId,
  parseVoiceConsoleInteraction,
  voiceConsolePreviewRequest,
  voiceConsoleVoiceIndex,
  type VoiceConsoleBindingControlOption,
  type VoiceConsoleBindingEditorDraft,
} from "../packages/core/src/platforms/discord/voice-console-components.js";

function binding(index: number, over: Partial<VoiceConsoleBindingControlOption> = {}): VoiceConsoleBindingControlOption {
  return {
    bindingId: `tvb_${index}`,
    alias: `Thread ${index}`,
    threadId: `thread_${index}`,
    voice: index % 2 === 0 ? "Kore" : "Puck",
    outputEnabled: index !== 3,
    ...over,
  };
}

function editor(over: Partial<VoiceConsoleBindingEditorDraft> = {}): VoiceConsoleBindingEditorDraft {
  return {
    consoleId: "tvc_console",
    revision: 17,
    bindingId: "tvb_1",
    snapshot: { alias: "Kanoa", voice: "Kore", pace: "natural", style: "neutral" },
    overlay: {},
    voiceIndex: voiceConsoleVoiceIndex("Kore"),
    ...over,
  };
}

describe("Voice Console immutable custom ids", () => {
  it("round-trips console id, revision, action, and editor binding id", () => {
    const card = makeVoiceConsoleCustomId("tvc_abc", 42, "input");
    expect(card).toBe("tvc:tvc_abc:42:input");
    expect(parseVoiceConsoleCustomId(card)).toEqual({
      consoleId: "tvc_abc",
      revision: 42,
      action: "input",
    });

    const editorId = makeVoiceConsoleCustomId("tvc_abc", 42, "edit-save", "tvb_xyz");
    expect(parseVoiceConsoleCustomId(editorId)).toEqual({
      consoleId: "tvc_abc",
      revision: 42,
      action: "edit-save",
      subjectId: "tvb_xyz",
    });
    expect(editorId.length).toBeLessThanOrEqual(VOICE_CONSOLE_CUSTOM_ID_MAX);
  });

  it("rejects unknown actions, extra fields, unsafe revisions, and subject confusion", () => {
    expect(parseVoiceConsoleCustomId("other:tvc_abc:1:input")).toBeNull();
    expect(parseVoiceConsoleCustomId("tvc:tvc_abc:01:input")).toBeNull();
    expect(parseVoiceConsoleCustomId("tvc:tvc_abc:1:invented")).toBeNull();
    expect(parseVoiceConsoleCustomId("tvc:tvc_abc:1:input:tvb_1")).toBeNull();
    expect(parseVoiceConsoleCustomId("tvc:tvc_abc:1:edit-save")).toBeNull();
    expect(() => makeVoiceConsoleCustomId("x".repeat(48), Number.MAX_SAFE_INTEGER, "edit-save", "y".repeat(48)))
      .toThrow(/100-character/);
  });
});

describe("Voice Console interaction parser", () => {
  it("accepts immutable binding values with action-specific counts", () => {
    expect(parseVoiceConsoleInteraction({
      customId: "tvc:tvc_abc:3:input",
      values: ["tvb_a", "tvb_b"],
    })).toEqual({
      ok: true,
      id: { consoleId: "tvc_abc", revision: 3, action: "input" },
      bindingIds: ["tvb_a", "tvb_b"],
    });
    expect(parseVoiceConsoleInteraction({
      customId: "tvc:tvc_abc:3:output",
      values: [],
    }).ok).toBe(true);
    expect(parseVoiceConsoleInteraction({
      customId: "tvc:tvc_abc:3:configure",
      values: ["tvb_a"],
    }).ok).toBe(true);
  });

  it("refuses duplicate, malformed, excessive, missing, or unexpected values", () => {
    expect(parseVoiceConsoleInteraction({ customId: "choice:x:0", values: [] }))
      .toEqual({ ok: false, error: "not-voice-console" });
    expect(parseVoiceConsoleInteraction({ customId: "tvc:tvc_abc:3:configure", values: [] }))
      .toEqual({ ok: false, error: "missing-binding-id" });
    expect(parseVoiceConsoleInteraction({ customId: "tvc:tvc_abc:3:configure", values: ["a", "b"] }))
      .toEqual({ ok: false, error: "invalid-selection" });
    expect(parseVoiceConsoleInteraction({ customId: "tvc:tvc_abc:3:input", values: ["a", "a"] }))
      .toEqual({ ok: false, error: "invalid-selection" });
    expect(parseVoiceConsoleInteraction({ customId: "tvc:tvc_abc:3:refresh", values: ["a"] }))
      .toEqual({ ok: false, error: "unexpected-binding-id" });
    expect(parseVoiceConsoleInteraction({
      customId: "tvc:tvc_abc:3:input",
      values: ["a", "b", "c", "d", "e", "f"],
    })).toEqual({ ok: false, error: "invalid-selection" });
  });
});

describe("canonical five-row component layout", () => {
  it("uses all ten bindings in selectors while navigation pages card lines", () => {
    const bindings = Array.from({ length: 10 }, (_, index) => binding(index));
    const rows = buildVoiceConsoleComponentRows({
      consoleId: "tvc_console",
      revision: 8,
      fanoutArmed: true,
      selectedBindingIds: ["tvb_1", "tvb_8"],
      bindings,
      page: 0,
      pageCount: 2,
    });
    expect(rows).toHaveLength(5);
    const input = rows[0]!.components[0]!;
    const output = rows[1]!.components[0]!;
    const configure = rows[2]!.components[0]!;
    expect(input.kind).toBe("select");
    expect(output.kind).toBe("select");
    expect(configure.kind).toBe("select");
    if (input.kind !== "select" || output.kind !== "select" || configure.kind !== "select") return;
    expect(input.options).toHaveLength(10);
    expect(input.maxValues).toBe(5);
    expect(input.options.filter((option) => option.default).map((option) => option.value))
      .toEqual(["tvb_1", "tvb_8"]);
    expect(output.minValues).toBe(0);
    expect(output.options.filter((option) => option.default)).toHaveLength(9);
    expect(configure.maxValues).toBe(1);
    expect(configure.options.map((option) => option.value)).toEqual(bindings.map((item) => item.bindingId));
    expect(rows[3]!.components.map((component) => component.kind === "button" ? component.label : ""))
      .toEqual(["Input off", "Disarm fan-out", "Output all on", "Output all off"]);
    expect(rows[4]!.components.map((component) => component.kind === "button" ? component.label : ""))
      .toEqual(["◀ Previous", "Next ▶", "Refresh", "End console…"]);
  });

  it("keeps focused input single-select and represents durable Input off", () => {
    const rows = buildVoiceConsoleComponentRows({
      consoleId: "tvc_console",
      revision: 9,
      fanoutArmed: false,
      selectedBindingIds: [],
      bindings: [binding(1), binding(2)],
      page: 0,
      pageCount: 1,
    });
    const input = rows[0]!.components[0]!;
    expect(input.kind).toBe("select");
    if (input.kind !== "select") return;
    expect(input.maxValues).toBe(1);
    expect(input.placeholder).toMatch(/Input off/);
    expect(rows[3]!.components[0]).toMatchObject({ label: "Input off", disabled: true });
  });

  it("refuses inconsistent or over-cap durable render state", () => {
    expect(() => buildVoiceConsoleComponentRows({
      consoleId: "tvc_console",
      revision: 1,
      fanoutArmed: false,
      selectedBindingIds: ["tvb_1", "tvb_2"],
      bindings: [binding(1), binding(2)],
      page: 0,
      pageCount: 1,
    })).toThrow(/focused/);
    expect(() => buildVoiceConsoleComponentRows({
      consoleId: "tvc_console",
      revision: 1,
      fanoutArmed: true,
      selectedBindingIds: [],
      bindings: Array.from({ length: 11 }, (_, index) => binding(index)),
      page: 0,
      pageCount: 3,
    })).toThrow(/at most ten/);
  });
});

describe("confirmation and binding-editor components", () => {
  it("end confirmation preserves by default and exposes discard only explicitly", () => {
    const preserve = buildEndConsoleConfirmationRows({ consoleId: "tvc_c", revision: 1 });
    expect(preserve[0]!.components.map((component) => component.kind === "button" ? component.label : ""))
      .toEqual(["End and preserve pending", "Cancel"]);
    const discard = buildEndConsoleConfirmationRows({
      consoleId: "tvc_c",
      revision: 1,
      allowDiscard: true,
    });
    expect(discard[0]!.components.some((component) =>
      component.kind === "button" && component.label.includes("discard")))
      .toBe(true);
  });

  it("fan-out disarm requires one immutable binding selection before changing state", () => {
    const rows = buildFanoutDisarmConfirmationRows({
      consoleId: "tvc_c",
      revision: 2,
      selectedBindings: [binding(1), binding(2)],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.components[0]).toMatchObject({
      kind: "select",
      placeholder: "Keep which input target?",
      minValues: 1,
      maxValues: 1,
    });
    expect(() => buildFanoutDisarmConfirmationRows({
      consoleId: "tvc_c",
      revision: 2,
      selectedBindings: [binding(1)],
    })).toThrow(/several/);
  });

  it("renders a console-local editor, alias modal, and 30-voice preview stepper", () => {
    const draft = editor({ overlay: { alias: "Homework", pace: "fast" } });
    expect(effectiveVoiceConsoleBindingProfile(draft)).toMatchObject({ alias: "Homework", pace: "fast" });
    expect(isVoiceConsoleBindingEditorDirty(draft)).toBe(true);
    expect(buildBindingEditorRows(draft)).toHaveLength(3);
    expect(buildVoiceConsoleAliasModal(draft)).toMatchObject({
      title: "Edit binding alias",
      fields: [{ minLength: 1, maxLength: 32, value: "Homework" }],
    });
    expect(buildVoicePreviewRows(draft)).toHaveLength(2);
    expect(voiceConsolePreviewRequest(draft)).toMatchObject({
      bindingId: "tvb_1",
      voice: "Kore",
      pace: "fast",
      attachmentName: "voice-preview-kore.ogg",
    });
    expect(buildDuplicateVoiceConfirmationRows(draft)[0]!.components).toHaveLength(2);
    expect(cycleVoiceConsolePace("fast")).toBe("slow");
    expect(cycleVoiceConsoleStyle("clear")).toBe("neutral");
  });
});

describe("alias parser", () => {
  it("removes controls, neutralizes mentions, collapses whitespace, and produces a uniqueness key", () => {
    expect(parseVoiceConsoleAlias("  Kanoa\n<@123>  ")).toEqual({
      ok: true,
      alias: "Kanoa<＠123>",
      normalized: "kanoa<＠123>",
    });
    expect(parseVoiceConsoleAlias("@everyone")).toMatchObject({ ok: true, alias: "＠everyone" });
  });

  it("enforces 1–32 visible characters", () => {
    expect(parseVoiceConsoleAlias("\u0000\n")).toEqual({
      ok: false,
      error: "Alias must contain 1–32 visible characters.",
    });
    expect(parseVoiceConsoleAlias("x".repeat(33))).toEqual({
      ok: false,
      error: "Alias must contain 1–32 visible characters.",
    });
  });
});
