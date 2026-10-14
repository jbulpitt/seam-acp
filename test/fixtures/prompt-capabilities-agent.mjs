import fs from "node:fs";
import path from "node:path";

const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const message = JSON.parse(String(chunk));
  if (message.result?.protocolVersion === 1 && message.result.agentCapabilities) {
    const caps = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.FAKE_AGENT_REQUESTS), "prompt-capabilities.json"), "utf8"));
    if (caps !== null) message.result.agentCapabilities.promptCapabilities = caps;
  }
  return write(`${JSON.stringify(message)}\n`, ...args);
};
await import("./fake-acp-agent.mjs");
