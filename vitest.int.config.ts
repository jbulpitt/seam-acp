import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { LIVE_TEST_INCLUDE } from "./test/test-suite-boundary.js";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: [...LIVE_TEST_INCLUDE],
    environment: "node",
    env: {
      SEAM_LIVE_ACP: "1",
    },
    setupFiles: [path.join(root, "test/non-live-env.ts")],
  },
  resolve: {
    alias: {
      "@seam/adapters": path.join(root, "packages/adapters/src/index.ts"),
    },
  },
});
