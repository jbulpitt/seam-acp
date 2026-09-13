import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  startStdioToolBroker,
  type RunningStdioToolBroker,
} from "../packages/core/src/shared-mcp/stdio-tool-broker.js";

interface EchoResult {
  value: string;
  pid: number;
  calls: number;
}

const fixturePath = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
const brokers: RunningStdioToolBroker[] = [];
const clients: Client[] = [];

async function connectClient(port: number, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  clients.push(client);
  return client;
}

async function echo(client: Client, value: string, delayMs = 0): Promise<EchoResult> {
  const result = await client.callTool({ name: "echo", arguments: { value, delayMs } });
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("Expected a text tool result");
  return JSON.parse(block.text) as EchoResult;
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
});

describe("shared stdio MCP tool broker", () => {
  /**
   * #384 — same reasoning as the AGY enrichment test: the cost is the subject.
   * This spawns a real backend process, stands up a real loopback listener, and
   * drives two independent MCP sessions through a full handshake before the
   * concurrent calls that prove both landed on ONE backend pid. Nothing here
   * can be stubbed without deleting what is being asserted.
   *
   * Measured 4.38s on a quiet host on 2026-09-12 against vitest's 5s default —
   * a 12% margin, close enough that a busy host reports it as a regression.
   * 15s is ~3.4x the measured cost.
   */
  it("multiplexes independent HTTP sessions onto one backend process", async () => {
    const broker = await startStdioToolBroker({
      command: process.execPath,
      args: [fixturePath],
      port: 0,
      name: "test-shared-mcp",
      logger: { info() {}, warn() {}, error() {} },
    });
    brokers.push(broker);

    expect(broker.host).toBe("127.0.0.1");
    expect(broker.backendPid).toBeTypeOf("number");

    const [first, second] = await Promise.all([
      connectClient(broker.port, "first"),
      connectClient(broker.port, "second"),
    ]);
    const tools = await first.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("echo");

    const [slow, fast] = await Promise.all([
      echo(first, "first", 30),
      echo(second, "second"),
    ]);
    expect(slow.value).toBe("first");
    expect(fast.value).toBe("second");
    expect(slow.pid).toBe(broker.backendPid);
    expect(fast.pid).toBe(broker.backendPid);

    await first.close();
    clients.splice(clients.indexOf(first), 1);
    expect((await echo(second, "still-alive")).value).toBe("still-alive");
  }, 15_000);

  it("exposes health without authentication only on the loopback listener", async () => {
    const broker = await startStdioToolBroker({
      command: process.execPath,
      args: [fixturePath],
      port: 0,
      name: "test-shared-mcp",
      logger: { info() {}, warn() {}, error() {} },
    });
    brokers.push(broker);

    const response = await fetch(`http://127.0.0.1:${broker.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, backendPid: broker.backendPid, sessions: 0 });
  });
});
