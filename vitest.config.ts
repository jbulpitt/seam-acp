import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: [path.join(root, "test/non-live-env.ts")],
  },
  resolve: {
    alias: {
      "@seam/adapters": path.join(root, "packages/adapters/src/index.ts"),
    },
  },
});
