/* ACP standalone repro - bypasses our orchestrator entirely. */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
} from "@agentclientprotocol/sdk";

const COPILOT = process.env.COPILOT_BIN ?? "copilot";
const PROMPT =
  process.env.ACP_PROMPT ??
  "give me a 50 line poem about coding as a markdown file";

const t0 = Date.now();
const ts = () => `${(Date.now() - t0).toString().padStart(6)}ms`;
const log = (...a: unknown[]) => console.log(ts(), ...a);

log("spawning", COPILOT, "--acp");
const child = spawn(COPILOT, ["--acp"], {
  stdio: ["pipe", "pipe", "inherit"],
});

const writable = Writable.toWeb(
  child.stdin
) as unknown as WritableStream<Uint8Array>;
const readable = Readable.toWeb(
  child.stdout
) as unknown as ReadableStream<Uint8Array>;
const stream = ndJsonStream(writable, readable);

const client: Client = {
  async requestPermission() {
    log("requestPermission -> allow");
    return {
      outcome: { outcome: "selected", optionId: "allow" },
    } as never;
  },
  async sessionUpdate(p) {
    const u = p.update as {
      sessionUpdate: string;
      content?: { type?: string; text?: string };
    };
    const kind = u.sessionUpdate;
    const text = u.content?.text;
    const preview =
      typeof text === "string" ? JSON.stringify(text.slice(0, 60)) : "";
    log("update", kind, preview);
  },
  async writeTextFile() {
    return null as never;
  },
  async readTextFile() {
    return null as never;
  },
};

const conn = new ClientSideConnection(() => client, stream);

log("initialize");
const init = await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
log(
  "initialized; promptCaps:",
  JSON.stringify(init.agentCapabilities?.promptCapabilities)
);

log("newSession");
const session = await conn.newSession({
  cwd: process.cwd(),
  mcpServers: [],
});
log("session created:", session.sessionId);

log("prompt sent:", JSON.stringify(PROMPT));
const result = await conn.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: PROMPT }],
});
log("prompt result:", JSON.stringify(result));

child.kill("SIGTERM");
process.exit(0);
