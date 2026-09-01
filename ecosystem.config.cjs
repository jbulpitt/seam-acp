const path = require("node:path");
const fs = require("node:fs");

/** Read one KEY=value from seam's .env at config-eval time. pm2's `env_file`
 *  loading proved unreliable for the broker app, but the inline `env` object
 *  always applies — so keys the broker needs are injected through this. */
function envFromDotenv(name) {
  try {
    const line = fs
      .readFileSync(path.join(__dirname, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(name + "="));
    return line ? line.slice(name.length + 1).trim() : "";
  } catch {
    return "";
  }
}

module.exports = {
  apps: [
    {
      name: "seam-acp",
      script: "packages/core/dist/index.js",
      cwd: __dirname,
      interpreter: "node",
      kill_timeout: 120000,
      // Restart automatically on crash; back off if it crashes repeatedly
      restart_delay: 3000,
      max_restarts: 10,
      // Load .env file values into the process environment
      env_file: ".env",
      // Merge current shell PATH so host CLIs (copilot, gemini, claude) are found
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
      },
    },
    {
      name: "homeschool-google-mcp",
      script: path.join(__dirname, "packages/core/dist/shared-mcp/stdio-tool-broker-cli.js"),
      cwd: "/home/ubuntu/Projects/homeschool",
      interpreter: "node",
      restart_delay: 3000,
      max_restarts: 10,
      env_file: "/home/ubuntu/Projects/homeschool/.env",
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
        SHARED_MCP_NAME: "homeschool-google-multi",
        SHARED_MCP_COMMAND: "/home/ubuntu/.nvm/versions/node/v22.22.2/bin/mcp-google-multi",
        SHARED_MCP_ARGS_JSON: "[]",
        SHARED_MCP_CWD: "/home/ubuntu/Projects/homeschool",
        SHARED_MCP_PORT: "8765",
      },
    },
    {
      name: "pronoa-playwright-mcp",
      script: "/home/ubuntu/.nvm/versions/node/v22.22.2/bin/playwright-mcp",
      args: [
        "--port", "8766",
        "--host", "127.0.0.1",
        "--headless",
        "--isolated",
        "--executable-path", "/home/ubuntu/.cache/ms-playwright/chromium-1226/chrome-linux/chrome",
        "--image-responses", "allow",
        "--output-dir", "/tmp/pronoa-playwright-mcp",
      ],
      cwd: "/home/ubuntu/Projects/pronoa",
      interpreter: "none",
      restart_delay: 3000,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
      },
    },
    {
      // Shared Artificial Analysis MCP (LLM benchmarks/pricing) exposed on a
      // loopback port so every agent backend gets it via buildGlobalMcpServers —
      // same broker pattern as homeschool-google-multi. AA_API_KEY comes from
      // seam's .env (env_file) and is inherited by the spawned AA server.
      name: "artificial-analysis-mcp",
      script: path.join(__dirname, "packages/core/dist/shared-mcp/stdio-tool-broker-cli.js"),
      cwd: __dirname,
      interpreter: "node",
      restart_delay: 3000,
      max_restarts: 10,
      env_file: ".env",
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
        AA_API_KEY: envFromDotenv("AA_API_KEY"),
        SHARED_MCP_NAME: "artificial-analysis",
        SHARED_MCP_COMMAND: "/home/ubuntu/.nvm/versions/node/v22.22.2/bin/artificial-analysis-mcp",
        SHARED_MCP_ARGS_JSON: "[]",
        SHARED_MCP_PORT: "8767",
      },
    },
  ],
};
