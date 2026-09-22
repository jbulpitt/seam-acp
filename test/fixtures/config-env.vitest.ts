import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.js";

// Run the actual config consumers from a disposable cwd containing its own
// real .env. Absolute includes keep source/dependencies in the sanctioned tree.
export default defineConfig({
  ...base,
  root: process.cwd(),
  test: {
    ...base.test,
    include: [
      "restart-config", "ollama-cloud-park", "opencode-retirement", "service-status-card",
      "agy-config", "config-participant-ids", "model-value-rankings-card", "config-admin-ids",
      "channel-visibility", "human-inject", "agent-location-deny",
      "config-explicit-env",
    ].map(name => fileURLToPath(new URL(`../${name}.test.ts`, import.meta.url))),
    setupFiles: [
      fileURLToPath(new URL("../non-live-env.ts", import.meta.url)),
      fileURLToPath(new URL("./config-env-assert-setup.ts", import.meta.url)),
    ],
  },
});
