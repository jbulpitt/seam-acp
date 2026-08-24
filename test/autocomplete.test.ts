import { describe, it, expect } from "vitest";
import {
  AutocompleteRegistry,
  autocompleteKey,
  filterByPrefix,
  presetAutocompleteChoices,
  safeAutocompleteRespond,
  toAutocompleteChoices,
  DISCORD_AUTOCOMPLETE_MAX,
} from "../packages/core/src/platforms/discord/autocomplete.js";
import { classifyDiscordInteraction } from "../packages/core/src/platforms/discord/adapter.js";
import { CHOICE_CUSTOM_ID_PREFIX } from "../packages/core/src/core/choice/types.js";

describe("AutocompleteRegistry", () => {
  it("keys responders by (group, subcommand, optionName)", async () => {
    const reg = new AutocompleteRegistry();
    reg.register("preset", "thread", "preset", () => [{ name: "reviewer", value: "reviewer" }]);
    expect(autocompleteKey("preset", "thread", "preset")).toBe("preset/thread/preset");
    const hit = reg.get("preset", "thread", "preset");
    expect(hit).toBeTypeOf("function");
    expect(await hit!({
      group: "preset",
      subcommand: "thread",
      optionName: "preset",
      focusedValue: "",
      projectScopeId: "chan-1",
    })).toEqual([{ name: "reviewer", value: "reviewer" }]);
    expect(reg.get("preset", "apply", "name")).toBeUndefined();
    expect(reg.get("preset", "thread", "name")).toBeUndefined();
  });

  it("apply/delete/show/edit name share a responder; create/list stay unregistered", async () => {
    const reg = new AutocompleteRegistry();
    const responder = () => [{ name: "reviewer", value: "reviewer" }];
    for (const sub of ["apply", "delete", "show", "edit"] as const) {
      reg.register("preset", sub, "name", responder);
    }
    for (const sub of ["apply", "delete", "show", "edit"] as const) {
      const hit = reg.get("preset", sub, "name");
      expect(hit, sub).toBeTypeOf("function");
      expect(
        await hit!({
          group: "preset",
          subcommand: sub,
          optionName: "name",
          focusedValue: "",
          projectScopeId: "chan-1",
        })
      ).toEqual([{ name: "reviewer", value: "reviewer" }]);
    }
    expect(reg.get("preset", "create", "name")).toBeUndefined();
    expect(reg.get("preset", "list", "name")).toBeUndefined();
  });
});

describe("preset autocomplete responder", () => {
  const presets = [
    { name: "reviewer" },
    { name: "ReviewBot" },
    { name: "writer" },
    { name: "deploy" },
  ];

  it("filters by case-insensitive name prefix", () => {
    expect(presetAutocompleteChoices(presets, "rev", "chan-1").map((c) => c.value)).toEqual([
      "reviewer",
      "ReviewBot",
    ]);
    expect(presetAutocompleteChoices(presets, "REV", "chan-1").map((c) => c.name)).toEqual([
      "reviewer",
      "ReviewBot",
    ]);
  });

  it("empty prefix returns all (still capped)", () => {
    expect(presetAutocompleteChoices(presets, "", "chan-1")).toHaveLength(4);
    expect(presetAutocompleteChoices(presets, "   ", "chan-1")).toHaveLength(4);
  });

  it("empty scope ⇒ no choices (D3)", () => {
    expect(presetAutocompleteChoices(presets, "rev", undefined)).toEqual([]);
    expect(presetAutocompleteChoices(presets, "rev", "")).toEqual([]);
    expect(presetAutocompleteChoices(presets, "", undefined)).toEqual([]);
  });

  it("caps at 25", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `p${String(i).padStart(2, "0")}` }));
    const choices = presetAutocompleteChoices(many, "p", "chan-1");
    expect(choices).toHaveLength(DISCORD_AUTOCOMPLETE_MAX);
    expect(choices[0]?.value).toBe("p00");
    expect(choices[24]?.value).toBe("p24");
  });

  it("de-dupes by value", () => {
    const dupes = [{ name: "build" }, { name: "build" }, { name: "other" }];
    expect(toAutocompleteChoices(dupes).map((c) => c.value)).toEqual(["build", "other"]);
  });

  it("prefix filter is startsWith, not substring", () => {
    expect(filterByPrefix([{ name: "pre-review" }, { name: "reviewer" }], "rev").map((p) => p.name)).toEqual([
      "reviewer",
    ]);
  });
});

describe("safeAutocompleteRespond never throws", () => {
  it("responds with produced choices", async () => {
    const got: unknown[] = [];
    await safeAutocompleteRespond(
      async (choices) => {
        got.push(...choices);
      },
      () => [{ name: "a", value: "a" }]
    );
    expect(got).toEqual([{ name: "a", value: "a" }]);
  });

  it("producer throw → respond [] and does not reject", async () => {
    let responded: unknown = "unset";
    await expect(
      safeAutocompleteRespond(
        async (choices) => {
          responded = choices;
        },
        () => {
          throw new Error("boom");
        }
      )
    ).resolves.toBeUndefined();
    expect(responded).toEqual([]);
  });

  it("respond throw after producer throw is swallowed", async () => {
    await expect(
      safeAutocompleteRespond(
        async () => {
          throw new Error("discord down");
        },
        () => {
          throw new Error("boom");
        }
      )
    ).resolves.toBeUndefined();
  });

  it("caps even if producer returns more than 25", async () => {
    let n = 0;
    await safeAutocompleteRespond(
      async (choices) => {
        n = choices.length;
      },
      () => Array.from({ length: 40 }, (_, i) => ({ name: `x${i}`, value: `x${i}` }))
    );
    expect(n).toBe(25);
  });
});

describe("classifyDiscordInteraction — autocomplete is a parallel branch", () => {
  const flags = (over: {
    autocomplete?: boolean;
    chat?: boolean;
    button?: boolean;
    modal?: boolean;
    select?: boolean;
    commandName?: string;
    customId?: string;
  }) => ({
    isAutocomplete: () => over.autocomplete === true,
    isChatInputCommand: () => over.chat === true,
    isButton: () => over.button === true,
    isModalSubmit: () => over.modal === true,
    isStringSelectMenu: () => over.select === true,
    commandName: over.commandName,
    customId: over.customId,
  });

  it("routes /seam autocomplete to autocomplete (not slash)", () => {
    expect(
      classifyDiscordInteraction(flags({ autocomplete: true, commandName: "seam" }))
    ).toBe("autocomplete");
  });

  it("ignores autocomplete for other commands", () => {
    expect(
      classifyDiscordInteraction(flags({ autocomplete: true, commandName: "other" }))
    ).toBe("none");
  });

  it("chat-input /seam still routes to slash", () => {
    expect(classifyDiscordInteraction(flags({ chat: true, commandName: "seam" }))).toBe("slash");
    expect(classifyDiscordInteraction(flags({ chat: true, commandName: "ping" }))).toBe("none");
  });

  it("config-editor buttons/modals still route to config-edit", () => {
    expect(
      classifyDiscordInteraction(
        flags({ button: true, customId: "seam-cfg-edit:draft-1" })
      )
    ).toBe("config-edit");
    expect(
      classifyDiscordInteraction(
        flags({ modal: true, customId: "seam-cfg-edit:draft-1:rider" })
      )
    ).toBe("config-edit");
  });

  it("TTS settings-card buttons route to the persistent-component handler", () => {
    expect(
      classifyDiscordInteraction(flags({ button: true, customId: "seam-tts:draft-1:cancel" }))
    ).toBe("config-edit");
    expect(
      classifyDiscordInteraction(flags({ button: true, customId: "seam-tts:draft-1:toggle" }))
    ).toBe("config-edit");
  });

  it("choice cards still route to choice", () => {
    expect(
      classifyDiscordInteraction(
        flags({ button: true, customId: `${CHOICE_CUSTOM_ID_PREFIX}abc:0` })
      )
    ).toBe("choice");
    expect(
      classifyDiscordInteraction(
        flags({ select: true, customId: `${CHOICE_CUSTOM_ID_PREFIX}abc:s` })
      )
    ).toBe("choice");
    expect(
      classifyDiscordInteraction(
        flags({ modal: true, customId: `${CHOICE_CUSTOM_ID_PREFIX}abc:m:0` })
      )
    ).toBe("choice");
    expect(
      classifyDiscordInteraction(
        flags({ button: true, customId: `${CHOICE_CUSTOM_ID_PREFIX}abc:c` })
      )
    ).toBe("choice");
  });

  it("autocomplete wins if a malformed payload claimed both (must not fall into slash)", () => {
    expect(
      classifyDiscordInteraction(
        flags({ autocomplete: true, chat: true, commandName: "seam" })
      )
    ).toBe("autocomplete");
  });

  it("chat-input without isAutocomplete (legacy shape) still routes to slash", () => {
    expect(
      classifyDiscordInteraction({
        isChatInputCommand: () => true,
        isButton: () => false,
        isModalSubmit: () => false,
        commandName: "seam",
      })
    ).toBe("slash");
  });
});
