import { runStdioToolBrokerCli } from "./stdio-tool-broker.js";

runStdioToolBrokerCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
