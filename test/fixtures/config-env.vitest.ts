import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.js";

// Run config consumers beside real .env files they must ignore.
export default defineConfig({
  ...base,
  root: process.cwd(),
  plugins: [{
    name: "assert-no-dotenv-loading",
    configResolved(config) {
      if (config.env.VITE_SEAM_620_OPERATOR_ONLY !== undefined) {
        throw new Error("Vite loaded the operator .env before worker setup");
      }
    },
  }],
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
