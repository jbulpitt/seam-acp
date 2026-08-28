import { describe, expect, it } from "vitest";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  VOICE_CONSOLE_EMBED_LIMITS,
  VOICE_CONSOLE_REQUIRED_PERMISSIONS,
  paginateVoiceConsoleBindings,
  renderDuplicateVoiceConfirmation,
  renderFanoutDisarmConfirmation,
  renderVoiceConsoleBindingEditor,
  renderVoiceConsoleEndConfirmation,
  renderVoiceConsoleMutationConfirmation,
  renderVoiceConsolePanel,
  renderVoiceConsolePermissionError,
  renderVoiceConsoleStatusPages,
  renderVoiceConsoleVoicePreview,
  resolveVoiceConsoleCardLocation,
  voiceConsolePermissionError,
  type VoiceConsoleBindingPresentation,
  type VoiceConsoleDiagnosticState,
  type VoiceConsolePanelState,
  type VoiceConsolePanelSpec,
} from "../packages/core/src/platforms/discord/voice-console-panel.js";
import {
  inertVoiceConsoleAlias,
  inertVoiceConsoleText,
  truncateVoiceConsoleText,
  voiceConsoleVoiceIndex,
  type VoiceConsoleBindingEditorDraft,
  type VoiceConsoleComponentRow,
} from "../packages/core/src/platforms/discord/voice-console-components.js";

function discordPanelJson(panel: VoiceConsolePanelSpec) {
  const embed = new EmbedBuilder().setColor(panel.color).setTitle(panel.title);
  if (panel.description !== undefined) embed.setDescription(panel.description);
  if (panel.fields.length > 0) {
    embed.addFields(panel.fields.map((field) => ({
      name: field.name,
      value: field.value,
      ...(field.inline !== undefined ? { inline: field.inline } : {}),
    })));
  }
  if (panel.footer !== undefined) embed.setFooter({ text: panel.footer });
  return {
    embed: embed.toJSON(),
    components: discordComponentJson(panel.components),
  };
}

function discordComponentJson(rows: ReadonlyArray<VoiceConsoleComponentRow>): unknown[] {
  return rows.map((row) => {
    const first = row.components[0];
    if (first?.kind === "select") {
      const built = new ActionRowBuilder<StringSelectMenuBuilder>();
      for (const component of row.components) {
        if (component.kind !== "select") throw new Error("mixed component row");
        built.addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(component.customId)
            .setPlaceholder(component.placeholder)
            .setMinValues(component.minValues)
            .setMaxValues(component.maxValues)
            .setDisabled(component.disabled ?? false)
            .addOptions(component.options.map((option) => ({
              label: option.label,
              value: option.value,
              ...(option.description !== undefined
                ? { description: option.description }
                : {}),
              ...(option.default !== undefined ? { default: option.default } : {}),
            })))
        );
      }
      return built.toJSON();
    }
    const built = new ActionRowBuilder<ButtonBuilder>();
    for (const component of row.components) {
      if (component.kind !== "button") throw new Error("mixed component row");
      built.addComponents(
        new ButtonBuilder()
          .setCustomId(component.customId)
          .setLabel(component.label)
          .setStyle(buttonStyle(component.style))
          .setDisabled(component.disabled ?? false)
      );
    }
    return built.toJSON();
  });
}

function buttonStyle(style: "primary" | "secondary" | "success" | "danger"): ButtonStyle {
  switch (style) {
    case "primary": return ButtonStyle.Primary;
    case "success": return ButtonStyle.Success;
    case "danger": return ButtonStyle.Danger;
    case "secondary": return ButtonStyle.Secondary;
  }
}

function embedTextUnits(embed: ReturnType<EmbedBuilder["toJSON"]>): number {
  return (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0) +
    (embed.footer?.text.length ?? 0);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function binding(index: number, over: Partial<VoiceConsoleBindingPresentation> = {}): VoiceConsoleBindingPresentation {
  return {
    bindingId: `tvb_${index}`,
    alias: `Thread ${index}`,
    threadId: `10000000000000000${index}`,
    voice: index % 2 === 0 ? "Kore" : "Puck",
    pace: "natural",
    style: "neutral",
    outputEnabled: index !== 2,
    acpState: index === 0 ? "working" : "idle",
    pendingSegments: index,
    pendingCharacters: index * 20,
    speechState: index === 0 ? "speaking" : index === 2 ? "disabled" : "idle",
    ...over,
  };
}

function state(over: Partial<VoiceConsolePanelState> = {}): VoiceConsolePanelState {
  return {
    consoleId: "tvc_console",
    revision: 12,
    ownerUserId: "111111111111111111",
    ownerName: "Jesse",
    voiceChannelId: "222222222222222222",
    cardChannelId: "222222222222222222",
    lifecycle: "ready",
    runtimeState: "capturing",
    connectionState: "connected",
    forwardedAudioMs: 125_000,
    fanoutArmed: true,
    selectedBindingIds: ["tvb_0", "tvb_6"],
    bindings: Array.from({ length: 10 }, (_, index) => binding(index)),
    speakers: [
      { userId: "333333333333333333", displayName: "A", state: "capturing" },
      { userId: "444444444444444444", displayName: "B", state: "awaiting-safe-mute" },
    ],
    unauthorizedListenerCount: 2,
    page: 0,
    currentSpeaking: { alias: "Thread 0", voice: "Kore" },
    lastUpdatedUtc: "2026-08-28T12:00:00.000Z",
    ...over,
  };
}

function editor(): VoiceConsoleBindingEditorDraft {
  return {
    consoleId: "tvc_console",
    revision: 12,
    bindingId: "tvb_0",
    snapshot: { alias: "Kanoa", voice: "Kore", pace: "natural", style: "neutral" },
    overlay: { style: "warm" },
    voiceIndex: voiceConsoleVoiceIndex("Puck"),
  };
}

describe("VC-chat-only canonical location", () => {
  it("always resolves to the voice channel id", () => {
    expect(resolveVoiceConsoleCardLocation({ voiceChannelId: "vc_1" }))
      .toEqual({ ok: true, channelId: "vc_1" });
    expect(resolveVoiceConsoleCardLocation({
      voiceChannelId: "vc_1",
      persistedCardChannelId: "vc_1",
    })).toEqual({ ok: true, channelId: "vc_1" });
  });

  it("rejects a mismatched persisted location and names no fallback", () => {
    const result = resolveVoiceConsoleCardLocation({
      voiceChannelId: "vc_1",
      persistedCardChannelId: "thread_1",
    });
    expect(result).toMatchObject({ ok: false, code: "card-channel-mismatch" });
    if (result.ok) return;
    expect(result.error).toContain("cannot be relocated to a thread");
  });
});

describe("precise VC-chat permission presentation", () => {
  it("orders and deduplicates the exact required Discord permissions", () => {
    const failure = voiceConsolePermissionError({
      voiceChannelId: "vc_1",
      missing: ["ReadMessageHistory", "ViewChannel", "ViewChannel", "EmbedLinks"],
    });
    expect(failure.missing).toEqual(["ViewChannel", "EmbedLinks", "ReadMessageHistory"]);
    expect(failure.message).toContain("`ViewChannel`, `EmbedLinks`, `ReadMessageHistory`");
    expect(failure.message).toContain("not moved to an ACP thread");
  });

  it("renders every prerequisite without weakening card control authorization", () => {
    const panel = renderVoiceConsolePermissionError({
      voiceChannelId: "vc_1",
      missing: VOICE_CONSOLE_REQUIRED_PERMISSIONS,
    });
    expect(panel.title).toContain("unavailable");
    for (const permission of VOICE_CONSOLE_REQUIRED_PERMISSIONS) {
      expect(panel.description).toContain(permission);
    }
    expect(panel.components).toEqual([]);
    expect(panel.footer).toContain("before console creation or lease acquisition");
  });
});

describe("canonical concise card", () => {
  it("renders page one, fan-out/cost, speaker lanes, status, and exactly five component rows", () => {
    const panel = renderVoiceConsolePanel(state());
    expect(panel.title).toBe("🎛️ Shared Voice Console");
    expect(panel.description).toMatch(/Fan-out multiplies ACP and TTS/);
    expect(panel.components).toHaveLength(5);
    expect(panel.footer).toContain("Page 1/2 · revision 12");
    const input = panel.fields.find((field) => field.name === "Input")?.value;
    expect(input).toBe("**⚠️ FAN-OUT ×2**");
    const speakers = panel.fields.find((field) => field.name === "Speakers")?.value ?? "";
    expect(speakers).toContain("333333333333333333");
    expect(speakers).toContain("2 unauthorized listeners");
    const bindings = panel.fields.find((field) => field.name === "Bindings")?.value ?? "";
    expect(bindings).toContain("Thread 0");
    expect(bindings).toContain("Thread 4");
    expect(bindings).not.toContain("Thread 5");

    for (const row of panel.components.slice(0, 3)) {
      const component = row.components[0]!;
      expect(component.kind).toBe("select");
      if (component.kind === "select") expect(component.options).toHaveLength(10);
    }
  });

  it("renders five different binding lines on page two and clamps stale pages", () => {
    const second = renderVoiceConsolePanel(state({ page: 1 }));
    const lines = second.fields.find((field) => field.name === "Bindings")?.value ?? "";
    expect(lines).not.toContain("Thread 4");
    expect(lines).toContain("Thread 5");
    expect(lines).toContain("Thread 9");

    expect(paginateVoiceConsoleBindings([1, 2, 3, 4, 5, 6], 99)).toEqual({
      page: 1,
      pageCount: 2,
      bindings: [6],
    });
  });

  it("shows Input off safe-mute guidance and disables every terminal control", () => {
    const panel = renderVoiceConsolePanel(state({
      selectedBindingIds: [],
      fanoutArmed: false,
      lifecycle: "ended",
      runtimeState: "ended",
    }));
    expect(panel.fields.find((field) => field.name === "Input")?.value)
      .toContain("Mute, then unmute");
    for (const component of panel.components.flatMap((row) => row.components)) {
      expect(component.disabled).toBe(true);
    }
  });

  it("refuses rendering when the persisted card points at an ACP thread", () => {
    expect(() => renderVoiceConsolePanel(state({ cardChannelId: "thread_wrong" })))
      .toThrow(/cannot be relocated to a thread/);
  });
});

describe("paginated diagnostic status", () => {
  it("returns one page per five bindings with shared scheduler, lease, usage, lanes, and card link", () => {
    const diagnostic: VoiceConsoleDiagnosticState = {
      ...state(),
      uptimeMs: 3_661_000,
      transmittedAudioBytes: 4_000_000,
      activeLaneCount: 2,
      schedulerQueueDepth: 3,
      schedulerSource: { alias: "Thread 0", voice: "Kore" },
      leaseHolder: { kind: "thread_voice", sessionId: "tvc_console" },
      cardJumpUrl: "https://discord.com/channels/guild/vc/message",
    };
    const pages = renderVoiceConsoleStatusPages(diagnostic);
    expect(pages).toHaveLength(2);
    for (const [index, panel] of pages.entries()) {
      expect(panel.title).toContain(`${index + 1}/2`);
      expect(panel.fields.find((field) => field.name === "Scheduler")?.value).toContain("queue 3");
      expect(panel.fields.find((field) => field.name === "Voice lease")?.value).toContain("tvc_console");
      expect(panel.fields.find((field) => field.name === "Canonical card")?.value).toContain("Open VC-chat card");
      expect(panel.fields.some((field) => field.name.includes("Authorized speakers"))).toBe(true);
      expect(panel.footer).toContain("STT usage is not multiplied");
      expect(panel.components).toEqual([]);
    }
    expect(pages[0]!.fields.some((field) => field.name.includes("Thread 0"))).toBe(true);
    expect(pages[0]!.fields.some((field) => field.name.includes("Thread 5"))).toBe(false);
    expect(pages[1]!.fields.some((field) => field.name.includes("Thread 5"))).toBe(true);
  });

  it("fits worst-case five-binding pages inside every Discord embed limit", () => {
    const astral = "😀".repeat(3_000);
    const bindings = Array.from({ length: 10 }, (_, index) => binding(index, {
      alias: `${astral}${index}`,
      voice: astral,
      pace: astral,
      style: astral,
      acpState: astral,
    }));
    const hostile = state({
      runtimeState: astral,
      connectionState: astral,
      bindings,
      currentSpeaking: { alias: astral, voice: astral },
      lastUpdatedUtc: astral,
    });
    const diagnostic: VoiceConsoleDiagnosticState = {
      ...hostile,
      uptimeMs: 3_661_000,
      transmittedAudioBytes: 4_000_000,
      activeLaneCount: 2,
      schedulerQueueDepth: 99,
      schedulerSource: { alias: astral, voice: astral },
      leaseHolder: { kind: astral, sessionId: astral },
      cardJumpUrl: `https://discord.com/${astral}`,
    };
    const panels = [
      renderVoiceConsolePanel(hostile),
      ...renderVoiceConsoleStatusPages(diagnostic),
    ];

    for (const panel of panels) {
      const built = discordPanelJson(panel);
      expect(built.embed.title?.length ?? 0).toBeLessThanOrEqual(
        VOICE_CONSOLE_EMBED_LIMITS.title
      );
      expect(built.embed.description?.length ?? 0).toBeLessThanOrEqual(
        VOICE_CONSOLE_EMBED_LIMITS.description
      );
      expect(built.embed.footer?.text.length ?? 0).toBeLessThanOrEqual(
        VOICE_CONSOLE_EMBED_LIMITS.footer
      );
      for (const field of built.embed.fields ?? []) {
        expect(field.name.length).toBeLessThanOrEqual(VOICE_CONSOLE_EMBED_LIMITS.fieldName);
        expect(field.value.length).toBeLessThanOrEqual(VOICE_CONSOLE_EMBED_LIMITS.fieldValue);
      }
      expect(embedTextUnits(built.embed)).toBeLessThanOrEqual(
        VOICE_CONSOLE_EMBED_LIMITS.aggregate
      );
      const strings = [
        built.embed.title ?? "",
        built.embed.description ?? "",
        built.embed.footer?.text ?? "",
        ...(built.embed.fields ?? []).flatMap((field) => [field.name, field.value]),
      ];
      expect(strings.some(hasUnpairedSurrogate)).toBe(false);
    }
  });
});

describe("inert alias presentation", () => {
  it("neutralizes spoofing and Markdown across every card/editor alias surface", () => {
    const aliases = [
      "<#123456789012345678>",
      "**Admin**",
      "`code`",
      "[Open](https://evil.example)",
      "<@123456789012345678>",
      "<@&123456789012345678>",
      "@everyone",
      "@here",
      "> quote",
      "||spoiler|| 家族😀",
    ];
    const bindings = aliases.map((alias, index) => binding(index, { alias }));
    const shared = state({
      bindings,
      page: 0,
      currentSpeaking: { alias: aliases[3]!, voice: "Kore" },
    });
    const diagnostic: VoiceConsoleDiagnosticState = {
      ...shared,
      uptimeMs: 1,
      transmittedAudioBytes: 1,
      activeLaneCount: 0,
      schedulerQueueDepth: 0,
      schedulerSource: { alias: aliases[5]!, voice: "Kore" },
      leaseHolder: { kind: "thread_voice", sessionId: "tvc_console" },
      cardJumpUrl: null,
    };
    const hostileDraft: VoiceConsoleBindingEditorDraft = {
      ...editor(),
      snapshot: {
        alias: aliases[3]!,
        voice: "Kore",
        pace: "natural",
        style: "neutral",
      },
    };
    const rendered = [
      renderVoiceConsolePanel(shared),
      renderVoiceConsolePanel({ ...shared, page: 1 }),
      ...renderVoiceConsoleStatusPages(diagnostic),
      renderVoiceConsoleBindingEditor({
        draft: hostileDraft,
        duplicateVoiceAliases: aliases,
      }),
      renderVoiceConsoleVoicePreview({ draft: hostileDraft }),
      renderDuplicateVoiceConfirmation({ draft: hostileDraft, duplicateAliases: aliases }),
      renderFanoutDisarmConfirmation({
        consoleId: "tvc_console",
        revision: 12,
        selectedBindings: bindings.slice(0, 2),
      }),
    ];
    for (const panel of rendered) discordPanelJson(panel);
    const serialized = JSON.stringify(rendered);

    for (const alias of aliases) {
      expect(serialized).toContain(inertVoiceConsoleAlias(alias));
    }
    for (const activeSyntax of [
      "<#123456789012345678>",
      "<@123456789012345678>",
      "<@&123456789012345678>",
      "@everyone",
      "@here",
      "**Admin**",
      "`code`",
      "[Open](https://evil.example)",
      "https://evil.example",
      "> quote",
      "||spoiler||",
    ]) {
      expect(serialized).not.toContain(activeSyntax);
    }
  });
});

describe("confirmation and profile views", () => {
  it("makes every dynamic mutation-confirmation string inert and Discord-valid", () => {
    const title = "Alias saved: **Admin** `inline` ```fenced``` 😀".repeat(20);
    const summary = [
      "Alias is [Open](https://evil.example) ||spoiler||",
      "> blockquote",
      "<#123456789012345678> <@123456789012345678>",
      "<@&123456789012345678> @everyone @here",
      "\\*escaped\\* https://evil.example",
      "astral 😀 家族",
    ].join("\n").repeat(40);
    const panel = renderVoiceConsoleMutationConfirmation({
      title,
      summary,
      revision: 13,
    });
    const built = discordPanelJson(panel);
    const serialized = JSON.stringify(built);

    expect(panel.title).toBe(truncateVoiceConsoleText(
      inertVoiceConsoleText(title),
      VOICE_CONSOLE_EMBED_LIMITS.title
    ));
    expect(panel.description).toBeDefined();
    expect(serialized).toContain("＊＊Admin＊＊");
    expect(serialized).toContain("｀inline｀");
    expect(serialized).toContain("｀｀｀fenced｀｀｀");
    expect(serialized).toContain("｜｜spoiler｜｜");
    expect(serialized).toContain("＞ blockquote");
    expect(serialized).toContain("＜＃123456789012345678＞");
    expect(serialized).toContain("＜＠123456789012345678＞");
    expect(serialized).toContain("＜＠&123456789012345678＞");
    expect(serialized).toContain("＠everyone");
    expect(serialized).toContain("＠here");
    expect(serialized).toContain("＼＊escaped＼＊");
    expect(serialized).toContain("https：／／evil．example");
    expect(serialized).toContain("😀");
    for (const activeSyntax of [
      "**Admin**",
      "`inline`",
      "```fenced```",
      "||spoiler||",
      "> blockquote",
      "[Open](https://evil.example)",
      "https://evil.example",
      "<#123456789012345678>",
      "<@123456789012345678>",
      "<@&123456789012345678>",
      "@everyone",
      "@here",
      "\\*escaped\\*",
    ]) {
      expect(serialized).not.toContain(activeSyntax);
    }
    expect(built.embed.title?.length ?? 0).toBeLessThanOrEqual(
      VOICE_CONSOLE_EMBED_LIMITS.title
    );
    expect(built.embed.description?.length ?? 0).toBeLessThanOrEqual(
      VOICE_CONSOLE_EMBED_LIMITS.description
    );
    expect(embedTextUnits(built.embed)).toBeLessThanOrEqual(
      VOICE_CONSOLE_EMBED_LIMITS.aggregate
    );
    expect(hasUnpairedSurrogate(built.embed.title ?? "")).toBe(false);
    expect(hasUnpairedSurrogate(built.embed.description ?? "")).toBe(false);
  });

  it("requires explicit end confirmation and defaults to preservation", () => {
    const panel = renderVoiceConsoleEndConfirmation({
      consoleId: "tvc_console",
      revision: 12,
      bindingCount: 3,
      pendingSegments: 4,
    });
    expect(panel.description).toContain("preserved by default");
    expect(panel.components[0]!.components.map((component) => component.kind === "button" ? component.label : ""))
      .toEqual(["End and preserve pending", "Cancel"]);
  });

  it("keeps fan-out unchanged until one binding is selected", () => {
    const panel = renderFanoutDisarmConfirmation({
      consoleId: "tvc_console",
      revision: 12,
      selectedBindings: [binding(0), binding(1)],
    });
    expect(panel.description).toContain("remains unchanged");
    expect(panel.components[0]!.components[0]).toMatchObject({
      kind: "select",
      placeholder: "Keep which input target?",
    });
  });

  it("renders console-local profile editing, duplicate warning, and preview descriptor", () => {
    const draft = editor();
    const edit = renderVoiceConsoleBindingEditor({
      draft,
      duplicateVoiceAliases: ["Homework"],
    });
    expect(edit.description).toContain("does not change the thread's ordinary");
    expect(edit.fields.find((field) => field.name.includes("Duplicate"))?.value).toContain("Homework");

    const duplicate = renderDuplicateVoiceConfirmation({
      draft,
      duplicateAliases: ["Homework"],
    });
    expect(duplicate.description).toContain("Different voices");
    expect(duplicate.footer).toContain("unchanged until confirmed");

    const preview = renderVoiceConsoleVoicePreview({ draft, sampleStatus: "ready" });
    expect(preview.title).toMatch(/Voice \d+\/30 · Puck/);
    expect(preview.previewRequest).toMatchObject({ voice: "Puck", bindingId: "tvb_0" });
    expect(preview.components).toHaveLength(2);
  });
});
