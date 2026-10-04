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
import { SessiondServer, readSessiondProcessIdentity } from "../packages/bridge/src/sessiond-server.js";
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

async function host(root: string, modeId?: string, options: { legacy?: boolean; loadGate?: string } = {}) {
  const bin = path.join(root, "bin");
  if (modeId) {
    await fs.mkdir(bin, { recursive: true });
    if (!existsSync(path.join(bin, "codex-acp"))) await fs.symlink(fakeAgent, path.join(bin, "codex-acp"));
  }
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
    adapterChildPath: options.legacy ? path.join(here, "helpers/adapter-child-legacy.mjs") : adapterChild,
    environment: {
      HOME: root,
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_AGENT_PIDS: path.join(root, "agent.pids"),
      ...(modeId ? { FAKE_AGENT_REQUIRE_MODE: modeId } : {}),
      ...(options.loadGate ? { FAKE_AGENT_LOAD_GATE: options.loadGate } : {}),
    },
    onStderr: () => undefined,
    onFrame: (frame) => frames.push(frame),
  });
  return { server, client, slots, frames };
}

describe("large prompts reach the agent", () => {
  it("delivers a 20 MB prompt (several full-size photos) through sessiond, the holder and adapter-child", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-big-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const one = await host(root);
    one.slots.configure(6, { agentId: "copilot", cwd: root });
    await one.slots.writeInput(6, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await one.slots.writeInput(6, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => one.frames.find((f) => f.data?.includes("\"sessionId\":\"s1\"")), "session/new");
    const image = { type: "image", mimeType: "image/jpeg", data: Buffer.alloc(15 * 1024 * 1024, 5).toString("base64") };
    const prompt = line({ id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [image, { type: "text", text: "long job" }] } });
    expect(prompt.length).toBeGreaterThan(20 * 1024 * 1024);
    const delivered = await one.slots.writeInput(6, prompt);
    expect(one.slots.undeliverableReason(6)).toBeUndefined();
    expect(delivered).toBe(true);
    await until(() => one.frames.find((f) => f.data?.includes("working on it")), "the agent to answer the large prompt", 60_000);
  }, 90_000);
});

describe("#777 the retained adapter child decides reconciliation", () => {
  it.each([false, true])("settles a never-submitted arm after bridge rebind; legacy=%s", async legacy => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-777-owner-"));
    roots.push(root);
    const first = await host(root, undefined, { legacy });
    first.slots.configure(8, { agentId: "copilot", cwd: root, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY });
    await first.slots.writeInput(8, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await first.slots.writeInput(8, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => first.frames.find(f => f.data?.includes('"sessionId":"s1"')), "session/new");
    const snapshot = await first.slots.armRecovery(8, { submissionId: "never-submitted", acpSessionId: "s1", continuation: "continue" });
    expect(snapshot.reconcileSupported).toBe(legacy ? undefined : true);
    const before = (await first.client.listSlots()).health.find(row => row.slot === 8)!;
    expect(before.resumePending).toBe(false);
    first.client.close();
    const client = await SessiondClient.connect(path.join(root, "control.sock"));
    clients.push(client);
    const frames: SupervisedBridgeFrame[] = [];
    const rebound = new SupervisedSlots({ client, copilotCmd: fakeAgent, localCwd: root,
      onFrame: frame => frames.push(frame), onStderr: () => undefined });
    await rebound.rebind();
    const replay = await rebound.replay(8, 0);
    replay.activate();
    const result = await rebound.reconcileRecovery(8, { submissionId: "never-submitted", acpSessionId: "s1" });
    if (legacy) expect(result).toMatchObject({ state: "missing", cause: expect.stringContaining("never received") });
    else {
      expect(result).toEqual({ state: "owned" });
      const terminal = await until(() => frames.find(frame => frame.recoveryResult), "owner failure result");
      expect(terminal.recoveryResult).toMatchObject({ status: "failed", stopReason: "prompt_not_received",
        error: expect.stringContaining("never received") });
    }
    const after = (await client.listSlots()).health.find(row => row.slot === 8)!;
    expect(after).toMatchObject({ pid: before.pid, alive: true, attached: true });
    expect(frames.some(frame => frame.type === "exit")).toBe(false);
    expect(frames.some(frame => frame.data?.includes("working on it"))).toBe(false);
  }, 20_000);

  it.each([false, true])("leaves executing work owned; legacy=%s", async legacy => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-777-running-"));
    roots.push(root);
    const one = await host(root, undefined, { legacy });
    one.slots.configure(8, { agentId: "copilot", cwd: root, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY });
    await one.slots.writeInput(8, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await one.slots.writeInput(8, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => one.frames.find(f => f.data?.includes('"sessionId":"s1"')), "session/new");
    await one.slots.armRecovery(8, { submissionId: "running", acpSessionId: "s1", continuation: "continue" });
    await one.slots.writeInput(8, line({ id: 7, method: "session/prompt", params: {
      sessionId: "s1", prompt: [{ type: "text", text: "long job" }],
    } }));
    await until(() => one.frames.find(f => f.data?.includes("working on it")), "prompt acceptance");
    const before = (await one.client.listSlots()).health.find(row => row.slot === 8)!;
    expect(before.resumePending).toBe(true);
    expect(await one.slots.reconcileRecovery(8, { submissionId: "running", acpSessionId: "s1" })).toEqual({ state: "owned" });
    expect((await one.client.listSlots()).health.find(row => row.slot === 8)?.pid).toBe(before.pid);
    expect(one.frames.some(frame => frame.recoveryResult)).toBe(false);
  }, 20_000);
});

describe("#631 host restart mid-turn", () => {
  it.each([
    { modeId: undefined, legacy: false },
    { modeId: "agent-full-access", legacy: false },
    { modeId: undefined, legacy: true },
  ])("reloads and continues under the original id: %j", async ({ modeId, legacy }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-631r-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const loadGate = path.join(root, "load.ready");
    const first = await host(root, modeId, { legacy, loadGate });
    first.slots.configure(5, { agentId: modeId ? "codex" : "copilot", cwd: root, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY });
    await first.slots.writeInput(5, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await first.slots.writeInput(5, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => first.frames.find((f) => f.data?.includes("\"sessionId\":\"s1\"")), "session/new");
    if (modeId) {
      await first.slots.writeInput(5, line({ id: 3, method: "session/set_mode", params: { sessionId: "s1", modeId } }));
      await until(() => first.frames.find(f => f.data?.includes('"id":3') && f.data.includes('"result"')), "the mode acknowledgement");
    }
    await first.slots.armRecovery(5, { submissionId: "sub-5", acpSessionId: "s1", continuation: "continue" });
    await first.slots.writeInput(5, line({ id: 7, method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "long job" }] } }));
    await until(() => first.frames.find((f) => f.data?.includes("working on it")), "the turn to start");
    const record = path.join(root, "resume", "5.json");
    await until(() => existsSync(record) ? true : undefined, "the resume record");
    const saved = JSON.parse(await fs.readFile(record, "utf8"));
    expect(JSON.parse(Buffer.from(saved.initialStdinBase64, "base64").toString()).resume.modeId).toBe(modeId);

    // Host shutdown: sessiond stops, then every remaining process is killed.
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    first.client.close();
    const state = JSON.parse(await fs.readFile(path.join(root, "slots.json"), "utf8")) as { slots: Array<{ identity: { pid: number; pgid: number } }> };
    for (const slot of state.slots) try { process.kill(-slot.identity.pgid, "SIGKILL"); } catch { /* gone */ }
    const agentPids = (await fs.readFile(path.join(root, "agent.pids"), "utf8")).trim().split("\n").map(Number);
    for (const pid of agentPids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    // A new host cannot still observe processes from the previous boot.
    await until(() => [...state.slots.map(slot => slot.identity.pid), ...agentPids]
      .every(pid => !readSessiondProcessIdentity(pid)) ? true : undefined, "shutdown to finish");
    expect(existsSync(record)).toBe(true);

    const second = await host(root, modeId, { legacy, loadGate });
    await second.slots.rebind();
    const replay = await second.slots.replay(5, 0);
    replay.activate();
    const seen = () => [...replay.result.frames, ...second.frames];
    expect((await second.client.listSlots()).health.find(row => row.slot === 5)?.resumePending).toBe(true);
    expect(await second.slots.reconcileRecovery(5, { submissionId: "sub-5", acpSessionId: "s1" })).toEqual({ state: "owned" });
    expect(seen().some(frame => frame.recoveryResult?.status === "failed")).toBe(false);
    await fs.writeFile(loadGate, "ready");
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
