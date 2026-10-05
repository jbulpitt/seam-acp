import type { Plugin } from "../types.js";
import type { ConfigUi } from "./ui.js";
export { ConfigUi } from "./ui.js";
import { CONFIG_UI_GROUP, CONFIG_UI_LEAVES } from "./commands.js";

export function createConfigUiPlugin(ui: ConfigUi, lifecycle: { activate(): void; dispose(): void } = { activate() {}, dispose() {} }): Plugin {
  return {
    id: "config-ui", apiVersion: 1, builtin: true, internal: true,
    activate: () => lifecycle.activate(), dispose: () => lifecycle.dispose(),
    contributions: {
      slash: CONFIG_UI_LEAVES.map(leaf => ({
        command: "seam", group: CONFIG_UI_GROUP, leaf: leaf.leaf, access: { kind: leaf.access }, authorization: "user", help: leaf.help,
        ...(leaf.name === "set" ? { autocomplete: ui.ports.autocomplete } : {}),
        handle: async invocation => { await ui[leaf.method](ui.ports.interaction(invocation)); },
      })),
      components: [{ namespace: "seam-cfg-edit:", types: ["button", "select", "modal"], lifetime: "persistent", access: "read-only", authorization: "user",
        handle: evt => ui.handleConfigEditorComponent(evt) }],
    },
  };
}
