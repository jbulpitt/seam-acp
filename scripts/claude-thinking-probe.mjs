import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
const acp = await import("@agentclientprotocol/sdk");
for (const model of [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
]) {
  const proc = spawn("claude-agent-acp", [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MAX_THINKING_TOKENS: "16000", ANTHROPIC_MODEL: model },
  });
  proc.stderr.on("data", () => {});
  const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
  let thoughtChars = 0;
  const conn = new acp.ClientSideConnection(() => ({
    async sessionUpdate(p) {
      if (p.update.sessionUpdate === "agent_thought_chunk") {
        thoughtChars += (p.update.content?.text ?? "").length;
      }
    },
    async requestPermission() { return { outcome: { outcome: "selected", optionId: "allow_once" } }; },
  }), stream);
  await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: {} } });
  const ns = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
  await conn.prompt({ sessionId: ns.sessionId, prompt: [{ type: "text", text: "Think step-by-step: 17 * 23 = ?" }] });
  console.log(`${model.padEnd(12)} → thought chars: ${thoughtChars}, current=${ns.models?.currentModelId}`);
  proc.kill();
  await new Promise(r => setTimeout(r, 500));
}
