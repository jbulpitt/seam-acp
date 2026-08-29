import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let calls = 0;
const server = new Server(
  { name: "test-echo", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a value with backend process details",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" }, delayMs: { type: "number" } },
        required: ["value"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  calls += 1;
  const value = String(request.params.arguments?.value ?? "");
  const delayMs = Number(request.params.arguments?.delayMs ?? 0);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    content: [{ type: "text", text: JSON.stringify({ value, pid: process.pid, calls }) }],
  };
});

await server.connect(new StdioServerTransport());
