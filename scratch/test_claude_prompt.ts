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

  console.log("Creating session with haiku model...");
  await runtime.newSession({
    cwd: "/tmp",
    model: "haiku",
  });

  runtime.onEvent((event) => {
    console.log("EVENT:", JSON.stringify(event, null, 2));
  });

  console.log("Sending prompt...");
  const outcome = await runtime.prompt("Say hello world and nothing else.");
  console.log("Outcome:", JSON.stringify(outcome, null, 2));

  await runtime.dispose();
}

main().catch(console.error);
