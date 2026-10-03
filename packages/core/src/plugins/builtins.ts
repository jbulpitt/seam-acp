import type { BuiltinPlugin } from "./types.js";

export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  { id: "math", load: async () => (await import("./math/index.js")).mathPlugin },
];
