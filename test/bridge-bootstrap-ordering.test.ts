import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import { SupervisedSlots, type SupervisedBridgeFrame } from "../packages/bridge/src/supervised-slots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const servers: SessiondServer[] = [];
const clients: SessiondClient[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const line = (message: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("native fixture did not publish the ACP response");
}

describe("bootstrap ordering through real sessiond, holder and adapter-child", () => {
  it("inventory cannot send control before bootstrap, and the same child completes its turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-bootstrap-ordering-"));
    roots.push(root);
    const socketPath = path.join(root, "control.sock");
    const server = new SessiondServer({ socketPath, statePath: path.join(root, "slots.json") });
    servers.push(server);
    await server.start();
    const client = await SessiondClient.connect(socketPath);
    clients.push(client);
    const frames: Array<SupervisedBridgeFrame & { slot: number }> = [];
    const stderr: string[] = [];
    const slots = new SupervisedSlots({ client, localCwd: root,
      copilotCmd: path.join(here, "fixtures/fake-acp-agent.mjs"),
      adapterChildPath: path.join(here, "helpers/adapter-child-source.mjs"),
      environment: { HOME: root, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
      onFrame: frame => frames.push(frame), onStderr: (_slot, chunk) => stderr.push(chunk.toString()),
    });
    const writer = server as unknown as { holderWrite(entry: unknown, bytes: Buffer): Promise<boolean> };
    const original = writer.holderWrite.bind(server);
    const entered = deferred(), release = deferred();
    vi.spyOn(writer, "holderWrite").mockImplementation(async (entry, bytes) => {
      if (JSON.parse(bytes.toString()).type === "bootstrap") {
        entered.resolve();
        await release.promise;
      }
      return original(entry, bytes);
    });
    const writes = vi.spyOn(client, "write");
    slots.configure(7, { agentId: "copilot", cwd: root, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY });
    const starting = slots.writeInput(7, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }))
      .then(delivered => ({ delivered }), error => ({ error }));
    try {
      await entered.promise;
      const inventory = await slots.listSlots();
      const owner = inventory.health.find(row => row.slot === 7)!;
      expect(owner).toMatchObject({ alive: true, attached: true });
      expect(writes).not.toHaveBeenCalled();

      release.resolve();
      expect(await starting).toEqual({ delivered: true });
      const response = (id: number) => until(() => {
        for (const frame of frames.filter(frame => frame.type === "data")) {
          for (const raw of (frame.data ?? "").trim().split("\n").filter(Boolean)) {
            const message = JSON.parse(raw);
            if (message.id === id) return message;
          }
        }
        return undefined;
      });
      expect(await response(1)).toMatchObject({ result: { protocolVersion: 1 } });
      await slots.writeInput(7, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
      expect(await response(2)).toMatchObject({ result: { sessionId: "s1" } });
      await slots.armRecovery(7, { submissionId: "boot-turn", acpSessionId: "s1", continuation: "continue" });
      await slots.writeInput(7, line({ id: 3, method: "session/prompt", params: {
        sessionId: "s1", prompt: [{ type: "text", text: "continue" }],
      } }));
      expect(await response(3)).toMatchObject({ result: { stopReason: "end_turn" } });
      const reads = await slots.listSlots();
      expect(reads.health.find(row => row.slot === 7)).toMatchObject({ pid: owner.pid, alive: true,
        session: { acpSessionId: "s1" }, recovery: { submissionId: "boot-turn", phase: "succeeded" } });
      expect(frames.some(frame => frame.type === "exit")).toBe(false);
      expect(stderr.join("")).not.toContain("invalid bootstrap");
    } finally {
      release.resolve();
      await starting;
    }
  }, 30_000);
});
