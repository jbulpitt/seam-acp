import fs from "node:fs";
import readline from "node:readline";

const pages = JSON.parse(process.env.FIXTURE_SESSION_PAGES ?? "{}");
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line);
  if (process.env.FIXTURE_REQUEST_LOG) fs.appendFileSync(process.env.FIXTURE_REQUEST_LOG, `${line}\n`);
  let result;
  let error;
  if (request.method === "initialize") {
    result = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } };
  } else if (request.method === "session/list") {
    if (process.env.FIXTURE_LIST_FAILURE) error = { code: -32000, message: "session source unavailable: permission denied" };
    else result = pages[request.params.cursor ?? "first"] ?? { sessions: [] };
  } else {
    error = { code: -32601, message: `Unexpected method: ${request.method}` };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) })}\n`);
});
