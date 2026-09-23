import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  NON_LIVE_TEST_EXCLUDE,
  NON_LIVE_TEST_INCLUDE,
} from "./test/test-suite-boundary.js";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: [...NON_LIVE_TEST_INCLUDE],
    exclude: [...NON_LIVE_TEST_EXCLUDE],
    environment: "node",
    setupFiles: [path.join(root, "test/non-live-env.ts")],
    globalSetup: [path.join(root, "test/global-priority.ts")],
  },
  resolve: {
    alias: {
      "@seam/adapters": path.join(root, "packages/adapters/src/index.ts"),
    },
  },
});
