/**
 * #631 — a turn interrupted by a host restart continues by itself.
 *
 * Real sessiond, slot holder, adapter-child and SupervisedSlots, with a fake
 * ACP agent. The "restart" kills every process the way a shutdown does, then
 * starts a new sessiond against the same resume directory.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import { SupervisedSlots, type SupervisedBridgeFrame } from "../packages/bridge/src/supervised-slots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterChild = path.join(here, "helpers/adapter-child-source.mjs");
const fakeAgent = path.join(here, "fixtures/fake-acp-agent.mjs");
const roots: string[] = [];
const servers: SessiondServer[] = [];
const clients: SessiondClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const line = (message: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;

async function host(root: string) {
  const socketPath = path.join(root, "control.sock");
  const server = new SessiondServer({ socketPath, statePath: path.join(root, "slots.json"), resumeDir: path.join(root, "resume") });
  servers.push(server);
  await server.start();
  const client = await SessiondClient.connect(socketPath);
  clients.push(client);
  const frames: Array<SupervisedBridgeFrame & { slot: number }> = [];
  const slots = new SupervisedSlots({
    client,
    copilotCmd: fakeAgent,
    localCwd: root,
    adapterChildPath: adapterChild,
    environment: {
      HOME: root,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_AGENT_PIDS: path.join(root, "agent.pids"),
    },
    onStderr: () => undefined,
    onFrame: (frame) => frames.push(frame),
  });
  return { server, client, slots, frames };
}

describe("#631 host restart mid-turn", () => {
  it("relaunches the slot, reloads the session and finishes the turn under its original id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-631r-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const first = await host(root);
    first.slots.configure(5, { agentId: "copilot", cwd: root, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY });
    await first.slots.writeInput(5, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await first.slots.writeInput(5, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => first.frames.find((f) => f.data?.includes("\"sessionId\":\"s1\"")), "session/new");
    await first.slots.armRecovery(5, { submissionId: "sub-5", acpSessionId: "s1", continuation: "continue" });
    await first.slots.writeInput(5, line({ id: 7, method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "long job" }] } }));
    await until(() => first.frames.find((f) => f.data?.includes("working on it")), "the turn to start");
    const record = path.join(root, "resume", "5.json");
    await until(() => existsSync(record) ? true : undefined, "the resume record");

    // Host shutdown: sessiond stops, then every remaining process is killed.
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    first.client.close();
    const state = JSON.parse(await fs.readFile(path.join(root, "slots.json"), "utf8")) as { slots: Array<{ identity: { pgid: number } }> };
    for (const slot of state.slots) try { process.kill(-slot.identity.pgid, "SIGKILL"); } catch { /* gone */ }
    for (const pid of (await fs.readFile(path.join(root, "agent.pids"), "utf8")).trim().split("\n")) {
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
    }
    expect(existsSync(record)).toBe(true);

    const second = await host(root);
    await second.slots.rebind();
    const replay = await second.slots.replay(5, 0);
    replay.activate();
    const seen = () => [...replay.result.frames, ...second.frames];
    const answer = await until(() => seen().find((f) => f.data?.includes("\"id\":7") && f.data.includes("end_turn")), "the original prompt's answer");
    expect(answer.data).toContain("\"id\":7");
    const result = await until(() => seen().find((f) => f.type === "recovery_result"), "the recovery result");
    expect(result.recoveryResult).toMatchObject({ submissionId: "sub-5", status: "completed" });
    expect(result.recoveryResult?.text).toContain("resumed ok");
    // The reload's history replay is not the controller's to see again.
    expect(seen().some((f) => f.data?.includes("replayed history"))).toBe(false);
    await until(() => existsSync(record) ? undefined : true, "the record to be cleared");
  }, 60_000);
});
