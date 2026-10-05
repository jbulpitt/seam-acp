import type { Plugin } from "../types.js";
import type { PresetUi } from "./ui.js";
import { presetAutocompleteChoices } from "../../platforms/discord/autocomplete.js";
import { PRESET_COMMAND_GROUP, PRESET_ACCESS } from "./commands.js";
export { PresetUi } from "./ui.js";

const methods = {
  list: "cmdPresetList", create: "cmdPresetCreate", apply: "cmdPresetApply", delete: "cmdPresetDelete",
  show: "cmdPresetShow", edit: "cmdPresetEdit", thread: "cmdPresetThread",
} as const;
const help = {
  list: "`/seam preset list` — list reusable presets", create: "`/seam preset create [global] [role]` — create a preset",
  apply: "`/seam preset apply <name>` — apply a preset to this thread", delete: "`/seam preset delete <name>` — delete a preset",
  show: "`/seam preset show <name>` — show a preset", edit: "`/seam preset edit <name>` — edit a preset",
  thread: "`/seam preset thread <preset> [name] [quantity]` — start a thread from a preset",
};

export function createPresetPlugin(ui: PresetUi): Plugin {
  return {
    id: "presets", apiVersion: 1, builtin: true, internal: true,
    // The host aliases this namespace to the legacy table's shared database.
    activate: context => {
      context.storage?.path("presets.sqlite");
      const file = context.storage?.path("cards.json");
      if (file) ui.cards.load(file);
    },
    dispose: () => ui.cards.stop(),
    contributions: {
      slash: PRESET_COMMAND_GROUP.options!.map(leaf => {
        const name = leaf.name as keyof typeof methods;
        return {
          command: "seam", group: { name: PRESET_COMMAND_GROUP.name, description: PRESET_COMMAND_GROUP.description }, acknowledgement: "ephemeral", leaf,
          access: { kind: PRESET_ACCESS[name] }, authorization: "user", help: help[name],
          ...(["thread", "apply", "delete", "show", "edit"].includes(name) ? { autocomplete: [{
            option: name === "thread" ? "preset" : "name", policy: "canonical" as const,
            respond: ctx => ctx.projectScopeId ? presetAutocompleteChoices(ui.repository.listPresetsForProject(ctx.projectScopeId), ctx.focusedValue, ctx.projectScopeId) : [],
          }] } : {}),
          handle: async invocation => { await ui[methods[name]](ui.ports.interaction(invocation)); },
        };
      }),
      components: [
        { namespace: "preset:", types: ["button", "select", "modal"], lifetime: "persistent", access: "read-only", authorization: "user",
          acknowledgement: evt => evt.kind === "button" && ["details", "naming", "tools", "instr"].includes(evt.customId.split(":")[1]!) ? "modal" : "update",
          handle: async event => { await ui.cards.handle(ui.ports.component(event)); } },
        { namespace: "pr:", types: ["button"], lifetime: "persistent", access: "read-only", authorization: "user",
          acknowledgement: evt => ["edit", "apply"].includes(evt.customId.split(":")[1]!) ? "ephemeral" : "update",
          handle: async event => { await ui.cards.handle(ui.ports.component(event)); } },
      ],
      jobs: [{ name: "card-expiry", phase: "after-admission", intervalMs: 600_000,
        start: () => ui.cards.start(), stop: () => ui.cards.stop(), drain: () => ui.cards.drain() }],
    },
  };
}
