import { makeClaudeProfile } from "../src/agents/profiles/claude.js";
import { AgentRuntime } from "../src/agents/agent-runtime.js";

async function main() {
  const profile = makeClaudeProfile({
    defaultModel: "claude-sonnet-4.6",
  });

  const logger = {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.log,
  } as any;
  logger.child = () => logger;

  const runtime = new AgentRuntime({
    profile,
    logger,
    mcpServers: [],
  });

  console.log("Starting runtime...");
  await runtime.start();

  console.log("Creating session...");
  const info = await runtime.newSession({
    cwd: "/tmp",
  });

  console.log("Session Info:");
  console.log("Current Model ID:", info.currentModelId);
  console.log("Available Models:", JSON.stringify(info.availableModels, null, 2));

  await runtime.dispose();
}

main().catch(console.error);
